import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  coreAnswers,
  defaultEnsureConfig,
  ensureCore,
  selfCommand,
  sendCore,
  socketClient,
  startDetached
} from "../../../core/client.ts"
import { Core } from "../../../core/core.ts"
import { API_VERSION } from "../../../core/protocol.ts"
import { type CoreServer, serveCore } from "../../../core/server.ts"
import { coreLogPath, corePath } from "../../../core/socket.ts"
import { CliError } from "../../../envelope.ts"
import { BOARD, fakeOps } from "./fake-ops.ts"

const dirs: string[] = []
const servers: CoreServer[] = []
const config = { platform: process.platform, sweep_interval_ms: 10 }

function socketIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "qc-"))
  dirs.push(dir)
  return join(dir, ".qualithm", "core.sock")
}

async function serve(path: string, onShutdown = (): void => undefined): Promise<CoreServer> {
  const server = await serveCore(new Core(fakeOps(), "9.9.9", onShutdown), path, config)
  servers.push(server)
  return server
}

/** A server that answers every line with `reply`. */
async function rawServer(path: string, reply: string): Promise<() => void> {
  mkdirSync(join(path, ".."), { recursive: true })
  const server = createServer((socket) => {
    socket.on("data", () => {
      socket.end(reply)
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return () => {
    server.close()
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (s) => s.close()))
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("corePath", () => {
  it("puts the socket in the user's own folder", () => {
    expect(corePath("darwin", "/home/me", "me")).toBe(join("/home/me", ".qualithm", "core.sock"))
  })

  it("names a per-user pipe on Windows", () => {
    expect(corePath("win32", "C:\\Users\\me", "me")).toBe("\\\\.\\pipe\\qualithm-core-me")
  })

  it("defaults to the current user", () => {
    expect(corePath()).toContain("core")
    expect(coreLogPath("/home/me")).toBe(join("/home/me", ".qualithm", "core.log"))
    expect(coreLogPath()).toContain("core.log")
  })
})

describe.skipIf(process.platform === "win32")("serveCore", () => {
  it("is reachable only by the current user", async () => {
    const server = await serve(socketIn())
    expect(statSync(server.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(server.path, "..")).mode & 0o777).toBe(0o700)
  })

  it("answers requests over the socket", async () => {
    const { path } = await serve(socketIn())
    expect(await sendCore(path, { verb: "list" })).toEqual([BOARD])
    expect(await sendCore(path, { verb: "run", code: "print(42)" })).toMatchObject({
      output: "42\n"
    })
  })

  it("answers several requests on one connection", async () => {
    const { path } = await serve(socketIn())
    const { connect } = await import("node:net")
    const replies = await new Promise<string[]>((resolve) => {
      const socket = connect(path)
      let buffer = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        buffer += chunk
        const lines = buffer.split("\n").filter((l) => l !== "")
        if (lines.length === 2) {
          socket.destroy()
          resolve(lines)
        }
      })
      const hello = JSON.stringify({ api: API_VERSION, verb: "hello" })
      socket.write(`${hello}\n${hello}\n`)
    })
    expect(replies.map((r) => (JSON.parse(r) as { ok: boolean }).ok)).toEqual([true, true])
  })

  it("refuses a second core on the same socket", async () => {
    const path = socketIn()
    await serve(path)
    await expect(serve(path)).rejects.toEqual(
      new CliError(`a core is already running on ${path}`, "conflict")
    )
    expect(await coreAnswers(path)).toBe(true)
  })

  it("replaces a socket file no core answers on", async () => {
    const path = socketIn()
    const first = await serve(path)
    // Simulate a crash: the listener goes, the file stays.
    await first.close()
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, "")
    const second = await serve(path)
    expect(await sendCore(second.path, { verb: "hello" })).toMatchObject({ version: "9.9.9" })
  })

  it("stops once its socket file is removed", async () => {
    const server = await serve(socketIn())
    rmSync(server.path)
    await server.closed
    expect(await coreAnswers(server.path)).toBe(false)
  })

  it("stops on a shutdown request", async () => {
    const path = socketIn()
    const server: CoreServer = await serve(path, () => {
      void server.close()
    })
    expect(await sendCore(path, { verb: "shutdown" })).toBeUndefined()
    await server.closed
    expect(await coreAnswers(path)).toBe(false)
  })

  it("passes on an error that isn't a busy socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qc-"))
    dirs.push(dir)
    const path = join(dir, "x".repeat(200), "core.sock")
    await expect(serve(path)).rejects.toThrow()
  })
})

