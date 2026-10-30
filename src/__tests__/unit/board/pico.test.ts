import { describe, expect, it } from "vitest"

import type { DiscoverHost } from "../../../board/discover.ts"
import { enterBootsel, identify, listBoards, resetBoard, runCode } from "../../../board/pico.ts"
import { defaultRawReplConfig, RawRepl, type RawReplConfig } from "../../../board/raw-repl.ts"
import { CliError } from "../../../envelope.ts"
import { FakeBoard } from "./fake-board.ts"

// Generous, so a slow test runner never times out a board that does answer.
const fast: RawReplConfig = {
  ...defaultRawReplConfig,
  enter_timeout_ms: 5000,
  exec_timeout_ms: 5000,
  chunk_bytes: 8,
  chunk_pause_ms: 0
}

// For the tests that wait out a board that never answers.
const short: RawReplConfig = { ...fast, enter_timeout_ms: 50, exec_timeout_ms: 50 }

const MACHINE = "import sys\nprint(sys.implementation._machine)"

describe("runCode", () => {
  it("returns what the code printed and leaves the raw REPL", async () => {
    const board = new FakeBoard({ "print(1)": { stdout: "1\r\n" } })
    await expect(runCode(board, "print(1)", fast)).resolves.toBe("1\r\n")
    expect(board.ran).toEqual(["print(1)"])
    expect(board.written.at(-1)).toBe("\x02")
  })

  it("sends long code in chunks the board can take", async () => {
    const code = "x = 1\n".repeat(10)
    const board = new FakeBoard()
    await runCode(board, code, fast)
    expect(board.ran).toEqual([code])
    expect(board.written.filter((w) => w.length === fast.chunk_bytes).length).toBeGreaterThan(1)
  })

  it("reports a traceback's last line as the error", async () => {
    const board = new FakeBoard({
      "1/0": {
        stderr:
          'Traceback (most recent call last):\r\n  File "<stdin>", line 1\r\nZeroDivisionError: divide by zero\r\n'
      }
    })
    const error = await runCode(board, "1/0", fast).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toBe("the board raised ZeroDivisionError: divide by zero")
    expect(board.written.at(-1)).toBe("\x02")
  })

  it("fails as unavailable when the board never answers", async () => {
    const board = new FakeBoard()
    board.answers = false
    const error = await runCode(board, "print(1)", short).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: "unavailable",
      message: "the board didn't answer in time: enter the raw REPL"
    })
  })

  it("fails as unavailable when code never finishes", async () => {
    const board = new FakeBoard({ "while True: pass": "silent" })
    const error = await runCode(board, "while True: pass", short).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: "unavailable",
      message: "the board didn't answer in time: run code"
    })
  })

  it("fails when the board doesn't accept the code", async () => {
    const board = new FakeBoard()
    board.accept = "no"
    const error = await runCode(board, "print(1)", fast).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: "error",
      message: "the board isn't ready to take code: plug it back in and try again"
    })
  })
})

describe("RawRepl", () => {
  it("runs several pieces of code in one session", async () => {
    const board = new FakeBoard({ a: { stdout: "A" }, b: { stdout: "B" } })
    const repl = new RawRepl(board, fast)
    await repl.enter()
    expect(await repl.exec("a")).toEqual({ stdout: "A", stderr: "" })
    expect(await repl.exec("b")).toEqual({ stdout: "B", stderr: "" })
    await repl.exit()
    expect(board.ran).toEqual(["a", "b"])
  })

  it("uses production timings by default", () => {
    expect(defaultRawReplConfig).toMatchObject({ enter_timeout_ms: 3000, chunk_bytes: 256 })
  })

  it("pauses between chunks with the configured sleep", async () => {
    const pauses: number[] = []
    const board = new FakeBoard()
    const repl = new RawRepl(board, {
      ...fast,
      chunk_pause_ms: 7,
      sleep: async (ms) => {
        pauses.push(ms)
        return Promise.resolve()
      }
    })
    await repl.enter()
    pauses.length = 0
    await repl.exec("print(12345)")
    expect(pauses).toEqual([7, 7])
  })

  it("soft-resets and turns the LED off on entering, so no light shows a stale state", async () => {
    const board = new FakeBoard()
    const repl = new RawRepl(board, fast)
    await repl.enter()
    expect(board.softResets).toBe(1)
    expect(board.ledOffs).toBe(1)
    expect(board.ran).toEqual([])
  })
})

