import { createHash } from "node:crypto"

import { ESPLoader, Transport } from "esptool-js"

import { CliError } from "../envelope.ts"
import { sameSerial } from "./discover.ts"
import { defaultFirmwareConfig, type FirmwareConfig, loadPinned } from "./firmware.ts"
import type { FlashResult } from "./flash.ts"
import { type Board, enterBootsel, runCode } from "./pico.ts"
import { defaultRawReplConfig, type RawReplConfig } from "./raw-repl.ts"
import type { ControlSerialPort } from "./serial.ts"
import { type WebSerialInfo, WebSerialPort } from "./webserial.ts"

/** The ESP32 chips deploy flashes, as esptool names them. */
export type Esp32Chip = "ESP32-S3" | "ESP32-C3" | "ESP32-C6"

/** A MicroPython build for one ESP32 chip, pinned by its checksum. */
export type Esp32Firmware = {
  chip: Esp32Chip
  /** The release, as `os.uname().release` reports it on the board. */
  version: string
  url: string
  /** The file's SHA-256, lowercase hex. */
  sha256: string
  /** The chip ID the image header names. */
  imageChipId: number
  /** The device SDK release a Qualithm build has frozen in; stock MicroPython has none. */
  frozenSdk?: string
}

const MICROPYTHON = "https://micropython.org/resources/firmware"
const QUALITHM_FIRMWARE = "https://github.com/qualithm/micropython-firmware/releases/download"

/** The MicroPython release deploy puts on every ESP32 chip. */
export const MICROPYTHON_ESP32_VERSION = "1.29.0"

/**
 * MicroPython 1.29.0 for each ESP32 chip, flashed whole at address 0. The C3 gets Qualithm's
 * build with the device SDK frozen in: stock MicroPython can't hold the SDK and a TLS handshake
 * in the C3's memory at once (qualithm/pm#3670).
 */
export const MICROPYTHON_ESP32: Readonly<Record<Esp32Chip, Esp32Firmware>> = {
  "ESP32-S3": {
    chip: "ESP32-S3",
    version: MICROPYTHON_ESP32_VERSION,
    url: `${MICROPYTHON}/ESP32_GENERIC_S3-20260824-v1.29.0.bin`,
    sha256: "1dd9dcd27ba2d6a1cb7f7b49a063f46d3d807d68b0151161233920228285e300",
    imageChipId: 9
  },
  "ESP32-C3": {
    chip: "ESP32-C3",
    version: MICROPYTHON_ESP32_VERSION,
    url: `${QUALITHM_FIRMWARE}/0.1.1/micropython-firmware-0.1.1-esp32c3-unsigned.bin`,
    sha256: "8705d118ce1bcc78c98c00353be688e2de32fc8063b77308716eb3c19367099a",
    imageChipId: 5,
    frozenSdk: "0.9.3"
  },
  "ESP32-C6": {
    chip: "ESP32-C6",
    version: MICROPYTHON_ESP32_VERSION,
    url: `${MICROPYTHON}/ESP32_GENERIC_C6-20260824-v1.29.0.bin`,
    sha256: "3688ba4e2c3949e639f5772e99fdb0efa1258b162a496133f78c108434195c89",
    imageChipId: 13
  }
}

const IMAGE_MAGIC = 0xe9
const IMAGE_CHIP_ID_OFFSET = 12

/**
 * Checks that bytes are an ESP application image built for a chip.
 *
 * @param bytes - the image
 * @param chipId - the chip ID its header must name
 * @throws {CliError} when it isn't an image, or is for another chip
 */
export function checkEspImage(bytes: Uint8Array, chipId: number): void {
  if (bytes.length < IMAGE_CHIP_ID_OFFSET + 2 || bytes[0] !== IMAGE_MAGIC) {
    throw new CliError("the firmware isn't an ESP32 image", "error")
  }
  const found = new DataView(bytes.buffer, bytes.byteOffset).getUint16(IMAGE_CHIP_ID_OFFSET, true)
  if (found !== chipId) {
    throw new CliError(
      `the firmware is for another chip: its header names chip ${String(found)}`,
      "error"
    )
  }
}