describe.skipIf(process.platform === "win32")("sendCore", () => {
  it("says no core answers when nothing listens", async () => {
    const path = socketIn()
    await expect(sendCore(path, { verb: "hello" })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/^no core answers on /) as unknown
    })
  })

  it("keeps the core's error code", async () => {
    const path = socketIn()
    await serve(path)
    await expect(sendCore(path, { verb: "flash", serialNumber: "" })).rejects.toMatchObject({
      code: "usage"
    })
  })

  it("asks to stop a core that speaks another api", async () => {
    const path = socketIn()
    const close = await rawServer(path, `${JSON.stringify({ api: 99, ok: true, data: 1 })}\n`)
    await expect(sendCore(path, { verb: "hello" })).rejects.toEqual(
      new CliError(
        "the running core is from another qualithm version: run `qualithm core stop`, then try again",
        "conflict"
      )
    )
    expect(await sendCore(path, { verb: "shutdown" })).toBe(1)
    close()
  })

  it("asks to stop a core that refuses this api", async () => {
    const path = socketIn()
    const refusal = { api: 99, ok: false, error: { code: "api_mismatch", message: "no" } }
    const close = await rawServer(path, `${JSON.stringify(refusal)}\n`)
    await expect(sendCore(path, { verb: "hello" })).rejects.toMatchObject({ code: "conflict" })
    close()
  })

  it("asks to stop a core too old to know the verb", async () => {
    const path = socketIn()
    const message = "bad request at verb: Invalid discriminator value. Expected 'hello'"
    const refusal = { api: API_VERSION, ok: false, error: { code: "usage", message } }
    const close = await rawServer(path, `${JSON.stringify(refusal)}\n`)
    await expect(sendCore(path, { verb: "release", serialNumber: "abc" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(
        /^the running core is from another qualithm version/
      ) as unknown
    })
    close()
  })

  it("refuses a reply that isn't json", async () => {
    const path = socketIn()
    const close = await rawServer(path, "nope\n")
    await expect(sendCore(path, { verb: "hello" })).rejects.toThrow(
      /^the qualithm core sent a reply that isn't json/
    )
    close()
  })

  it("fails when the core hangs up without replying", async () => {
    const path = socketIn()
    const close = await rawServer(path, "")
    await expect(sendCore(path, { verb: "hello" })).rejects.toThrow(
      "the qualithm core closed the connection before replying"
    )
    close()
  })
})