describe("identify", () => {
  it("returns the board's own description", async () => {
    const board = new FakeBoard({
      [MACHINE]: { stdout: "Raspberry Pi Pico 2 W with RP2350\r\n" }
    })
    await expect(identify(board, fast)).resolves.toBe("Raspberry Pi Pico 2 W with RP2350")
  })
})

describe("resetBoard and enterBootsel", () => {
  it("starts a reset without waiting for a reply", async () => {
    const board = new FakeBoard({ "import machine\nmachine.reset()": "silent" })
    await resetBoard(board, fast)
    expect(board.ran).toEqual(["import machine\nmachine.reset()"])
  })

  it("counts a board that drops off USB before replying as reset", async () => {
    const board = new FakeBoard()
    board.vanishes = true
    await expect(resetBoard(board, fast)).resolves.toBeUndefined()
    expect(board.ran).toEqual(["import machine\nmachine.reset()"])
  })

  it("still fails a reset the board never answers", async () => {
    const board = new FakeBoard()
    board.answers = false
    await expect(resetBoard(board, short)).rejects.toMatchObject({ code: "unavailable" })
  })

  it("fails a reset the board refuses", async () => {
    const board = new FakeBoard()
    board.accept = "no"
    await expect(resetBoard(board, fast)).rejects.toThrow("the board isn't ready to take code")
  })

  it("reports a board that drops off USB while running code", async () => {
    const board = new FakeBoard()
    board.vanishes = true
    await expect(runCode(board, "print(1)", fast)).rejects.toThrow(
      "the board on /dev/fake disconnected"
    )
  })

  it("starts the bootloader without waiting for a reply", async () => {
    const board = new FakeBoard({ "import machine\nmachine.bootloader()": "silent" })
    await enterBootsel(board, fast)
    expect(board.ran).toEqual(["import machine\nmachine.bootloader()"])
  })
})

describe("listBoards", () => {
  const ioreg = [
    "+-o Board in FS mode@00110000  <class IOUSBHostDevice, id 0x1>",
    '  |   "idProduct" = 5',
    '  |   "idVendor" = 11914',
    '  |   "USB Serial Number" = "pico-serial"',
    "  +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x2>",
    '        "IOCalloutDevice" = "/dev/cu.usbmodem1101"',
    "+-o Nano@00120000  <class IOUSBHostDevice, id 0x3>",
    '  |   "idProduct" = 112',
    '  |   "idVendor" = 9025',
    "  +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x4>",
    '        "IOCalloutDevice" = "/dev/cu.usbmodem2"'
  ].join("\n")

  it("lists running boards then BOOTSEL drives", async () => {
    const files: Record<string, string> = {
      "/Volumes/RP2350/INFO_UF2.TXT":
        "UF2 Bootloader v1.0\nModel: Raspberry Pi RP2350\nBoard-ID: RP2350\n"
    }
    const host: DiscoverHost = {
      platform: "darwin",
      run: async () => Promise.resolve(ioreg),
      readdir: async (path) =>
        Promise.resolve(path === "/Volumes" ? ["RP2350", "Macintosh HD"] : []),
      readFile: async (path) => {
        const text = files[path]
        return text === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(text)
      },
      realpath: async (path) => Promise.resolve(path)
    }
    await expect(listBoards(host)).resolves.toEqual([
      { state: "micropython", port: "/dev/cu.usbmodem1101", serialNumber: "pico-serial" },
      { state: "bootsel", drive: "/Volumes/RP2350", model: "Raspberry Pi RP2350" }
    ])
  })
})
