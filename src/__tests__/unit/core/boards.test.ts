import { describe, expect, it } from "vitest"

import type { Board } from "../../../board/pico.ts"
import { defaultRawReplConfig } from "../../../board/raw-repl.ts"
import { PROBE } from "../../../board/sync.ts"
import { boardOps, pickRunning } from "../../../core/boards.ts"
import { CliError } from "../../../envelope.ts"
import { FakeBoard } from "../board/fake-board.ts"

const running = (serialNumber?: string, port = "/dev/cu.a"): Board => ({
  state: "micropython",
  port,
  ...(serialNumber === undefined ? {} : { serialNumber })
})
const waiting: Board = { state: "bootsel", drive: "/Volumes/RP2350" }

describe("pickRunning", () => {
  it("picks the only running board", () => {
    expect(pickRunning([waiting, running("a")])).toEqual(running("a"))
  })

  it("picks a board by serial number, ignoring case", () => {
    expect(pickRunning([running("a"), running("b", "/dev/cu.b")], "B")).toEqual(
      running("b", "/dev/cu.b")
    )
  })

  it("refuses an unknown serial number", () => {
    expect(() => pickRunning([running("a")], "z")).toThrow("no running board with serial number z")
  })

  it("asks for a serial number when several boards run", () => {
    expect(() => pickRunning([running("a"), running("b")])).toThrow(
      "2 boards are running: name one by its serial number"
    )
  })

  it("says to flash a board that waits in BOOTSEL", () => {
    expect(() => pickRunning([waiting])).toThrow(
      "the board is in BOOTSEL and runs nothing yet: flash it first"
    )
  })

  it("says to plug a board in when there is none", () => {
    expect(() => pickRunning([])).toThrow(
      "no board found: plug in an ESP32, or a Pico 2 W running MicroPython"
    )
  })
})

