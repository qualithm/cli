import { describe, expect, it } from "vitest"

import type { Board } from "../../../board/pico.ts"
import { defaultRawReplConfig } from "../../../board/raw-repl.ts"
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
    expect(() => pickRunning([])).toThrow("no board found: plug in a Pico 2 W running MicroPython")
  })
})

describe("boardOps", () => {
  const fast = { ...defaultRawReplConfig, enter_timeout_ms: 5000, exec_timeout_ms: 5000 }

  const timing = {
    appear_timeout_ms: 1000,
    poll_ms: 1,
    sleep: async () => Promise.resolve(),
    read_wait_ms: 1,
    max_chunks: 10
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
})
