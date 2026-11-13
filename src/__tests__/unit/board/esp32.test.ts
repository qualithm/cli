import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  checkEspImage,
  defaultEsp32FlashConfig,
  type Esp32Board,
  type Esp32Firmware,
  type Esp32FlashConfig,
  esptoolRom,
  flashEsp32,
  loadEsp32Firmware,
  MICROPYTHON_ESP32,
  MICROPYTHON_ESP32_VERSION,
  type RomLoader
} from "../../../board/esp32.ts"
import type { Board } from "../../../board/pico.ts"
import { defaultRawReplConfig } from "../../../board/raw-repl.ts"
import { DEVICE_SDK } from "../../../board/sdk.ts"
import type { ControlSerialPort } from "../../../board/serial.ts"
import { CliError } from "../../../envelope.ts"
import { FakeBoard } from "./fake-board.ts"

const loader = vi.hoisted(() => ({
  calls: [] as string[],
  chip: "ESP32-S3"
}))

vi.mock("esptool-js", () => ({
  Transport: class {
    readonly device: unknown
    constructor(device: unknown) {
      this.device = device
    }
    async disconnect(): Promise<void> {
      loader.calls.push("disconnect")
      return Promise.resolve()
    }
  },
  ESPLoader: class {
    readonly chip = { CHIP_NAME: loader.chip }
    async main(): Promise<string> {
      loader.calls.push("main")
      return Promise.resolve(loader.chip)
    }
    async writeFlash(options: {
      fileArray: { data: Uint8Array; address: number }[]
      eraseAll: boolean
      calculateMD5Hash: (b: Uint8Array) => string
    }): Promise<void> {
      const [file] = options.fileArray
      loader.calls.push(
        `write ${String(file?.address)} ${String(options.eraseAll)} ${options.calculateMD5Hash(new Uint8Array([1]))}`
      )
      return Promise.resolve()
    }
    async writeReg(addr: number, value: number, mask: number): Promise<void> {
      loader.calls.push(`reg 0x${addr.toString(16)} ${String(value)} ${String(mask)}`)
      return Promise.resolve()
    }
    async after(mode: string, _otg: boolean, sequence: string): Promise<void> {
      loader.calls.push(`after ${mode} ${sequence}`)
      return Promise.resolve()
    }
  }
}))

/** An ESP application image header naming a chip. */
function image(chipId: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes[0] = 0xe9
  new DataView(bytes.buffer).setUint16(12, chipId, true)
  return bytes
}

const C3_IMAGE = image(5)
const C3: Esp32Firmware = {
  ...MICROPYTHON_ESP32["ESP32-C3"],
  sha256: createHash("sha256").update(C3_IMAGE).digest("hex")
}
const UNAME = "import os\nu = os.uname()\nprint(u.release)\nprint(u.machine)"
const BOOTLOADER = "import machine\nmachine.bootloader()"

const bridge = (serialNumber = "54FC019337"): Board => ({
  state: "esp32",
  port: "/dev/cu.usbserial-1",
  serialNumber,
  vendorId: "1a86",
  productId: "55d4"
})

type Rig = {
  config: Esp32FlashConfig
  lists: Board[][]
  roms: string[]
  infos: unknown[]
  boards: FakeBoard[]
}

