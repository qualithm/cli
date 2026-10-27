import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { CliError } from "../envelope.ts"
import {
  defaultFirmwareConfig,
  type Firmware,
  type FirmwareConfig,
  loadFirmware,
  MICROPYTHON_PICO_2_W
} from "./firmware.ts"
import { type Board, enterBootsel, listBoards, runCode } from "./pico.ts"
import { defaultRawReplConfig, type RawReplConfig } from "./raw-repl.ts"
import type { SerialPort } from "./serial.ts"

/** What flashing reaches for; the real machine by default. */
export type FlashConfig = {
  /** Lists the boards plugged in. */
  list: () => Promise<Board[]>
  open: (path: string) => Promise<SerialPort>
  /** Writes the UF2 file onto a BOOTSEL drive. */
  copy: (drive: string, bytes: Uint8Array) => Promise<void>
  firmware: FirmwareConfig
  repl: RawReplConfig
  /** How long a board may take to show up as a drive, or back as a serial port. */
  appear_timeout_ms: number
  poll_ms: number
  sleep: (ms: number) => Promise<void>
}

/** What a flash left on the board. */
export type FlashResult = {
  /** The serial port the board came back on. */
  port: string
  serialNumber?: string
  /** The MicroPython release now running, as the board reports it. */
  version: string
  /** The board's own description. */
  machine: string
}

const UF2_NAME = "MICROPYTHON.UF2"

type Running = Extract<Board, { state: "micropython" }>

/**
 * Copies a UF2 file onto a BOOTSEL drive. The board restarts as soon as it has the whole file,
 * so the drive can vanish before the copy returns; that counts as success.
 *
 * @param drive - where the drive is mounted
 * @param bytes - the UF2 file
 * @throws {CliError} when the copy fails while the drive is still there
 */
export async function copyToDrive(drive: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(join(drive, UF2_NAME), bytes)
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code === "EIO" || code === "ENOENT" || code === "ENXIO") {
      return
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(`copy MicroPython onto ${drive}: ${reason}`, "error")
  }
}

async function waitFor<T>(
  config: FlashConfig,
  late: string,
  find: (boards: Board[]) => T | undefined
): Promise<T> {
  const deadline = Date.now() + config.appear_timeout_ms
  for (;;) {
    const found = find(await config.list())
    if (found !== undefined) {
      return found
    }
    if (Date.now() >= deadline) {
      throw new CliError(late, "unavailable")
    }
    await config.sleep(config.poll_ms)
  }
}

function pick(boards: Board[], serialNumber: string | undefined): Board {
  if (serialNumber !== undefined) {
    const wanted = serialNumber.toLowerCase()
    const board = boards.find(
      (b) => b.state === "micropython" && b.serialNumber?.toLowerCase() === wanted
    )
    if (board === undefined) {
      throw new CliError(`no board with serial number ${serialNumber} is plugged in`, "not_found")
    }
    return board
  }
  const [only, ...others] = boards
  if (only === undefined) {
    throw new CliError(
      "no board found: plug in a Pico 2 W, holding BOOTSEL if it has never been flashed",
      "not_found"
    )
  }
  if (others.length > 0) {
    throw new CliError(
      `${String(boards.length)} boards are plugged in: name one by its serial number`,
      "usage"
    )
  }
  return only
}

async function withPort<T>(
  config: FlashConfig,
  path: string,
  work: (port: SerialPort) => Promise<T>
): Promise<T> {
  // A board that has just restarted can refuse the first open for a moment.
  const deadline = Date.now() + config.appear_timeout_ms
  let port: SerialPort
  for (;;) {
    try {
      port = await config.open(path)
      break
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }
      await config.sleep(config.poll_ms)
    }
  }
  try {
    return await work(port)
  } finally {
    await port.close()
  }
}

/**
 * Puts MicroPython on a Pico 2 W and checks it came back running that release. A running board
 * is restarted into BOOTSEL first; a blank one must already be in BOOTSEL.
 *
 * @param config - what to reach for
 * @param serialNumber - which board, when more than one is plugged in
 * @param firmware - the build to flash
 * @returns the port, release and description the board came back with
 * @throws {CliError} when no single board is found, the download fails, or the board doesn't
 *   come back running the release
 */
export async function flashMicroPython(
  config: FlashConfig,
  serialNumber?: string,
  firmware: Firmware = MICROPYTHON_PICO_2_W
): Promise<FlashResult> {
  // Fetch first, so a failed download never leaves a board waiting in BOOTSEL.
  const bytes = await loadFirmware(firmware, config.firmware)
  const board = pick(await config.list(), serialNumber)
  let drive: string
  let serial: string | undefined
  if (board.state === "micropython") {
    serial = board.serialNumber
    await withPort(config, board.port, async (port) => enterBootsel(port, config.repl))
    // On macOS the drive can fail to mount until the board is plugged in again.
    const late =
      "the board restarted into BOOTSEL but no drive appeared: unplug it, plug it back in, and flash again"
    drive = await waitFor(config, late, (boards) => {
      const found = boards.find((b) => b.state === "bootsel")
      return found?.state === "bootsel" ? found.drive : undefined
    })
  } else {
    ;({ drive } = board)
  }
  await config.copy(drive, bytes)
  const back = await waitFor(
    config,
    "the board didn't restart running MicroPython in time",
    (boards) =>
      boards.find(
        (b): b is Running =>
          b.state === "micropython" &&
          (serial === undefined || b.serialNumber?.toLowerCase() === serial.toLowerCase())
      )
  )
  const reply = await withPort(config, back.port, async (port) =>
    runCode(port, "import os\nu = os.uname()\nprint(u.release)\nprint(u.machine)", config.repl)
  )
  const [version = "", machine = ""] = reply.trim().split(/\r?\n/)
  if (version !== firmware.version) {
    throw new CliError(
      `the board runs MicroPython ${version} after flashing, not ${firmware.version}`,
      "error"
    )
  }
  return {
    port: back.port,
    ...(back.serialNumber === undefined ? {} : { serialNumber: back.serialNumber }),
    version,
    machine: machine.trim()
  }
}

/**
 * The real machine's flash settings, opening ports with `open`.
 *
 * @param open - opens a serial port
 * @returns the settings
 */
export function defaultFlashConfig(open: (path: string) => Promise<SerialPort>): FlashConfig {
  return {
    list: async () => listBoards(),
    open,
    copy: copyToDrive,
    firmware: defaultFirmwareConfig,
    repl: defaultRawReplConfig,
    appear_timeout_ms: 30000,
    poll_ms: 250,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}
