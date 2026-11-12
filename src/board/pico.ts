import { CliError } from "../envelope.ts"
import { type BootselDrive, findBootselDrives } from "./bootsel.ts"
import {
  defaultDiscoverHost,
  type DiscoverHost,
  isEsp32Port,
  isMicroPythonEsp32Port,
  listSerialPorts
} from "./discover.ts"
import { defaultRawReplConfig, RawRepl, type RawReplConfig } from "./raw-repl.ts"
import type { SerialPort } from "./serial.ts"

/** Raspberry Pi's USB vendor ID. */
export const RPI_VENDOR_ID = "2e8a"
/** MicroPython's product ID on RP2 boards. */
export const MICROPYTHON_PRODUCT_ID = "0005"

/** A Pico or ESP32 board plugged into this machine. */
export type Board =
  | {
      /** Running MicroPython, reachable over serial. */
      state: "micropython"
      /** The serial port to open. */
      port: string
      /** The board's unique ID, as its USB serial number. */
      serialNumber?: string
      /** `esp32` for an ESP32-S3 running MicroPython; a Pico otherwise. */
      family?: "esp32"
    }
  | {
      /**
       * An ESP32 whose firmware its USB identity doesn't name: MicroPython, other firmware, or
       * its ROM bootloader.
       */
      state: "esp32"
      port: string
      serialNumber?: string
      /** USB vendor ID, four lowercase hex digits. */
      vendorId: string
      /** USB product ID, four lowercase hex digits. */
      productId: string
    }
  | {
      /** Waiting in BOOTSEL mode for a UF2 file. */
      state: "bootsel"
      /** Where its drive is mounted. */
      drive: string
      /** The drive's model line. */
      model?: string
    }

/**
 * Lists the Pico and ESP32 boards plugged in: Picos running MicroPython or in BOOTSEL mode, and
 * ESP32 boards. Never interrupts a running board.
 *
 * @param host - what to read; the real OS by default
 * @returns the boards, running ones first
 * @throws {CliError} when the OS can't be queried
 */
export async function listBoards(host: DiscoverHost = defaultDiscoverHost): Promise<Board[]> {
  const ports = await listSerialPorts(host)
  const serial = (p: { serialNumber?: string }): { serialNumber?: string } =>
    p.serialNumber === undefined ? {} : { serialNumber: p.serialNumber }
  const running: Board[] = ports.flatMap((p): Board[] => {
    if (p.vendorId === RPI_VENDOR_ID && p.productId === MICROPYTHON_PRODUCT_ID) {
      return [{ state: "micropython", port: p.path, ...serial(p) }]
    }
    if (isMicroPythonEsp32Port(p)) {
      return [{ state: "micropython", port: p.path, ...serial(p), family: "esp32" }]
    }
    if (isEsp32Port(p)) {
      return [
        { state: "esp32", port: p.path, ...serial(p), vendorId: p.vendorId, productId: p.productId }
      ]
    }
    return []
  })
  const waiting: Board[] = (await findBootselDrives(host)).map((d: BootselDrive) => ({
    state: "bootsel",
    drive: d.path,
    ...(d.model === undefined ? {} : { model: d.model })
  }))
  return [...running, ...waiting]
}

/** Runs one piece of work in the raw REPL and leaves it afterwards. */
async function withRepl<T>(
  port: SerialPort,
  config: RawReplConfig,
  work: (repl: RawRepl) => Promise<T>
): Promise<T> {
  const repl = new RawRepl(port, config)
  await repl.enter()
  try {
    return await work(repl)
  } finally {
    await repl.exit()
  }
}

/**
 * Runs code on a board and returns what it printed. Stops whatever the board was running.
 *
 * @param port - the board's open serial port
 * @param code - Python source
 * @param config - raw REPL timings
 * @returns the code's output
 * @throws {CliError} when the code raises, with the traceback's last line
 */
export async function runCode(
  port: SerialPort,
  code: string,
  config: RawReplConfig = defaultRawReplConfig
): Promise<string> {
  const { stdout, stderr } = await withRepl(port, config, async (repl) => repl.exec(code))
  if (stderr.trim() !== "") {
    const last = stderr.trim().split("\n").at(-1)?.trim() ?? stderr.trim()
    throw new CliError(`the board raised ${last}`, "error")
  }
  return stdout
}

/**
 * Asks a running board what it is, e.g. `Raspberry Pi Pico 2 W with RP2350`.
 *
 * @param port - the board's open serial port
 * @param config - raw REPL timings
 * @returns the board's own description
 * @throws {CliError} when the board doesn't answer
 */
export async function identify(
  port: SerialPort,
  config: RawReplConfig = defaultRawReplConfig
): Promise<string> {
  return (await runCode(port, "import sys\nprint(sys.implementation._machine)", config)).trim()
}

async function startAndLeave(port: SerialPort, code: string, config: RawReplConfig): Promise<void> {
  const repl = new RawRepl(port, config)
  await repl.enter()
  await repl.start(code)
}

/**
 * Restarts a running board, as pressing its reset button would. The serial port closes as the
 * board restarts.
 *
 * @param port - the board's open serial port
 * @param config - raw REPL timings
 * @throws {CliError} when the board doesn't answer
 */
export async function resetBoard(
  port: SerialPort,
  config: RawReplConfig = defaultRawReplConfig
): Promise<void> {
  await startAndLeave(port, "import machine\nmachine.reset()", config)
}

/**
 * Restarts a running board into BOOTSEL mode, where it mounts as a drive that takes a UF2 file.
 *
 * @param port - the board's open serial port
 * @param config - raw REPL timings
 * @throws {CliError} when the board doesn't answer
 */
export async function enterBootsel(
  port: SerialPort,
  config: RawReplConfig = defaultRawReplConfig
): Promise<void> {
  await startAndLeave(port, "import machine\nmachine.bootloader()", config)
}