function rig(
  chip = "ESP32-C3",
  release = "1.29.0",
  romOverrides: Partial<RomLoader> = {},
  unameFailures = 0
): Rig {
  const lists: Board[][] = []
  const roms: string[] = []
  const infos: unknown[] = []
  const boards: FakeBoard[] = []
  let failures = unameFailures
  const config: Esp32FlashConfig = {
    list: async () => Promise.resolve((lists.length > 1 ? lists.shift() : lists[0]) ?? []),
    open: async (): Promise<ControlSerialPort> => {
      const answers = failures === 0
      if (!answers) {
        failures--
      }
      const board = new FakeBoard({
        [BOOTLOADER]: "silent",
        [UNAME]: { stdout: `${release}\r\nESP32C3 module with ESP32-C3\r\n` }
      })
      board.answers = answers
      boards.push(board)
      return Promise.resolve(board)
    },
    rom: (_port, info) => {
      infos.push(info)
      return {
        connect: async () => {
          roms.push("connect")
          return Promise.resolve(chip)
        },
        write: async (bytes) => {
          roms.push(`write ${String(bytes.length)}`)
          return Promise.resolve()
        },
        restart: async () => {
          roms.push("restart")
          return Promise.resolve()
        },
        close: async () => {
          roms.push("close")
          return Promise.resolve()
        },
        ...romOverrides
      }
    },
    builds: { "ESP32-C3": C3 },
    firmware: {
      cache_dir: join(tmpdir(), `qualithm-esp32-${randomUUID()}`),
      fetch: async () => Promise.resolve(new Response(C3_IMAGE))
    },
    repl: { ...defaultRawReplConfig, chunk_pause_ms: 0, enter_timeout_ms: 100 },
    appear_timeout_ms: 300,
    poll_ms: 1,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
  return { config, lists, roms, infos, boards }
}

describe("checkEspImage", () => {
  it("accepts an image for the chip", () => {
    expect(() => {
      checkEspImage(image(9), 9)
    }).not.toThrow()
  })

  it("refuses bytes that aren't an image, or name another chip", () => {
    expect(() => {
      checkEspImage(new Uint8Array(4), 9)
    }).toThrow("the firmware isn't an ESP32 image")
    expect(() => {
      checkEspImage(new Uint8Array(64), 9)
    }).toThrow("isn't an ESP32 image")
    expect(() => {
      checkEspImage(image(5), 9)
    }).toThrow("the firmware is for another chip: its header names chip 5")
  })
})

describe("MICROPYTHON_ESP32", () => {
  it("pins one release for every chip, each naming its chip", () => {
    for (const [chip, build] of Object.entries(MICROPYTHON_ESP32)) {
      expect(build.chip).toBe(chip)
      expect(build.version).toBe(MICROPYTHON_ESP32_VERSION)
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(build.url).toMatch(
        build.frozenSdk === undefined
          ? /^https:\/\/micropython\.org\/.*-v1\.29\.0\.bin$/
          : /^https:\/\/github\.com\/qualithm\/micropython-firmware\/releases\/download\//
      )
    }
  })

  it("puts Qualithm's build, with the SDK deploy installs frozen in, on the C3 alone", () => {
    expect(MICROPYTHON_ESP32["ESP32-C3"].frozenSdk).toBe(DEVICE_SDK.version)
    expect(MICROPYTHON_ESP32["ESP32-S3"].frozenSdk).toBeUndefined()
    expect(MICROPYTHON_ESP32["ESP32-C6"].frozenSdk).toBeUndefined()
  })
})

describe("loadEsp32Firmware", () => {
  it("downloads, checks and caches the image", async () => {
    const r = rig()
    await expect(loadEsp32Firmware(C3, r.config.firmware)).resolves.toEqual(C3_IMAGE)
  })

  it("refuses an image for another chip", async () => {
    const other = image(9)
    const build = { ...C3, sha256: createHash("sha256").update(other).digest("hex") }
    const firmware = {
      cache_dir: join(tmpdir(), `qualithm-esp32-${randomUUID()}`),
      fetch: async () => Promise.resolve(new Response(other))
    }
    await expect(loadEsp32Firmware(build, firmware)).rejects.toThrow("for another chip")
  })
})

describe("flashEsp32", () => {
  it("flashes an ESP32 behind a USB bridge and checks it came back running the release", async () => {
    const r = rig()
    r.lists.push([bridge()])
    const result = await flashEsp32(r.config, bridge() as Esp32Board)
    expect(result).toEqual({
      port: "/dev/cu.usbserial-1",
      serialNumber: "54FC019337",
      version: "1.29.0",
      machine: "ESP32C3 module with ESP32-C3"
    })
    expect(r.roms).toEqual(["connect", `write ${String(C3_IMAGE.length)}`, "restart", "close"])
    expect(r.infos).toEqual([{ usbVendorId: 0x1a86, usbProductId: 0x55d4 }])
    expect(r.boards.every((b) => b.closed)).toBe(true)
  })

  it("asks an ESP32-S3's MicroPython for the bootloader, then finds it by its ROM serial", async () => {
    const r = rig()
    const s3: Board = {
      state: "micropython",
      port: "/dev/cu.usbmodem1",
      serialNumber: "441bf6f5521c0000",
      family: "esp32"
    }
    const rom: Board = {
      state: "esp32",
      port: "/dev/cu.usbmodem1",
      serialNumber: "44:1B:F6:F5:52:1C",
      vendorId: "303a",
      productId: "1001"
    }
    r.lists.push([s3], [rom], [s3])
    await expect(flashEsp32(r.config, s3 as Esp32Board)).resolves.toMatchObject({
      serialNumber: "441bf6f5521c0000",
      version: "1.29.0"
    })
    expect(r.boards[0]?.ran).toEqual([BOOTLOADER])
    expect(r.infos).toEqual([{ usbVendorId: 0x303a, usbProductId: 0x1001 }])
  })

  it("matches a board without a serial number by its port", async () => {
    const r = rig()
    const bare: Board = {
      state: "esp32",
      port: "/dev/ttyUSB0",
      vendorId: "1a86",
      productId: "55d4"
    }
    r.lists.push([bare])
    await expect(flashEsp32(r.config, bare as Esp32Board)).resolves.toMatchObject({
      port: "/dev/ttyUSB0"
    })
  })

  it("keeps asking a board that formats its filesystem on first boot", async () => {
    const r = rig("ESP32-C3", "1.29.0", {}, 1)
    r.lists.push([bridge()])
    await expect(flashEsp32(r.config, bridge() as Esp32Board)).resolves.toMatchObject({
      version: "1.29.0"
    })
  })

  it("gives up when the board never answers after the flash", async () => {
    const r = rig("ESP32-C3", "1.29.0", {}, 1000)
    r.lists.push([bridge()])
    await expect(flashEsp32(r.config, bridge() as Esp32Board)).rejects.toThrow(
      "the board didn't answer in time"
    )
  })

  it("refuses a chip it has no build for and restarts it as it was", async () => {
    const r = rig("ESP32-H2")
    r.lists.push([bridge()])
    await expect(flashEsp32(r.config, bridge() as Esp32Board)).rejects.toMatchObject({
      code: "usage",
      message: "the board is an ESP32-H2: plug in an ESP32-S3, ESP32-C3 or ESP32-C6"
    })
    expect(r.roms).toEqual(["connect", "restart", "close"])
  })

  it("restarts the board untouched when the download fails", async () => {
    const r = rig()
    r.config.firmware = {
      cache_dir: join(tmpdir(), `qualithm-esp32-${randomUUID()}`),
      fetch: async () => Promise.reject(new Error("offline"))
    }
    r.lists.push([bridge()])
    await expect(flashEsp32(r.config, bridge() as Esp32Board)).rejects.toThrow("offline")
    expect(r.roms).toEqual(["connect", "restart", "close"])
  })

  it("fails when the board comes back running another release", async () => {
    const r = rig("ESP32-C3", "1.28.0")
    r.lists.push([bridge()])
    await expect(flashEsp32(r.config, bridge() as Esp32Board)).rejects.toThrow(
      "the board runs MicroPython 1.28.0 after flashing, not 1.29.0"
    )
  })

  it("fails when the board never comes back", async () => {
    const r = rig()
    const s3: Board = { state: "micropython", port: "/dev/x", serialNumber: "aa", family: "esp32" }
    r.lists.push([s3], [])
    await expect(flashEsp32(r.config, s3 as Esp32Board)).rejects.toThrow(
      "the board didn't restart into its bootloader in time"
    )
    const late = rig()
    late.lists.push([])
    await expect(flashEsp32(late.config, bridge() as Esp32Board)).rejects.toThrow(
      "the board didn't restart running MicroPython in time"
    )
  })

  it("retries opening a port that has only just appeared, then gives up", async () => {
    const r = rig()
    r.lists.push([bridge()])
    const { open } = r.config
    let refusals = 1
    r.config.open = async (path) => {
      if (refusals > 0) {
        refusals--
        return Promise.reject(new CliError("serial port is in use", "unavailable"))
      }
      return open(path)
    }
    await expect(flashEsp32(r.config, bridge() as Esp32Board)).resolves.toMatchObject({
      version: "1.29.0"
    })
    r.config.open = async () => Promise.reject(new CliError("serial port is in use", "unavailable"))
    await expect(flashEsp32(r.config, bridge() as Esp32Board)).rejects.toThrow("in use")
  })
})

describe("esptoolRom", () => {
  it("connects, writes the whole flash verified, clears the S3's download latch and restarts", async () => {
    loader.calls.length = 0
    loader.chip = "ESP32-S3"
    const rom = esptoolRom(new FakeBoard(), { usbVendorId: 0x303a })
    expect(await rom.connect()).toBe("ESP32-S3")
    await rom.write(new Uint8Array([1, 2]))
    await rom.restart()
    await rom.close()
    expect(loader.calls).toEqual([
      "main",
      "write 0 true 55a54008ad1ba589aa210d2629c1df41",
      "reg 0x6000812c 0 1",
      "after custom_reset D0|R1|W100|R0",
      "disconnect"
    ])
  })

  it("restarts other chips without touching registers", async () => {
    loader.calls.length = 0
    loader.chip = "ESP32-C3"
    await esptoolRom(new FakeBoard(), {}).restart()
    expect(loader.calls).toEqual(["after custom_reset D0|R1|W100|R0"])
  })
})

describe("defaultEsp32FlashConfig", () => {
  it("uses the pinned builds, esptool-js and the given list and opener", async () => {
    const list = async (): Promise<Board[]> => Promise.resolve([])
    const open = async (): Promise<ControlSerialPort> => Promise.resolve(new FakeBoard())
    const config = defaultEsp32FlashConfig(list, open)
    expect(config.list).toBe(list)
    expect(config.open).toBe(open)
    expect(config.rom).toBe(esptoolRom)
    expect(config.builds).toBe(MICROPYTHON_ESP32)
    expect(config.appear_timeout_ms).toBe(30000)
    await expect(config.sleep(0)).resolves.toBeUndefined()
  })
})
