import { MICROPYTHON_PICO_2_W } from "../board/firmware.ts"
import {
  defaultFlashConfig,
  flashMicroPython,
  type FlashResult,
  pickBoard
} from "../board/flash.ts"
import { openSerial } from "../board/native.ts"
import { type Board, listBoards, resetBoard, runCode } from "../board/pico.ts"
import { defaultRawReplConfig, type RawReplConfig } from "../board/raw-repl.ts"
import type { SerialPort } from "../board/serial.ts"
import {
  probeBoard,
  type ProjectFile,
  type Setup,
  type SetupState,
  syncProject,
  type SyncResult
} from "../board/sync.ts"
import { CliError } from "../envelope.ts"
import { type LogPage, Taps } from "./taps.ts"

/** A board the core acted on. */
export type BoardRef = { port: string; serialNumber?: string }

/** What `probe` finds on a board. */
export type ProbeResult = SetupState & {
  /** The board is in BOOTSEL with no MicroPython yet. */
  blank: boolean
}

/** What a deploy did to one board. */
export type DeployResult = SyncResult & {
  board: BoardRef
  /** The MicroPython release flashed first, when the board was blank. */
  flashed?: string
}

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
  /** Reads a board's output after sequence number `after`, waiting up to `waitMs` for some. */
  logs: (
    serialNumber: string | undefined,
    after: number,
    waitMs: number,
    limit: number
  ) => Promise<LogPage>
  /** Types text into a board's console. */
  write: (serialNumber: string | undefined, data: string) => Promise<BoardRef>
  /**
   * Makes a board's files match a project and restarts it, flashing MicroPython first when the
   * board is blank.
   */
  deploy: (
    serialNumber: string | undefined,
    files: ProjectFile[],
    dryRun: boolean,
    setup?: Setup
  ) => Promise<DeployResult>
  /** What a board holds for joining the platform; a blank board holds nothing. */
  probe: (serialNumber: string | undefined) => Promise<ProbeResult>
  /** Releases every port the operations hold open. */
  close: () => Promise<void>
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
  /** How long one log read waits for bytes. */
  read_wait_ms: number
  /** How many output chunks each board's buffer keeps. */
  max_chunks: number
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
  const taps = new Taps({ ...deps, pick: pickRunning })
  return {
    list: deps.list,
    flash: async (serialNumber) => taps.hold(async () => deps.flash(serialNumber)),
    reset: async (serialNumber) =>
      taps.hold(async () => {
        const { board } = await withBoard(serialNumber, async (port) => resetBoard(port, deps.repl))
        return ref(await backRunning(deps, board))
      }),
    run: async (serialNumber, code) =>
      taps.hold(async () => {
        const { board, result } = await withBoard(serialNumber, async (port) =>
          runCode(port, code, deps.repl)
        )
        return { board: ref(board), output: result }
      }),
    probe: async (serialNumber) =>
      taps.hold(async () => {
        const target = pickBoard(await deps.list(), serialNumber)
        if (target.state === "bootsel") {
          return { blank: true, credential: false, claimCode: false }
        }
        const { result } = await withBoard(serialNumber, async (port) =>
          probeBoard(port, deps.repl)
        )
        return { blank: false, ...result }
      }),
    deploy: async (serialNumber, files, dryRun, setup) =>
      taps.hold(async () => {
        let flashed: string | undefined
        const target = pickBoard(await deps.list(), serialNumber)
        if (target.state === "bootsel") {
          if (dryRun) {
            // A blank board would be flashed, then get every file.
            const written = files.map((f) => f.path)
            const { version } = MICROPYTHON_PICO_2_W
            return {
              board: { port: target.drive },
              written,
              removed: [],
              unchanged: 0,
              flashed: version
            }
          }
          flashed = (await deps.flash(serialNumber)).version
        }
        const { board, result } = await withBoard(serialNumber, async (port) =>
          syncProject(port, files, dryRun, deps.repl, setup)
        )
        return { board: ref(board), ...result, ...(flashed === undefined ? {} : { flashed }) }
      }),
    logs: async (serialNumber, after, waitMs, limit) =>
      taps.logs(serialNumber, after, waitMs, limit),
    write: async (serialNumber, data) => taps.write(serialNumber, data),
    close: async () => taps.close()
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
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    read_wait_ms: 100,
    max_chunks: 5000
  })
}
