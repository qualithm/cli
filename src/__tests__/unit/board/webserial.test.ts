import { describe, expect, it } from "vitest"

import { WebSerialPort } from "../../../board/webserial.ts"
import { FakeBoard } from "./fake-board.ts"

/** A control port whose reads return what a test queues, or nothing once the wait runs out. */
class QueuedPort extends FakeBoard {
  readonly incoming: Uint8Array[] = []

  override async read(waitMs = 1): Promise<Uint8Array> {
    const next = this.incoming.shift()
    if (next !== undefined) {
      return Promise.resolve(next)
    }
    return new Promise((resolve) =>
      setTimeout(() => {
        resolve(new Uint8Array(0))
      }, waitMs)
    )
  }
}

describe("WebSerialPort", () => {
  it("has no streams until opened, then opens at the asked speed", async () => {
    const port = new QueuedPort()
    const web = new WebSerialPort(port, { usbVendorId: 0x303a, usbProductId: 0x1001 })
    expect(web.readable).toBeNull()
    expect(web.writable).toBeNull()
    await web.open({ baudRate: 460800 })
    await new WebSerialPort(port, {}).open()
    expect(port.controls).toEqual([460800, 115200])
    expect(web.readable).not.toBeNull()
    expect(web.getInfo()).toEqual({ usbVendorId: 0x303a, usbProductId: 0x1001 })
  })

  it("reads what the board sends and writes what it's given", async () => {
    const port = new QueuedPort()
    const web = new WebSerialPort(port, {}, 1)
    await web.open({})
    port.incoming.push(new Uint8Array(0), new Uint8Array([1, 2]))
    const reader = web.readable?.getReader()
    expect((await reader?.read())?.value).toEqual(new Uint8Array([1, 2]))
    reader?.releaseLock()
    const writer = web.writable?.getWriter()
    await writer?.write(new Uint8Array([0x41]))
    writer?.releaseLock()
    expect(port.written).toEqual(["A"])
  })

  it("ends a read once cancelled, then makes a fresh stream", async () => {
    const port = new QueuedPort()
    const web = new WebSerialPort(port, {}, 1)
    await web.open({})
    const first = web.readable
    const reader = first?.getReader()
    const pending = reader?.read()
    await reader?.cancel()
    expect((await pending)?.done).toBe(true)
    expect(web.readable).not.toBe(first)
  })

  it("replaces a closed writer", async () => {
    const web = new WebSerialPort(new QueuedPort(), {})
    await web.open({})
    const first = web.writable
    await first?.getWriter().close()
    expect(web.writable).not.toBe(first)
  })

  it("drives DTR and RTS, leaving a line it isn't given", async () => {
    const port = new QueuedPort()
    const web = new WebSerialPort(port, {})
    await web.setSignals({ dataTerminalReady: false, requestToSend: true, break: false })
    await web.setSignals({ requestToSend: false })
    await web.setSignals({ dataTerminalReady: true })
    await web.setBaudRate(921600)
    expect(port.controls).toEqual([
      { dtr: false, rts: true },
      { rts: false },
      { dtr: true },
      921600
    ])
  })

  it("drops its streams on close and leaves the port open", async () => {
    const port = new QueuedPort()
    const web = new WebSerialPort(port, {})
    await web.open({})
    expect(web.readable).not.toBeNull()
    await web.close()
    expect(web.readable).toBeNull()
    expect(web.writable).toBeNull()
    expect(port.closed).toBe(false)
    await web.open({})
    const locked = web.readable?.getReader()
    await web.close()
    locked?.releaseLock()
  })
})
