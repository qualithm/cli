import { afterEach, describe, expect, it } from "vitest"

import type { Board } from "../../../board/pico.ts"
import { PortClosedError, type SerialPort } from "../../../board/serial.ts"
import { pickRunning } from "../../../core/boards.ts"
import { type TapDeps, Taps } from "../../../core/taps.ts"
import { CliError } from "../../../envelope.ts"

/** A port that hands out queued output and records what is written. */
class StreamPort implements SerialPort {
  readonly path: string
  readonly queued: Uint8Array[] = []
  readonly written: string[] = []
  closed = false
  gone = false

  constructor(path = "/dev/cu.pico") {
    this.path = path
  }

  say(text: string | Uint8Array): void {
    this.queued.push(typeof text === "string" ? new TextEncoder().encode(text) : text)
  }

  async write(data: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(data))
    return Promise.resolve()
  }

  async read(): Promise<Uint8Array> {
    if (this.gone) {
      throw new PortClosedError(this.path)
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
    return this.queued.shift() ?? new Uint8Array(0)
  }

  async close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

const pico: Board = { state: "micropython", port: "/dev/cu.pico", serialNumber: "abc" }
const opened: Taps[] = []

function taps(
  ports: StreamPort[],
  boards: Board[][] = [[pico]],
  extra: Partial<TapDeps> = {}
): { taps: Taps; opens: string[] } {
  const opens: string[] = []
  let call = 0
  const t = new Taps({
    list: async () => Promise.resolve(boards[Math.min(call++, boards.length - 1)] ?? []),
    open: async (board) => {
      opens.push(board.port)
      const port = ports.shift()
      if (port === undefined) {
        throw new Error("no port left")
      }
      return Promise.resolve(port)
    },
    pick: pickRunning,
    read_wait_ms: 1,
    max_chunks: 100,
    poll_ms: 1,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...extra
  })
  opened.push(t)
  return { taps: t, opens }
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (t) => t.close()))
})

describe("Taps", () => {
  it("buffers a board's output and pages through it", async () => {
    const port = new StreamPort()
    const { taps: t } = taps([port])
    port.say("hello ")
    port.say("world\r\n")
    const first = await t.logs(undefined, 0, 1000, 1)
    expect(first).toMatchObject({
      board: { port: "/dev/cu.pico", serialNumber: "abc" },
      chunks: [{ seq: 1, text: "hello " }],
      next: 1
    })
    const second = await t.logs("ABC", first.next, 1000, 10)
    expect(second.chunks.map((c) => c.text)).toEqual(["world\r\n"])
    expect(second).toMatchObject({ next: 2, more: false })
  })

  it("says when more output waits than the limit allows", async () => {
    const port = new StreamPort()
    const { taps: t } = taps([port])
    await t.logs(undefined, 0, 0, 10)
    port.say("a")
    port.say("b")
    await t.logs(undefined, 0, 1000, 10)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await t.logs(undefined, 0, 0, 1)).toMatchObject({ next: 1, more: true })
  })

  it("returns nothing new when the wait ends quietly", async () => {
    const { taps: t } = taps([new StreamPort()])
    expect(await t.logs(undefined, 5, 5, 10)).toMatchObject({ chunks: [], next: 5 })
  })

  it("keeps a character split across reads whole", async () => {
    const port = new StreamPort()
    const { taps: t } = taps([port])
    const bytes = new TextEncoder().encode("é")
    port.say(bytes.slice(0, 1))
    port.say(bytes.slice(1))
    const page = await t.logs(undefined, 0, 1000, 10)
    expect(page.chunks.map((c) => c.text).join("")).toBe("é")
  })

  it("drops the oldest output past its limit", async () => {
    const port = new StreamPort()
    const { taps: t } = taps([port], [[pico]], { max_chunks: 2 })
    await t.logs(undefined, 0, 0, 10)
    port.say("1")
    port.say("2")
    port.say("3")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await t.logs(undefined, 0, 0, 10)).chunks.map((c) => c.text)).toEqual(["2", "3"])
  })

  it("types into the board's console", async () => {
    const port = new StreamPort()
    const { taps: t } = taps([port])
    expect(await t.write(undefined, "print(1)\r")).toEqual({
      port: "/dev/cu.pico",
      serialNumber: "abc"
    })
    expect(port.written).toEqual(["print(1)\r"])
  })

  it("closes its taps while a verb holds the ports, then reopens", async () => {
    const first = new StreamPort()
    const second = new StreamPort()
    const { taps: t, opens } = taps([first, second])
    await t.logs(undefined, 0, 0, 10)
    const during = await t.hold(async () => {
      expect(first.closed).toBe(true)
      return t.logs(undefined, 0, 0, 10)
    })
    expect(during.chunks).toEqual([])
    await expect(t.hold(async () => t.write(undefined, "x"))).rejects.toEqual(
      new CliError("the board is busy with a flash, reset or run: try again", "conflict")
    )
    await t.write(undefined, "y")
    expect(second.written).toEqual(["y"])
    expect(opens).toEqual(["/dev/cu.pico", "/dev/cu.pico"])
  })

  it("reattaches after the board goes away", async () => {
    const first = new StreamPort()
    const second = new StreamPort("/dev/cu.new")
    const moved: Board = { ...pico, port: "/dev/cu.new" }
    const { taps: t, opens } = taps([first, second], [[pico], [moved]])
    await t.logs(undefined, 0, 0, 10)
    first.gone = true
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(first.closed).toBe(true)
    second.say("back")
    const page = await t.logs(undefined, 0, 1000, 10)
    expect(page).toMatchObject({ board: { port: "/dev/cu.new" }, chunks: [{ text: "back" }] })
    expect(opens).toEqual(["/dev/cu.pico", "/dev/cu.new"])
  })
})