describe.skipIf(process.platform === "win32")("ensureCore", () => {
  const wait = {
    wait_ms: 2000,
    poll_ms: 5,
    sleep: async (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  }

  it("uses a running core without starting another", async () => {
    const path = socketIn()
    await serve(path)
    const start = vi.fn()
    expect(await ensureCore(path, { ...wait, start })).toMatchObject({ version: "9.9.9" })
    expect(start).not.toHaveBeenCalled()
  })

  it("starts a core when none answers", async () => {
    const path = socketIn()
    const start = vi.fn((p: string) => {
      void serve(p)
    })
    expect(await ensureCore(path, { ...wait, start })).toMatchObject({ version: "9.9.9" })
    expect(start).toHaveBeenCalledOnce()
  })

  it("leaves one core running when two clients start one at once", async () => {
    const path = socketIn()
    const outcomes: string[] = []
    const start = (p: string): void => {
      serve(p).then(
        () => outcomes.push("served"),
        (error: unknown) => outcomes.push((error as CliError).code)
      )
    }
    const hellos = await Promise.all([
      ensureCore(path, { ...wait, start }),
      ensureCore(path, { ...wait, start })
    ])
    expect(hellos).toHaveLength(2)
    await vi.waitFor(() => {
      expect(outcomes).toHaveLength(2)
    })
    expect(outcomes.sort()).toEqual(["conflict", "served"])
  })

  it("gives up when the core never starts", async () => {
    const path = socketIn()
    await expect(
      ensureCore(path, { ...wait, wait_ms: 20, start: () => undefined })
    ).rejects.toEqual(
      new CliError(`the qualithm core didn't start on ${path} in time`, "unavailable")
    )
  })
})

describe.skipIf(process.platform === "win32")("socketClient", () => {
  const wait = {
    wait_ms: 2000,
    poll_ms: 5,
    sleep: async (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  }

  it("starts the core on first use, then reuses it", async () => {
    const path = socketIn()
    const start = vi.fn((p: string) => {
      void serve(p)
    })
    const client = socketClient(path, { ...wait, start })
    expect(await client.send({ verb: "list" })).toEqual([BOARD])
    expect(await client.send({ verb: "hello" })).toMatchObject({ version: "9.9.9" })
    expect(start).toHaveBeenCalledOnce()
  })

  it("tries to start the core again after a failed start", async () => {
    const path = socketIn()
    let tries = 0
    const start = (p: string): void => {
      tries++
      if (tries > 1) {
        void serve(p)
      }
    }
    const client = socketClient(path, { ...wait, wait_ms: 30, start })
    await expect(client.send({ verb: "list" })).rejects.toMatchObject({ code: "unavailable" })
    expect(await client.send({ verb: "list" })).toEqual([BOARD])
    expect(tries).toBe(2)
  })

  it("defaults to the user's own socket, found on first use", async () => {
    const started: string[] = []
    const client = socketClient(undefined, {
      ...wait,
      wait_ms: 10,
      start: (p) => {
        started.push(p)
      }
    })
    expect(started).toEqual([])
    // Only hello: a core the user is running may answer it, and hello changes nothing.
    await client.send({ verb: "hello" }).catch(() => undefined)
    expect([[], [corePath()]]).toContainEqual(started)
    expect(defaultEnsureConfig.wait_ms).toBeGreaterThan(0)
  })
})

describe("selfCommand", () => {
  it("runs a compiled binary on its own", () => {
    expect(selfCommand("/usr/local/bin/qualithm", "/$bunfs/root/qualithm")).toEqual([
      "/usr/local/bin/qualithm"
    ])
    expect(selfCommand("C:\\qualithm.exe", "B:\\~BUN\\root\\qualithm")).toEqual([
      "C:\\qualithm.exe"
    ])
  })

  it("runs a script through its runtime", () => {
    expect(selfCommand("/usr/bin/bun", "/src/bin/qualithm.ts")).toEqual([
      "/usr/bin/bun",
      "/src/bin/qualithm.ts"
    ])
    expect(selfCommand().length).toBeGreaterThan(0)
  })
})

describe("startDetached", () => {
  it("starts `core run` in the background with its output in the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qc-"))
    dirs.push(dir)
    const script = join(dir, "fake.cjs")
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))\n")
    const log = join(dir, "logs", "core.log")
    const runner = "Deno" in globalThis ? [process.execPath, "run", "-A"] : [process.execPath]
    startDetached("/tmp/core.sock", log, [...runner, script])
    await vi.waitFor(
      () => {
        expect(existsSync(log) && readFileSync(log, "utf8")).toContain("core")
      },
      { timeout: 5000 }
    )
    expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual([
      "core",
      "run",
      "--socket",
      "/tmp/core.sock"
    ])
    if (process.platform !== "win32") {
      expect(statSync(log).mode & 0o777).toBe(0o600)
    }
  })
})
