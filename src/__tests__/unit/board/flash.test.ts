import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { MICROPYTHON_PICO_2_W } from "../../../board/firmware.ts"
import {
  copyToDrive,
  defaultFlashConfig,
  type FlashConfig,
  flashMicroPython
} from "../../../board/flash.ts"
import type { Board } from "../../../board/pico.ts"
import { defaultRawReplConfig } from "../../../board/raw-repl.ts"
import type { ControlSerialPort, SerialPort } from "../../../board/serial.ts"
import { CliError } from "../../../envelope.ts"
import { FakeBoard } from "./fake-board.ts"
import { uf2 } from "./uf2.ts"

const BYTES = uf2(2)
const FIRMWARE = {
  ...MICROPYTHON_PICO_2_W,
  sha256: createHash("sha256").update(BYTES).digest("hex")
}
const UNAME = "import os\nu = os.uname()\nprint(u.release)\nprint(u.machine)"
const BOOTLOADER = "import machine\nmachine.bootloader()"

const running = (serialNumber = "pico-serial", port = "/dev/cu.pico"): Board => ({
  state: "micropython",
  port,
  serialNumber
})
const waiting: Board = { state: "bootsel", drive: "/Volumes/RP2350" }

type Rig = {
  config: FlashConfig
  /** What `list` returns on each call; the last entry repeats. */
  lists: Board[][]
  copies: { drive: string; bytes: Uint8Array }[]
  boards: FakeBoard[]
  opens: string[]
}

function rig(release = "1.29.0", openFailures = 0): Rig {
  const lists: Board[][] = []
  const copies: Rig["copies"] = []
  const boards: FakeBoard[] = []
  const opens: string[] = []
  let failures = openFailures
  const config: FlashConfig = {
    list: async () => Promise.resolve((lists.length > 1 ? lists.shift() : lists[0]) ?? []),
    open: async (path): Promise<SerialPort> => {
      opens.push(path)
      if (failures > 0) {
        failures--
        return Promise.reject(new CliError(`serial port ${path} is in use`, "unavailable"))
      }
      const board = new FakeBoard({
        [BOOTLOADER]: "silent",
        [UNAME]: { stdout: `${release}\r\nRaspberry Pi Pico 2 W with RP2350\r\n` }
      })
      boards.push(board)
      return Promise.resolve(board)
    },
    copy: async (drive, bytes) => {
      copies.push({ drive, bytes })
      return Promise.resolve()
    },
    firmware: {
      cache_dir: join(tmpdir(), `qualithm-flash-${randomUUID()}`),
      fetch: async () => Promise.resolve(new Response(BYTES))
    },
    repl: { ...defaultRawReplConfig, chunk_pause_ms: 0 },
    appear_timeout_ms: 200,
    poll_ms: 1,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
  return { config, lists, copies, boards, opens }
}

describe("flashMicroPython", () => {
  it("restarts a running board into BOOTSEL, copies the UF2 and checks the release", async () => {
    const r = rig()
    r.lists.push([running()], [], [waiting], [], [running("PICO-SERIAL", "/dev/cu.back")])
    const result = await flashMicroPython(r.config, undefined, FIRMWARE)
    expect(result).toEqual({
      port: "/dev/cu.back",
      serialNumber: "PICO-SERIAL",
      version: "1.29.0",
      machine: "Raspberry Pi Pico 2 W with RP2350"
    })
    expect(r.boards[0]?.ran).toEqual([BOOTLOADER])
    expect(r.boards[0]?.closed).toBe(true)
    expect(r.copies).toEqual([{ drive: "/Volumes/RP2350", bytes: BYTES }])
    expect(r.boards[1]?.ran).toEqual([UNAME])
    expect(r.opens).toEqual(["/dev/cu.pico", "/dev/cu.back"])
  })

  it("flashes a board already waiting in BOOTSEL", async () => {
    const r = rig()
    r.lists.push([waiting], [running()])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).resolves.toMatchObject({
      port: "/dev/cu.pico",
      version: "1.29.0"
    })
    expect(r.boards).toHaveLength(1)
  })

  it("picks the board named by serial number, ignoring case", async () => {
    const r = rig()
    r.lists.push(
      [running("other", "/dev/cu.other"), running()],
      [running("other", "/dev/cu.other"), waiting],
      [running("other", "/dev/cu.other"), running()]
    )
    const result = await flashMicroPython(r.config, "PICO-SERIAL", FIRMWARE)
    expect(result.port).toBe("/dev/cu.pico")
    expect(r.opens[0]).toBe("/dev/cu.pico")
  })

  it("returns a board without a serial number as it came back", async () => {
    const r = rig()
    r.lists.push([waiting], [{ state: "micropython", port: "/dev/cu.anon" }])
    const result = await flashMicroPython(r.config, undefined, FIRMWARE)
    expect(result).toEqual({
      port: "/dev/cu.anon",
      version: "1.29.0",
      machine: "Raspberry Pi Pico 2 W with RP2350"
    })
  })

  it("retries opening a port that has only just appeared", async () => {
    const r = rig("1.29.0", 2)
    r.lists.push([waiting], [running()])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).resolves.toMatchObject({
      version: "1.29.0"
    })
    expect(r.opens).toHaveLength(3)
  })

  it("gives up on a port that never opens", async () => {
    const r = rig("1.29.0", 1000)
    r.lists.push([running()])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toThrow(
      "serial port /dev/cu.pico is in use"
    )
  })

  it("fails when the board comes back running another release", async () => {
    const r = rig("1.28.0")
    r.lists.push([waiting], [running()])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toThrow(
      "the board runs MicroPython 1.28.0 after flashing, not 1.29.0"
    )
  })

  it("tells the builder to replug when the board never shows up as a drive", async () => {
    const r = rig()
    r.lists.push([running()], [])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toEqual(
      new CliError(
        "the board restarted into BOOTSEL but no drive appeared: unplug it, plug it back in, and flash again",
        "unavailable"
      )
    )
  })

  it("fails when the board never comes back", async () => {
    const r = rig()
    r.lists.push([waiting], [])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toThrow(
      "the board didn't restart running MicroPython in time"
    )
  })

  it("refuses when no board is plugged in", async () => {
    const r = rig()
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toMatchObject({
      code: "not_found",
      message:
        "no board found: plug in an ESP32, or a Pico 2 W holding BOOTSEL if it has never been flashed"
    })
  })

  it("asks which board when several are plugged in", async () => {
    const r = rig()
    r.lists.push([running(), waiting])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toEqual(
      new CliError("2 boards are plugged in: name one by its serial number", "usage")
    )
  })

  it("refuses a serial number no board has", async () => {
    const r = rig()
    r.lists.push([running()])
    await expect(flashMicroPython(r.config, "nope", FIRMWARE)).rejects.toMatchObject({
      code: "not_found",
      message: "no board with serial number nope is plugged in"
    })
  })

  it("downloads before touching the board", async () => {
    const r = rig()
    r.lists.push([running()])
    r.config.firmware.fetch = async () => Promise.reject(new Error("offline"))
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toThrow("offline")
    expect(r.opens).toEqual([])
  })
})