describe("boardOps", () => {
  const fast = { ...defaultRawReplConfig, enter_timeout_ms: 5000, exec_timeout_ms: 5000 }

  const timing = {
    appear_timeout_ms: 1000,
    poll_ms: 1,
    sleep: async () => Promise.resolve(),
    read_wait_ms: 1,
    boot_quiet_ms: 5,
    boot_timeout_ms: 1000,
    max_chunks: 10,
    sdk: async () => Promise.resolve([])
  }

  /** Lists `lists` in turn, repeating the last; the board is plugged in by default. */
  const ops = (
    board: FakeBoard,
    lists: Board[][] = [[running("abc", "/dev/cu.pico")]],
    extra: Partial<Parameters<typeof boardOps>[0]> = {}
  ): ReturnType<typeof boardOps> => {
    let call = 0
    return boardOps({
      list: async () => Promise.resolve(lists[Math.min(call++, lists.length - 1)] ?? []),
      open: async () => Promise.resolve(board),
      flash: async () => Promise.reject(new Error("not used")),
      repl: fast,
      ...timing,
      ...extra
    })
  }
  const pico = running("abc", "/dev/cu.pico")

  it("runs code on the board and closes its port", async () => {
    const board = new FakeBoard({ "print(42)": { stdout: "42\r\n" } })
    expect(await ops(board).run(undefined, "print(42)")).toEqual({
      board: { port: "/dev/cu.pico", serialNumber: "abc" },
      output: "42\r\n"
    })
    expect(board.closed).toBe(true)
    // A Pico's own USB doesn't wire the modem lines to anything, so they are left alone.
    expect(board.controls).toEqual([])
  })

  it("closes the port when the code raises", async () => {
    const board = new FakeBoard({ boom: { stderr: "ValueError: no\r\n" } })
    await expect(ops(board).run(undefined, "boom")).rejects.toThrow(
      "the board raised ValueError: no"
    )
    expect(board.closed).toBe(true)
  })

  it("resets the board and waits until it is back", async () => {
    const board = new FakeBoard()
    board.vanishes = true
    const back = running("ABC", "/dev/cu.new")
    const reset = ops(board, [[pico], [pico], [], [waiting], [back]])
    expect(await reset.reset("abc")).toEqual({ port: "/dev/cu.new", serialNumber: "ABC" })
    expect(board.ran).toContain("import machine\nmachine.reset()")
  })

  const esp32: Board = {
    state: "esp32",
    port: "/dev/cu.usbserial-1",
    serialNumber: "54FC019337",
    vendorId: "1a86",
    productId: "55d4"
  }
  const reset = "import machine\nmachine.reset()"

  it("releases an ESP32's EN and boot lines when it opens its port", async () => {
    const board = new FakeBoard({ "print(42)": { stdout: "42\r\n" } })
    await ops(board, [[esp32]]).run(undefined, "print(42)")
    expect(board.controls).toEqual([{ dtr: false, rts: false }])
  })

  it("resets an ESP32 and reads its boot before closing the port", async () => {
    const board = new FakeBoard({
      [reset]: { stdout: "ESP-ROM:esp32c6-20220919\r\nrig: booted\r\n" }
    })
    let readsAfterReset = 0
    const read = board.read.bind(board)
    board.read = async () => {
      if (board.ran.includes(reset)) {
        readsAfterReset++
      }
      return read()
    }
    const o = ops(board, [[esp32]], { appear_timeout_ms: 60000 })
    expect(await o.reset()).toEqual({ port: "/dev/cu.usbserial-1", serialNumber: "54FC019337" })
    expect(board.ran).toContain(reset)
    expect(readsAfterReset).toBeGreaterThan(1)
    expect(board.closed).toBe(true)
  })

  it("stops waiting for an ESP32's boot when it stays silent or its port goes", async () => {
    const silent = new FakeBoard({ [reset]: "silent" })
    expect(await ops(silent, [[esp32]], { boot_timeout_ms: 20 }).reset()).toEqual({
      port: "/dev/cu.usbserial-1",
      serialNumber: "54FC019337"
    })
    const gone = new FakeBoard()
    gone.vanishes = true
    expect(await ops(gone, [[esp32]]).reset()).toEqual({
      port: "/dev/cu.usbserial-1",
      serialNumber: "54FC019337"
    })
  })

  it("fails a reset when an ESP32's port fails while it boots", async () => {
    const board = new FakeBoard({ [reset]: { stdout: "ESP-ROM:esp32c6-20220919\r\n" } })
    const read = board.read.bind(board)
    let accepted = false
    board.read = async () => {
      if (accepted) {
        throw new Error("EIO")
      }
      const bytes = await read()
      accepted = board.ran.includes(reset) && Buffer.from(bytes).toString().includes("K")
      return bytes
    }
    await expect(ops(board, [[esp32]]).reset()).rejects.toThrow("EIO")
  })

  it("tracks a board without a serial number by its port", async () => {
    const board = new FakeBoard()
    board.vanishes = true
    const anonymous = running(undefined, "/dev/cu.x")
    const other = running("zzz", "/dev/cu.y")
    expect(await ops(board, [[anonymous], [other], [anonymous]]).reset()).toEqual({
      port: "/dev/cu.x"
    })
  })

  it("takes a board that restarted too fast to be seen leaving", async () => {
    const board = new FakeBoard()
    board.vanishes = true
    expect(await ops(board, [[pico]], { appear_timeout_ms: 0 }).reset()).toEqual({
      port: "/dev/cu.pico",
      serialNumber: "abc"
    })
  })

  it("fails when the board doesn't come back", async () => {
    const board = new FakeBoard()
    board.vanishes = true
    await expect(ops(board, [[pico], []], { appear_timeout_ms: 5 }).reset()).rejects.toEqual(
      new CliError("the board didn't come back running MicroPython in time", "unavailable")
    )
  })

  it("reads and types through a tap, and closes it", async () => {
    const board = new FakeBoard()
    const o = ops(board, undefined, {
      sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    })
    expect(await o.write(undefined, "\r\x02")).toEqual({
      port: "/dev/cu.pico",
      serialNumber: "abc"
    })
    const page = await o.logs(undefined, 0, 1000, 10)
    expect(page.chunks.map((c) => c.text).join("")).toContain("MicroPython")
    await o.close()
    expect(board.closed).toBe(true)
  })

  it("deploys to a running board and reports the sync", async () => {
    const board = new FakeBoard()
    const result = await ops(board).deploy(
      undefined,
      [{ path: "/main.py", bytes: new Uint8Array([0x31]) }],
      false
    )
    expect(result).toEqual({
      board: { port: "/dev/cu.pico", serialNumber: "abc" },
      written: ["/main.py"],
      removed: [],
      unchanged: 0
    })
    expect(board.closed).toBe(true)
  })

  it("puts the device SDK beside the project", async () => {
    const board = new FakeBoard()
    const sdk = [{ path: "/lib/qualithm_device/pico.mpy", bytes: new Uint8Array([0x4d]) }]
    const result = await ops(board, [[waiting]], { sdk: async () => Promise.resolve(sdk) }).deploy(
      undefined,
      [{ path: "/main.py", bytes: new Uint8Array() }],
      true
    )
    expect(result.written).toEqual(["/main.py", "/lib/qualithm_device/pico.mpy"])
  })

  it("flashes a blank board before deploying to it", async () => {
    const board = new FakeBoard()
    const flashed: string[] = []
    const o = ops(board, [[waiting], [pico]], {
      flash: async (serial) => {
        flashed.push(serial ?? "-")
        return Promise.resolve({ port: "/dev/cu.pico", version: "1.29.0", machine: "Pico" })
      }
    })
    const result = await o.deploy(undefined, [{ path: "/main.py", bytes: new Uint8Array() }], false)
    expect(result).toMatchObject({ flashed: "1.29.0", written: ["/main.py"] })
    expect(flashed).toEqual(["-"])
  })

  it("deploys to the only blank board beside running ones, by the ID it comes back with", async () => {
    const board = new FakeBoard()
    const other = running("zzz", "/dev/cu.other")
    const back = running("a6afd22c8a7c3ef8", "/dev/cu.pico")
    const opened: string[] = []
    const o = ops(
      board,
      [
        [other, waiting],
        [other, back]
      ],
      {
        open: async (path) => {
          opened.push(path)
          return Promise.resolve(board)
        },
        flash: async () =>
          Promise.resolve({
            port: "/dev/cu.pico",
            serialNumber: "a6afd22c8a7c3ef8",
            version: "1.29.0",
            machine: "Pico"
          })
      }
    )
    const result = await o.deploy(undefined, [{ path: "/main.py", bytes: new Uint8Array() }], false)
    expect(result).toMatchObject({ board: { port: "/dev/cu.pico" }, flashed: "1.29.0" })
    expect(opened).toEqual(["/dev/cu.pico"])
  })

  it("says a blank board would be flashed on a dry run, touching nothing", async () => {
    const board = new FakeBoard()
    const result = await ops(board, [[waiting]]).deploy(
      undefined,
      [{ path: "/main.py", bytes: new Uint8Array() }],
      true
    )
    expect(result).toEqual({
      board: { port: "/Volumes/RP2350" },
      written: ["/main.py"],
      removed: [],
      unchanged: 0,
      flashed: "1.29.0"
    })
    expect(board.written).toEqual([])
  })

  const esp: Board = {
    state: "esp32",
    port: "/dev/cu.c3",
    serialNumber: "54FC019337",
    vendorId: "1a86",
    productId: "55d4"
  }
  const RELEASE = "import os\nprint(os.uname().release)"

  it("deploys to an ESP32 already running the release without flashing it", async () => {
    const board = new FakeBoard({ [RELEASE]: { stdout: "1.29.0\r\n" } })
    const result = await ops(board, [[esp]]).deploy(
      "54fc019337",
      [{ path: "/main.py", bytes: new Uint8Array() }],
      false
    )
    expect(result).toMatchObject({ board: { port: "/dev/cu.c3" }, written: ["/main.py"] })
    expect(result.flashed).toBeUndefined()
  })

  it("flashes an ESP32 that runs another release or doesn't answer, then deploys", async () => {
    for (const reply of [{ stdout: "1.24.1\r\n" }, "silent" as const]) {
      const board = new FakeBoard({ [RELEASE]: reply })
      const flashed: string[] = []
      const o = ops(board, [[esp]], {
        repl: { ...fast, enter_timeout_ms: 50, exec_timeout_ms: 50 },
        flash: async (serial) => {
          flashed.push(serial ?? "-")
          board.answers = true
          return Promise.resolve({ port: "/dev/cu.c3", version: "1.29.0", machine: "C3" })
        }
      })
      if (reply === "silent") {
        board.answers = false
      }
      await expect(
        o.deploy(undefined, [{ path: "/main.py", bytes: new Uint8Array() }], false)
      ).resolves.toMatchObject({ flashed: "1.29.0" })
      expect(flashed).toEqual(["-"])
    }
  })

  it("says an ESP32 would be flashed on a dry run, and probes it as blank", async () => {
    const board = new FakeBoard({ [RELEASE]: { stdout: "1.20.0\r\n" } })
    expect(
      await ops(board, [[esp]]).deploy(
        undefined,
        [{ path: "/main.py", bytes: new Uint8Array() }],
        true
      )
    ).toEqual({
      board: { port: "/dev/cu.c3", serialNumber: "54FC019337" },
      written: ["/main.py"],
      removed: [],
      unchanged: 0,
      flashed: "1.29.0"
    })
    expect(await ops(board, [[esp]]).probe(undefined)).toEqual({
      blank: true,
      credential: false,
      claimCode: false
    })
  })

  it("passes on an error that isn't the board's", async () => {
    const o = ops(new FakeBoard(), [[esp]], {
      open: async () => Promise.reject(new Error("ffi broke"))
    })
    await expect(o.probe(undefined)).rejects.toThrow("ffi broke")
  })

  it("probes a blank board without opening it, and a running one over the REPL", async () => {
    const blank = await ops(new FakeBoard(), [[waiting]]).probe(undefined)
    expect(blank).toEqual({ blank: true, credential: false, claimCode: false })
    const board = new FakeBoard({
      [PROBE]: { stdout: '{"credential": false, "claimCode": true, "wifiNetwork": "Home"}\r\n' }
    })
    expect(await ops(board).probe("abc")).toEqual({
      blank: false,
      credential: false,
      claimCode: true,
      wifiNetwork: "Home"
    })
  })
})
