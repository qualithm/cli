import { describe, expect, it, vi } from "vitest"

import { Core } from "../../../core/core.ts"
import { API_VERSION, BadRequestError, parseRequest } from "../../../core/protocol.ts"
import { BOARD, fakeOps, NOT_FOUND } from "./fake-ops.ts"

const line = (request: object): string => JSON.stringify({ api: API_VERSION, ...request })

describe("parseRequest", () => {
  it("reads a known verb", () => {
    expect(parseRequest(line({ verb: "run", code: "print(1)" }))).toEqual({
      api: API_VERSION,
      verb: "run",
      code: "print(1)"
    })
  })

  it("refuses a line that isn't json", () => {
    expect(() => parseRequest("{")).toThrow(new BadRequestError("request is not json"))
  })

  it("names the field a request gets wrong", () => {
    expect(() => parseRequest(line({ verb: "run" }))).toThrow(/^bad request at code: /)
  })

  it("refuses an unknown verb", () => {
    expect(() => parseRequest(line({ verb: "explode" }))).toThrow(/^bad request at verb: /)
  })

  it("refuses a value that isn't an object", () => {
    expect(() => parseRequest("3")).toThrow(/^bad request: /)
  })
})

describe("Core", () => {
  const core = (ops = fakeOps(), onShutdown = (): void => undefined): Core =>
    new Core(ops, "9.9.9", onShutdown)

  it("says hello with its version and pid", async () => {
    expect(await core().handle(line({ verb: "hello" }))).toEqual({
      api: API_VERSION,
      ok: true,
      data: { version: "9.9.9", pid: process.pid }
    })
  })

  it("refuses another api version", async () => {
    const reply = await core().handle(JSON.stringify({ api: API_VERSION + 1, verb: "hello" }))
    expect(reply).toMatchObject({ ok: false, error: { code: "api_mismatch" } })
  })

  it("shuts down for a client of any api version", async () => {
    const onShutdown = vi.fn()
    const reply = await core(fakeOps(), onShutdown).handle(
      JSON.stringify({ api: API_VERSION + 1, verb: "shutdown" })
    )
    expect(reply).toEqual({ api: API_VERSION, ok: true })
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledOnce()
    })
  })

  it("answers a bad request with a usage error", async () => {
    expect(await core().handle("nope")).toEqual({
      api: API_VERSION,
      ok: false,
      error: { code: "usage", message: "request is not json" }
    })
  })

  it("lists the boards", async () => {
    expect(await core().handle(line({ verb: "list" }))).toMatchObject({ ok: true, data: [BOARD] })
  })

  it("passes the board and code through to each verb", async () => {
    const ops = fakeOps()
    const c = core(ops)
    await c.handle(line({ verb: "flash", serialNumber: "abc" }))
    await c.handle(line({ verb: "reset" }))
    const ran = await c.handle(line({ verb: "run", serialNumber: "abc", code: "print(42)" }))
    expect(ran).toMatchObject({ ok: true, data: { output: "42\n" } })
    expect(ops.calls).toEqual(["flash:start:abc", "flash:end", "reset:-", "run:abc:print(42)"])
  })

  it("keeps a verb's error code", async () => {
    const ops = fakeOps()
    ops.fail = NOT_FOUND
    expect(await core(ops).handle(line({ verb: "reset" }))).toEqual({
      api: API_VERSION,
      ok: false,
      error: { code: "not_found", message: "no board found" }
    })
  })

  it("reports an unexpected failure as an error", async () => {
    const ops = fakeOps()
    ops.fail = new Error("boom")
    expect(await core(ops).handle(line({ verb: "run", code: "x" }))).toMatchObject({
      ok: false,
      error: { code: "error", message: "boom" }
    })
  })

  it("runs board verbs one at a time", async () => {
    const ops = fakeOps()
    ops.flash_ms = 20
    const c = core(ops)
    await Promise.all([c.handle(line({ verb: "flash" })), c.handle(line({ verb: "reset" }))])
    expect(ops.calls).toEqual(["flash:start:-", "flash:end", "reset:-"])
  })

  it("carries on after a verb fails", async () => {
    const ops = fakeOps()
    ops.flash_ms = 10
    ops.fail = new Error("boom")
    const c = core(ops)
    const first = c.handle(line({ verb: "flash" }))
    const second = c.handle(line({ verb: "flash" }))
    expect(await first).toMatchObject({ ok: false })
    expect(await second).toMatchObject({ ok: false })
    expect(ops.calls).toEqual(["flash:start:-", "flash:fail", "flash:start:-", "flash:fail"])
  })
})
