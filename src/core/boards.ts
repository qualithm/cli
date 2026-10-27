import { defaultFlashConfig, flashMicroPython, type FlashResult } from "../board/flash.ts"
import { openSerial } from "../board/native.ts"
import { type Board, listBoards, resetBoard, runCode } from "../board/pico.ts"
import { defaultRawReplConfig, type RawReplConfig } from "../board/raw-repl.ts"
import type { SerialPort } from "../board/serial.ts"
import { CliError } from "../envelope.ts"

/** A board the core acted on. */
export type BoardRef = { port: string; serialNumber?: string }

/** What the core does with boards; the real machine by default, fakes in tests. */
export type BoardOps = {
  list: () => Promise<Board[]>
  flash: (serialNumber?: string) => Promise<FlashResult>
  /** Restarts a board and resolves once it is back running. */
  reset: (serialNumber?: string) => Promise<BoardRef>
  /** Runs Python on a board and returns what it printed. */
  run: (
    serialNumber: string | undefined,
    code: string
  ) => Promise<{ board: BoardRef; output: string }>
}

/** What the board operations reach for. */
export type BoardDeps = {
  list: () => Promise<Board[]>
  open: (path: string) => Promise<SerialPort>
  flash: (serialNumber?: string) => Promise<FlashResult>
  repl: RawReplConfig
  /** How long a reset board may take to come back running. */
  appear_timeout_ms: number
  poll_ms: number
  sleep: (ms: number) => Promise<void>
}

type Running = Extract<Board, { state: "micropython" }>

/**
 * Picks the running board a verb acts on: the one with `serialNumber`, or the only one.
 *
 * @param boards - the boards plugged in
 * @param serialNumber - which board, when more than one is plugged in
 * @returns the board
 * @throws {CliError} when no running board matches, or several do and none is named
 */
export function pickRunning(boards: Board[], serialNumber?: string): Running {
  const running = boards.filter((b): b is Running => b.state === "micropython")
  if (serialNumber !== undefined) {
    const wanted = serialNumber.toLowerCase()
    const board = running.find((b) => b.serialNumber?.toLowerCase() === wanted)
    if (board === undefined) {
      throw new CliError(`no running board with serial number ${serialNumber}`, "not_found")
    }
    return board
  }
  const [only, ...others] = running
  if (only === undefined) {
    const waiting = boards.some((b) => b.state === "bootsel")
    throw new CliError(
      waiting
        ? "the board is in BOOTSEL and runs nothing yet: flash it first"
        : "no board found: plug in a Pico 2 W running MicroPython",
      "not_found"
    )
  }
  if (others.length > 0) {
    throw new CliError(
      `${String(running.length)} boards are running: name one by its serial number`,
      "usage"
    )
  }
  return only
}

function ref(board: Running): BoardRef {
  return {
    port: board.port,
    ...(board.serialNumber === undefined ? {} : { serialNumber: board.serialNumber })
  }
}

function same(a: Running, b: Board): b is Running {
  if (b.state !== "micropython") {
    return false
  }
  return a.serialNumber === undefined
    ? b.port === a.port
    : b.serialNumber?.toLowerCase() === a.serialNumber.toLowerCase()
}

async function backRunning(deps: BoardDeps, board: Running): Promise<Running> {
  // The board drops off USB as it restarts; wait for it to leave, then to return.
  const deadline = Date.now() + deps.appear_timeout_ms
  let gone = false
  for (;;) {
    const found = (await deps.list()).find((b) => same(board, b))
    if (found === undefined) {
      gone = true
    } else if (gone) {
      return found
    }
    if (Date.now() >= deadline) {
      if (found !== undefined) {
        return found
      }
      throw new CliError("the board didn't come back running MicroPython in time", "unavailable")
    }
    await deps.sleep(deps.poll_ms)
  }
}

/**
 * Board operations over `deps`.
 *
 * @param deps - what to reach for
 * @returns the operations
 */
export function boardOps(deps: BoardDeps): BoardOps {
  const withBoard = async <T>(
    serialNumber: string | undefined,
    work: (port: SerialPort) => Promise<T>
  ): Promise<{ board: Running; result: T }> => {
    const board = pickRunning(await deps.list(), serialNumber)
    const port = await deps.open(board.port)
    try {
      return { board, result: await work(port) }
    } finally {
      await port.close()
    }
  }
  return {
    list: deps.list,
    flash: deps.flash,
    reset: async (serialNumber) => {
      const { board } = await withBoard(serialNumber, async (port) => resetBoard(port, deps.repl))
      return ref(await backRunning(deps, board))
    },
    run: async (serialNumber, code) => {
      const { board, result } = await withBoard(serialNumber, async (port) =>
        runCode(port, code, deps.repl)
      )
      return { board: ref(board), output: result }
    }
  }
}

/** The real machine's board operations. */
export function defaultBoardOps(): BoardOps {
  const open = async (path: string): Promise<SerialPort> => openSerial(path)
  return boardOps({
    list: async () => listBoards(),
    open,
    flash: async (serialNumber) => flashMicroPython(defaultFlashConfig(open), serialNumber),
    repl: defaultRawReplConfig,
    appear_timeout_ms: 30000,
    poll_ms: 250,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  })
}