/**
 * Returns an ESP32 firmware file's bytes, from the cache or by downloading it, checked against
 * the pinned checksum and as an image for its chip.
 *
 * @param firmware - the build
 * @param config - cache folder and download
 * @returns the verified bytes
 * @throws {CliError} when the download fails or doesn't match
 */
export async function loadEsp32Firmware(
  firmware: Esp32Firmware,
  config: FirmwareConfig = defaultFirmwareConfig
): Promise<Uint8Array> {
  const pinned = {
    label: `MicroPython ${firmware.version} for the ${firmware.chip}`,
    url: firmware.url,
    sha256: firmware.sha256,
    ext: ".bin"
  }
  return loadPinned(pinned, config, (bytes) => {
    checkEspImage(bytes, firmware.imageChipId)
  })
}

/** An ESP32's ROM bootloader, reached over its serial port. */
export type RomLoader = {
  /**
   * Resets the chip into its ROM and identifies it.
   *
   * @returns the chip's name, e.g. `ESP32-C3`
   */
  connect: () => Promise<string>
  /** Erases the flash and writes an image at address 0, verifying it. */
  write: (image: Uint8Array) => Promise<void>
  /** Restarts the chip into what it now holds. */
  restart: () => Promise<void>
  /** Lets go of the port. */
  close: () => Promise<void>
}

// The S3 keeps a latch forcing download mode after MicroPython's machine.bootloader(), which a
// chip reset keeps; esptool clears it before restarting.
const S3_OPTION1_REG = 0x6000812c
const S3_FORCE_DOWNLOAD_BOOT = 0x1
// esptool-js's own hard reset only drops RTS; raise it first to pull EN low, as esptool does.
const RESTART = "D0|R1|W100|R0"
const FLASH_BAUD = 921600
const ROM_BAUD = 115200

/**
 * The ROM bootloader through esptool-js.
 *
 * @param port - the board's open port
 * @param info - its USB identity, which picks the reset esptool-js uses
 * @returns the loader
 */
export function esptoolRom(port: ControlSerialPort, info: WebSerialInfo): RomLoader {
  const web = new WebSerialPort(port, info)
  // esptool-js types its port as the browser's; the shim is the part of it esptool-js uses.
  const transport = new Transport(web)
  const silent = { clean: () => undefined, writeLine: () => undefined, write: () => undefined }
  const loader = new ESPLoader({
    transport,
    baudrate: FLASH_BAUD,
    romBaudrate: ROM_BAUD,
    terminal: silent
  })
  return {
    connect: async () => {
      await loader.main()
      return loader.chip.CHIP_NAME
    },
    write: async (image) =>
      loader.writeFlash({
        fileArray: [{ data: image, address: 0 }],
        flashMode: "keep",
        flashFreq: "keep",
        flashSize: "keep",
        eraseAll: true,
        compress: true,
        calculateMD5Hash: (bytes) => createHash("md5").update(bytes).digest("hex")
      }),
    restart: async () => {
      if (loader.chip.CHIP_NAME === "ESP32-S3") {
        await loader.writeReg(S3_OPTION1_REG, 0, S3_FORCE_DOWNLOAD_BOOT)
      }
      await loader.after("custom_reset", false, RESTART)
    },
    close: async () => transport.disconnect()
  }
}

/** What flashing an ESP32 reaches for; the real machine by default. */
export type Esp32FlashConfig = {
  list: () => Promise<Board[]>
  open: (path: string) => Promise<ControlSerialPort>
  rom: (port: ControlSerialPort, info: WebSerialInfo) => RomLoader
  /** The build for each chip, by the name the ROM gives. */
  builds: Readonly<Record<string, Esp32Firmware>>
  firmware: FirmwareConfig
  repl: RawReplConfig
  /** How long a board may take to come back on USB. */
  appear_timeout_ms: number
  poll_ms: number
  sleep: (ms: number) => Promise<void>
}

/** An ESP32 board as `listBoards` reports it: its firmware unknown, or running MicroPython. */
export type Esp32Board =
  | Extract<Board, { state: "esp32" }>
  | (Extract<Board, { state: "micropython" }> & { family: "esp32" })

const vid = (hex: string | undefined): number | undefined =>
  hex === undefined ? undefined : Number.parseInt(hex, 16)