describe("copyToDrive", () => {
  it("writes the UF2 onto the drive", async () => {
    const drive = await mkdtemp(join(tmpdir(), "qualithm-drive-"))
    await copyToDrive(drive, BYTES)
    expect(new Uint8Array(await readFile(join(drive, "MICROPYTHON.UF2")))).toEqual(BYTES)
  })

  it("counts a drive that vanished as the board restarting", async () => {
    await expect(copyToDrive("/nonexistent/RP2350", BYTES)).resolves.toBeUndefined()
  })

  it("reports any other failure", async () => {
    // A plain file where the drive should be: writing beneath it fails with ENOTDIR.
    const notADrive = join(await mkdtemp(join(tmpdir(), "qualithm-drive-")), "file")
    await writeFile(notADrive, "")
    await expect(copyToDrive(notADrive, BYTES)).rejects.toThrow(
      `copy MicroPython onto ${notADrive}: `
    )
  })
})

describe("flashMicroPython on an ESP32", () => {
  const esp: Board = {
    state: "esp32",
    port: "/dev/cu.c3",
    serialNumber: "54FC019337",
    vendorId: "1a86",
    productId: "55d4"
  }

  it("refuses when no ESP32 flashing is set up", async () => {
    const r = rig()
    r.lists.push([esp])
    await expect(flashMicroPython(r.config, undefined, FIRMWARE)).rejects.toThrow(
      "flashing an ESP32 isn't set up here"
    )
  })

  it("hands the board to the ESP32 flash, never downloading the Pico build", async () => {
    const r = rig()
    r.lists.push([esp])
    const fetched: string[] = []
    r.config.firmware = {
      ...r.config.firmware,
      fetch: async (url) => {
        fetched.push(url)
        return Promise.resolve(new Response(BYTES))
      }
    }
    r.config.esp32 = {
      list: async () => Promise.resolve([]),
      open: async () =>
        Promise.reject(new CliError("serial port /dev/cu.c3 is in use", "unavailable")),
      rom: () => {
        throw new Error("not reached")
      },
      builds: {},
      firmware: r.config.firmware,
      repl: r.config.repl,
      appear_timeout_ms: 0,
      poll_ms: 1,
      sleep: r.config.sleep
    }
    await expect(flashMicroPython(r.config, "54fc019337", FIRMWARE)).rejects.toThrow("in use")
    expect(fetched).toEqual([])
  })
})

describe("defaultFlashConfig", () => {
  it("uses the real machine with the given opener", async () => {
    const open = async (): Promise<ControlSerialPort> => Promise.resolve(new FakeBoard())
    const config = defaultFlashConfig(open)
    expect(config.open).toBe(open)
    expect(config.copy).toBe(copyToDrive)
    expect(config.appear_timeout_ms).toBe(30000)
    await expect(config.sleep(0)).resolves.toBeUndefined()
    expect(Array.isArray(await config.list())).toBe(true)
  })
})