describe("Taps release and reconnect", () => {
  const refusal = new CliError("board abc is released: reconnect it first", "conflict")

  it("closes a released board's port and opens nothing until it's reconnected, keeping its output", async () => {
    const first = new StreamPort()
    const second = new StreamPort()
    const { taps: t, opens } = taps([first, second])
    first.say("before")
    await t.logs(undefined, 0, 1000, 10)
    await t.release("ABC")
    expect(first.closed).toBe(true)
    expect(t.isReleased("abc")).toBe(true)
    await expect(t.logs("abc", 0, 0, 10)).rejects.toEqual(refusal)
    await expect(t.write(undefined, "x")).rejects.toEqual(refusal)
    expect(opens).toEqual(["/dev/cu.pico"])
    t.reconnect("abc")
    expect(t.isReleased("abc")).toBe(false)
    second.say("after")
    expect(await t.logs(undefined, 1, 1000, 10)).toMatchObject({
      chunks: [{ seq: 2, text: "after" }]
    })
    const kept = await t.logs(undefined, 0, 0, 10)
    expect(kept.chunks.map((c) => c.text)).toEqual(["before", "after"])
    expect(opens).toEqual(["/dev/cu.pico", "/dev/cu.pico"])
  })

  it("follows a board across its serial numbers, and leaves other boards open", async () => {
    const s3: Board = {
      state: "esp32",
      port: "/dev/cu.s3",
      serialNumber: "441bf6f5521c0000",
      vendorId: "303a",
      productId: "4001"
    }
    const s3Port = new StreamPort("/dev/cu.s3")
    const picoPort = new StreamPort()
    const { taps: t } = taps([s3Port, picoPort], [[s3, pico]])
    await t.logs("441bf6f5521c0000", 0, 0, 10)
    await t.logs("abc", 0, 0, 10)
    await t.release("44:1B:F6:F5:52:1C")
    expect(s3Port.closed).toBe(true)
    expect(picoPort.closed).toBe(false)
    expect(t.isReleased("441bf6f5521c0000")).toBe(true)
    expect(t.isReleased(undefined)).toBe(false)
    await t.release("44:1B:F6:F5:52:1C")
    t.reconnect("441bf6f5521c0000")
    expect(t.isReleased("44:1B:F6:F5:52:1C")).toBe(false)
  })

  it("closes a port that finished opening after its board was released, or while a verb held it", async () => {
    const opening: { done?: () => void } = {}
    const slow = new StreamPort()
    const { taps: t } = taps([slow, new StreamPort(), new StreamPort()], [[pico]], {
      open: async () =>
        new Promise((resolve) => {
          opening.done = () => {
            resolve(slow)
          }
        })
    })
    const reading = t.logs(undefined, 0, 0, 10)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await t.release("abc")
    opening.done?.()
    await expect(reading).rejects.toEqual(refusal)
    expect(slow.closed).toBe(true)

    t.reconnect("abc")
    const held = new StreamPort()
    const { taps: h } = taps([], [[pico]], {
      open: async () => {
        // The verb's hold starts while this port opens.
        void h.hold(async () => new Promise((resolve) => setTimeout(resolve, 20)))
        return Promise.resolve(held)
      }
    })
    expect((await h.logs(undefined, 0, 0, 10)).chunks).toEqual([])
    expect(held.closed).toBe(true)
  })

  it("refuses a writer whose port opened while a verb held it", async () => {
    const held = new StreamPort()
    const { taps: h } = taps([], [[pico]], {
      open: async () => {
        void h.hold(async () => new Promise((resolve) => setTimeout(resolve, 20)))
        return Promise.resolve(held)
      }
    })
    await expect(h.write(undefined, "x")).rejects.toEqual(
      new CliError("the board is busy with a flash, reset or run: try again", "conflict")
    )
    expect(held.closed).toBe(true)
  })
})
