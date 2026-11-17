import { ESPRESSIF_VENDOR_ID, sameSerial } from "../board/discover.ts"
import { MICROPYTHON_ESP32_VERSION } from "../board/esp32.ts"
import { MICROPYTHON_PICO_2_W } from "../board/firmware.ts"
import {
  defaultFlashConfig,
  flashMicroPython,
  type FlashResult,
  isEsp32,
  pickBoard
} from "../board/flash.ts"
import { openSerial } from "../board/native.ts"
import { type Board, listBoards, resetBoard, runCode } from "../board/pico.ts"
import { defaultRawReplConfig, type RawReplConfig } from "../board/raw-repl.ts"
import { loadSdk } from "../board/sdk.ts"
import { type ControlSerialPort, PortClosedError, type SerialPort } from "../board/serial.ts"
import {
  probeBoard,
  type ProjectFile,
  type Setup,
  type SetupState,
  syncProject,
  type SyncResult
} from "../board/sync.ts"
import { CliError } from "../envelope.ts"
import { type LogPage, released, Taps } from "./taps.ts"

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
   * Makes a board's files match a project plus the device SDK and restarts it, flashing MicroPython first when the
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
  /**
   * Closes a board's port once any verb on it has finished, and leaves it closed until
   * `reconnect`, so another program can use the board.
   */
  release: (serialNumber: string) => Promise<Released>
  /** Lets the core use a released board's port again. */
  reconnect: (serialNumber: string) => Promise<Released>
  /** Releases every port the operations hold open. */
  close: () => Promise<void>
}

/** The board a `release` or `reconnect` named. */
export type Released = { serialNumber: string }

/** What the board operations reach for. */
export type BoardDeps = {
  list: () => Promise<Board[]>
  open: (path: string) => Promise<SerialPort | ControlSerialPort>
  flash: (serialNumber?: string) => Promise<FlashResult>
  repl: RawReplConfig
  /** How long a reset board may take to come back running. */
  appear_timeout_ms: number
  poll_ms: number
  sleep: (ms: number) => Promise<void>
  /** How long one log read waits for bytes. */
  read_wait_ms: number
  /** How long an ESP32 restarting on its bridge's port stays quiet once it has booted. */
  boot_quiet_ms: number
  /** The longest an ESP32's port stays open after a reset, waiting for it to boot. */
  boot_timeout_ms: number
  /** How many output chunks each board's buffer keeps. */
  max_chunks: number
  /** The device SDK files every deploy puts beside the project. */
  sdk: () => Promise<ProjectFile[]>
}

/** A board that runs MicroPython, or an ESP32 that may: a verb finds out when it talks to it. */
type Running = Extract<Board, { state: "micropython" | "esp32" }>

/**
 * Picks the running board a verb acts on: the one with `serialNumber`, or the only one. An ESP32
 * counts, since its USB identity doesn't say whether it runs MicroPython.
 *
 * @param boards - the boards plugged in
 * @param serialNumber - which board, when more than one is plugged in
 * @returns the board
 * @throws {CliError} when no running board matches, or several do and none is named
 */
export function pickRunning(boards: Board[], serialNumber?: string): Running {
  const running = boards.filter((b): b is Running => b.state !== "bootsel")
  if (serialNumber !== undefined) {
    const board = running.find(
      (b) => b.serialNumber !== undefined && sameSerial(b.serialNumber, serialNumber)
    )
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
        : "no board found: plug in an ESP32, or a Pico 2 W running MicroPython",
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
  if (b.state === "bootsel") {
    return false
  }
  return a.serialNumber === undefined || b.serialNumber === undefined
    ? b.port === a.port
    : sameSerial(a.serialNumber, b.serialNumber)
}

async function backRunning(deps: BoardDeps, board: Running): Promise<Running> {
  if (board.state === "esp32") {
    // Its USB-serial bridge or USB JTAG stays on USB while the chip restarts, and the reset
    // already read the chip's boot to the end.
    return board
  }
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
      // A board still on USB at the deadline never left it, so it never restarted.
      throw new CliError(
        gone
          ? "the board didn't come back running MicroPython in time"
          : "the board didn't restart: it never left USB",
        "unavailable"
      )
    }
    await deps.sleep(deps.poll_ms)
  }
}

/**
 * Reads an ESP32's port until the chip has booted after a reset: until it has printed something
 * and then gone quiet, or for at most `boot_timeout_ms`. An ESP32-C6 on its USB JTAG halts in
 * its ROM when the port closes while it boots.
 *
 * @param port - the board's open port
 * @param deps - the timings
 */
async function awaitBoot(port: SerialPort, deps: BoardDeps): Promise<void> {
  const deadline = Date.now() + deps.boot_timeout_ms
  let heard = false
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    let bytes: Uint8Array
    try {
      bytes = await port.read(deps.read_wait_ms)
    } catch (error) {
      if (error instanceof PortClosedError) {
        return
      }
      throw error
    }
    if (bytes.length > 0) {
      heard = true
      quietSince = Date.now()
    } else if (heard && Date.now() - quietSince >= deps.boot_quiet_ms) {
      return
    }
  }
}

/**
 * Board operations over `deps`.
 *
 * @param deps - what to reach for
 * @returns the operations
 */