function matches(board: Esp32Board, other: Board): boolean {
  if (other.state === "bootsel") {
    return false
  }
  if (board.serialNumber !== undefined && other.serialNumber !== undefined) {
    return sameSerial(board.serialNumber, other.serialNumber)
  }
  return other.port === board.port
}

async function waitFor<T>(
  config: Esp32FlashConfig,
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

async function withPort<T>(
  config: Esp32FlashConfig,
  path: string,
  work: (port: ControlSerialPort) => Promise<T>
): Promise<T> {
  // A board that has just restarted can refuse the first open for a moment.
  const deadline = Date.now() + config.appear_timeout_ms
  let port: ControlSerialPort
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

const UNAME = "import os\nu = os.uname()\nprint(u.release)\nprint(u.machine)"

/**
 * Asks a just-flashed board what it runs. A board behind a USB bridge stays on USB through the
 * restart, and MicroPython's first boot formats its filesystem before the REPL answers, so this
 * asks until the board answers or the wait runs out.
 */
async function answer(config: Esp32FlashConfig, path: string): Promise<string> {
  const deadline = Date.now() + config.appear_timeout_ms
  for (;;) {
    try {
      return await withPort(config, path, async (port) => runCode(port, UNAME, config.repl))
    } catch (error) {
      if (!(error instanceof CliError) || Date.now() >= deadline) {
        throw error
      }
      await config.sleep(config.poll_ms)
    }
  }
}

/**
 * Puts MicroPython on an ESP32-S3, C3 or C6 and checks it came back running that release.
 * Erases the whole flash, so the board's files go too.
 *
 * @param config - what to reach for
 * @param board - the board
 * @returns the port, release and description the board came back with
 * @throws {CliError} when the chip isn't one deploy supports, the download or write fails, or
 *   the board doesn't come back running the release
 */
export async function flashEsp32(
  config: Esp32FlashConfig,
  board: Esp32Board
): Promise<FlashResult> {
  let target: Esp32Board = board
  if (board.state === "micropython") {
    // MicroPython's own USB port can't reset the chip, so ask MicroPython for the ROM.
    await withPort(config, board.port, async (port) => enterBootsel(port, config.repl))
    target = await waitFor(
      config,
      "the board didn't restart into its bootloader in time",
      (boards) =>
        boards.find(
          (b): b is Extract<Board, { state: "esp32" }> => b.state === "esp32" && matches(board, b)
        )
    )
  }
  const info: WebSerialInfo = {}
  if (target.state === "esp32") {
    const usbVendorId = vid(target.vendorId)
    const usbProductId = vid(target.productId)
    Object.assign(
      info,
      usbVendorId === undefined ? {} : { usbVendorId },
      usbProductId === undefined ? {} : { usbProductId }
    )
  }
  const firmware = await withPort(config, target.port, async (port) => {
    const rom = config.rom(port, info)
    try {
      const chip = await rom.connect()
      const build = config.builds[chip]
      if (build === undefined) {
        await rom.restart()
        throw new CliError(
          `the board is an ${chip}: plug in an ESP32-S3, ESP32-C3 or ESP32-C6`,
          "usage"
        )
      }
      let image: Uint8Array
      try {
        image = await loadEsp32Firmware(build, config.firmware)
      } catch (error) {
        await rom.restart()
        throw error
      }
      await rom.write(image)
      await rom.restart()
      return build
    } finally {
      await rom.close()
    }
  })
  const back = await waitFor(
    config,
    "the board didn't restart running MicroPython in time",
    (boards) =>
      boards.find(
        (b): b is Extract<Board, { state: "micropython" | "esp32" }> =>
          b.state !== "bootsel" && matches(target, b)
      )
  )
  const reply = await answer(config, back.port)
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
 * The real machine's ESP32 flash settings.
 *
 * @param list - lists the boards plugged in
 * @param open - opens a serial port
 * @returns the settings
 */
export function defaultEsp32FlashConfig(
  list: () => Promise<Board[]>,
  open: (path: string) => Promise<ControlSerialPort>
): Esp32FlashConfig {
  return {
    list,
    open,
    rom: esptoolRom,
    builds: MICROPYTHON_ESP32,
    firmware: defaultFirmwareConfig,
    repl: defaultRawReplConfig,
    appear_timeout_ms: 30000,
    poll_ms: 250,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}
