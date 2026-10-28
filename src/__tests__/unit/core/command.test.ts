import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { type CliIo, run } from "../../../cli.ts"
import { coreAnswers } from "../../../core/client.ts"
import { CORE_USAGE, runCore } from "../../../core/command.ts"
import type { CoreServer } from "../../../core/server.ts"
import { VERSION } from "../../../version.ts"
import { fakeOps } from "./fake-ops.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function socketIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "qc-"))
  dirs.push(dir)
  return join(dir, ".qualithm", "core.sock")
}

type Captured = CliIo & { out: () => string; err: () => string }

function capture(): Captured {
  let out = ""
  let err = ""
  return {
    stdout: (text) => {
      out += text
    },
    stderr: (text) => {
      err += text
    },
    out: () => out,
    err: () => err
  }
}

/** Starts `qualithm core run` in this process and resolves once it listens. */
async function startCore(
  path: string,
  ops = fakeOps()
): Promise<{ io: Captured; server: CoreServer; exited: Promise<number> }> {
  const io = capture()
  let listening: (server: CoreServer) => void = () => undefined
  const ready = new Promise<CoreServer>((resolve) => {
    listening = resolve
  })
  io.core = {
    boardOps: () => ops,
    serve: { platform: process.platform, sweep_interval_ms: 10 },
    onListening: listening
  }
  const exited = run(["core", "run", "--socket", path], io)
  return { io, server: await ready, exited }
}

describe.skipIf(process.platform === "win32")("qualithm core", () => {
  it("runs, reports status and stops, releasing the boards", async () => {
    const path = socketIn()
    const ops = fakeOps()
    const core = await startCore(path, ops)
    expect(core.io.err()).toBe(`qualithm: core ${VERSION} listening on ${path}\n`)

    const status = capture()
    expect(await run(["core", "status", "--socket", path], status)).toBe(0)
    expect(status.out()).toBe(`core ${VERSION} (pid ${String(process.pid)}) on ${path}\n`)

    const json = capture()
    expect(await run(["core", "status", "--socket", path, "--json"], json)).toBe(0)
    expect(JSON.parse(json.out())).toEqual({
      ok: true,
      data: { version: VERSION, pid: process.pid, path }
    })

    const stop = capture()
    expect(await run(["core", "stop", "--socket", path], stop)).toBe(0)
    expect(stop.out()).toBe("core stopped\n")
    expect(await core.exited).toBe(0)
    expect(ops.calls.at(-1)).toBe("close")
    expect(await coreAnswers(path)).toBe(false)
  })

  it("refuses to run a second core", async () => {
    const path = socketIn()
    const first = await startCore(path)
    const second = capture()
    second.core = { boardOps: fakeOps }
    expect(await run(["core", "run", "--socket", path], second)).toBe(5)
    expect(second.err()).toBe(`qualithm: a core is already running on ${path}\n`)
    await first.server.close()
    expect(await first.exited).toBe(0)
  })

  it("stops on a signal", async () => {
    const path = socketIn()
    const core = await startCore(path)
    process.emit("SIGTERM")
    expect(await core.exited).toBe(0)
  })

  it("reports when no core is running", async () => {
    const path = socketIn()
    const status = capture()
    expect(await run(["core", "status", "--socket", path], status)).toBe(8)
    expect(status.err()).toBe(`qualithm: no core is running on ${path}\n`)

    const stop = capture()
    expect(await run(["core", "stop", "--socket", path, "--json"], stop)).toBe(0)
    expect(JSON.parse(stop.out())).toEqual({ ok: true, data: { stopped: false, path } })

    const plain = capture()
    expect(await run(["core", "stop", "--socket", path], plain)).toBe(0)
    expect(plain.out()).toBe("no core is running\n")
  })
})

describe("qualithm core usage", () => {
  it("prints help", async () => {
    const io = capture()
    expect(await runCore(["--help"], io)).toBe(0)
    expect(io.out()).toBe(CORE_USAGE)
    expect(await runCore(["help"], io)).toBe(0)
  })

  it("refuses a missing or unknown verb", async () => {
    const missing = capture()
    expect(await runCore([], missing)).toBe(2)
    expect(missing.err()).toBe(`qualithm: core needs a verb\n\n${CORE_USAGE}`)
    const unknown = capture()
    expect(await runCore(["explode"], unknown)).toBe(2)
    expect(unknown.err()).toContain('unknown command "core explode"')
  })

  it("refuses an unknown flag", async () => {
    const io = capture()
    expect(await runCore(["status", "--nope"], io)).toBe(2)
    expect(io.err()).toMatch(/^qualithm: unknown option '--nope'/)
  })
})