export function boardOps(deps: BoardDeps): BoardOps {
  const open = async (board: Running): Promise<SerialPort> => {
    const port = await deps.open(board.port)
    // An ESP32's USB-serial bridge or USB JTAG wires DTR and RTS to the chip's EN and boot pins,
    // and macOS can open the port with EN held low, so the chip sits halted in its ROM.
    if (board.state === "esp32" && "setSignals" in port) {
      if (board.vendorId === ESPRESSIF_VENDOR_ID) {
        await port.setSignals({ dtr: false, rts: false })
      } else {
        // A bridge drives DTR before RTS. Dropping both at once passes through RTS high with DTR
        // low, which pulls EN low and restarts the chip; releasing RTS first never does
        // (qualithm/pm#3667). The port then closes with both low, so closing changes nothing.
        await port.setSignals({ rts: false })
        await port.setSignals({ dtr: false })
      }
    }
    return port
  }
  const taps = new Taps({ ...deps, open, pick: pickRunning })
  // A board whose port was released is another program's until it's reconnected.
  const refuse = (board: Board): void => {
    if (board.serialNumber !== undefined && taps.isReleased(board.serialNumber)) {
      throw released(board.serialNumber)
    }
  }
  const withBoard = async <T>(
    serialNumber: string | undefined,
    work: (port: SerialPort, board: Running) => Promise<T>
  ): Promise<{ board: Running; result: T }> => {
    const board = pickRunning(await deps.list(), serialNumber)
    refuse(board)
    const port = await open(board)
    try {
      return { board, result: await work(port, board) }
    } finally {
      await port.close()
    }
  }
  // An ESP32's USB identity doesn't say what it runs; a Pico running MicroPython says so itself.
  const runsMicroPython = async (board: Board): Promise<boolean> => {
    if (board.state !== "esp32") {
      return true
    }
    try {
      const { result } = await withBoard(board.serialNumber, async (port) =>
        runCode(port, "import os\nprint(os.uname().release)", deps.repl)
      )
      return result.trim() === MICROPYTHON_ESP32_VERSION
    } catch (error) {
      if (error instanceof CliError) {
        return false
      }
      throw error
    }
  }
  return {
    list: deps.list,
    flash: async (serialNumber) =>
      taps.hold(async () => {
        refuse(pickBoard(await deps.list(), serialNumber))
        return deps.flash(serialNumber)
      }),
    reset: async (serialNumber) =>
      taps.hold(async () => {
        const { board } = await withBoard(serialNumber, async (port, target) => {
          await resetBoard(port, deps.repl)
          if (target.state === "esp32") {
            await awaitBoot(port, deps)
          }
        })
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
        refuse(target)
        if (target.state === "bootsel" || !(await runsMicroPython(target))) {
          return { blank: true, credential: false, claimCode: false }
        }
        const { result } = await withBoard(serialNumber, async (port) =>
          probeBoard(port, deps.repl)
        )
        return { blank: false, ...result }
      }),
    deploy: async (serialNumber, project, dryRun, setup) =>
      taps.hold(async () => {
        const files = [...project, ...(await deps.sdk())]
        let flashed: string | undefined
        const target = pickBoard(await deps.list(), serialNumber)
        refuse(target)
        if (target.state === "bootsel" || !(await runsMicroPython(target))) {
          if (dryRun) {
            // A blank board would be flashed, then get every file.
            const written = files.map((f) => f.path)
            const version = isEsp32(target)
              ? MICROPYTHON_ESP32_VERSION
              : MICROPYTHON_PICO_2_W.version
            const at = target.state === "bootsel" ? { port: target.drive } : ref(target)
            return { board: at, written, removed: [], unchanged: 0, flashed: version }
          }
          const flash = await deps.flash(serialNumber)
          flashed = flash.version
          // A deploy that named no board took the only blank one; it now has an ID to name.
          serialNumber ??= flash.serialNumber
        }
        const { board, result } = await withBoard(serialNumber, async (port) =>
          syncProject(port, files, dryRun, deps.repl, setup)
        )
        return { board: ref(board), ...result, ...(flashed === undefined ? {} : { flashed }) }
      }),
    logs: async (serialNumber, after, waitMs, limit) =>
      taps.logs(serialNumber, after, waitMs, limit),
    write: async (serialNumber, data) => taps.write(serialNumber, data),
    release: async (serialNumber) => {
      // A board already given away may be in the other program's hands, off this computer's USB.
      if (!taps.isReleased(serialNumber)) {
        pickBoard(await deps.list(), serialNumber)
      }
      await taps.release(serialNumber)
      return { serialNumber }
    },
    reconnect: async (serialNumber) => {
      taps.reconnect(serialNumber)
      return Promise.resolve({ serialNumber })
    },
    close: async () => taps.close()
  }
}

/** The real machine's board operations. */
export function defaultBoardOps(): BoardOps {
  const open = async (path: string): Promise<ControlSerialPort> => openSerial(path)
  return boardOps({
    list: async () => listBoards(),
    open,
    flash: async (serialNumber) => flashMicroPython(defaultFlashConfig(open), serialNumber),
    repl: defaultRawReplConfig,
    appear_timeout_ms: 30000,
    poll_ms: 250,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    read_wait_ms: 100,
    boot_quiet_ms: 1000,
    boot_timeout_ms: 5000,
    max_chunks: 5000,
    sdk: async () => loadSdk()
  })
}
