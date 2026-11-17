import { describe, expect, it } from "vitest"

import { DEVICE_SDK, type LoadedSdk } from "../../board/sdk.ts"
import { type CliIo, run } from "../../cli.ts"
import { BOARD_USAGE, runBoard } from "../../commands/boards.ts"
import type { BoardOps } from "../../core/boards.ts"
import { type CoreClient, StaleCoreError } from "../../core/client.ts"
import { Core } from "../../core/core.ts"
import { API_VERSION } from "../../core/protocol.ts"
import type { LogPage } from "../../core/taps.ts"
import { CliError, type ErrorCode } from "../../envelope.ts"
import { callTool } from "../../mcp.ts"
import { boardTools, consoleExchange } from "../../tools/boards.ts"
import { boardDecisions } from "../../tools/receipt.ts"
import type { Tool } from "../../tools/tool.ts"
import { fakeOps } from "./core/fake-ops.ts"
import { fakeSession } from "./provision.test.ts"

/** A client that hands requests straight to an in-process core. */
function clientOf(ops: BoardOps): CoreClient & { sent: string[] } {
  const core = new Core(ops, "9.9.9", () => undefined)
  const sent: string[] = []
  return {
    sent,
    send: async (request) => {
      sent.push(request.verb)
      const reply = await core.handle(JSON.stringify({ api: API_VERSION, ...request }))
      if (!reply.ok) {
        throw new CliError(reply.error.message, reply.error.code as ErrorCode)
      }
      return reply.data
    }
  }
}

/** `client` until `served` requests in, when its core turns out to be from another version. */
function staleAfter(served: number, client: CoreClient): CoreClient & { sent: () => number } {
  let sent = 0
  return {
    sent: () => sent,
    send: async (request) => {
      sent++
      if (sent > served) {
        throw new StaleCoreError()
      }
      return client.send(request)
    }
  }
}

/** Board ops whose logs replay `pages` in turn, then stay quiet. */
function consoleOps(pages: string[][]): ReturnType<typeof fakeOps> {
  const ops = fakeOps()
  let seq = 0
  let served = 0
  ops.logs = async (_serial, after, waitMs) => {
    const texts = after >= seq && served < pages.length ? (pages[served++] ?? []) : []
    if (texts.length === 0 && waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5)))
    }
    const chunks = texts.map((text) => ({ seq: ++seq, at_ms: 0, text }))
    const page: LogPage = {
      board: { port: "/dev/cu.pico", serialNumber: "abc" },
      chunks,
      next: Math.max(after, seq),
      more: false
    }
    return Promise.resolve(page)
  }
  return ops
}

/** The device SDK a test deploy sends: this CLI's release, with no files to download. */
const noSdkFiles = async (): Promise<LoadedSdk> =>
  Promise.resolve({ version: DEVICE_SDK.version, files: [] })

const tool = (client: CoreClient, name: string): Tool => {
  const found = boardTools(client, { sdk: noSdkFiles }).find((t) => t.name === name)
  if (found === undefined) {
    throw new Error(`no tool ${name}`)
  }
  return found
}

const noSession = (): never => {
  throw new Error("no session")
}

type Captured = CliIo & { out: () => string; err: () => string }

function capture(board: CliIo["board"]): Captured {
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
    err: () => err,
    ...(board === undefined ? {} : { board: { sdk: noSdkFiles, ...board } })
  }
}

describe("board tools", () => {
  it("are local, so they run without a platform session", async () => {
    const client = clientOf(fakeOps())
    for (const t of boardTools(client)) {
      expect(t.local).toBe(true)
    }
    expect(await callTool(tool(client, "list_boards"), noSession, {})).toMatchObject({
      ok: true,
      data: [{ state: "micropython", serialNumber: "abc" }]
    })
  })

  it("flash, reset and read logs through the core", async () => {
    const ops = fakeOps()
    const client = clientOf(ops)
    expect(
      await callTool(tool(client, "flash_board"), noSession, { serialNumber: "abc" })
    ).toMatchObject({
      ok: true,
      data: { version: "1.29.0", decisions: boardDecisions({ firmware: "1.29.0" }) }
    })
    expect(await callTool(tool(client, "reset_board"), noSession, {})).toMatchObject({
      ok: true,
      data: { port: "/dev/cu.pico" }
    })
    expect(
      await callTool(tool(client, "board_logs"), noSession, { after: 2, waitMs: 5 })
    ).toMatchObject({ ok: true, data: { next: 3 } })
    expect(await callTool(tool(client, "board_logs"), noSession, {})).toMatchObject({ ok: true })
    expect(ops.calls).toEqual([
      "flash:start:abc",
      "flash:end",
      "reset:-",
      "logs:-:2:5:1000",
      "logs:-:0:0:1000"
    ])
  })

  it("name the board a dry run would act on, touching nothing", async () => {
    const ops = fakeOps()
    const client = clientOf(ops)
    for (const name of ["flash_board", "reset_board", "board_console"]) {
      const result = await callTool(tool(client, name), noSession, {
        dryRun: true,
        input: "x"
      })
      expect(result).toMatchObject({
        ok: true,
        dryRun: true,
        data: { board: { port: "/dev/cu.pico" } }
      })
    }
    expect(ops.calls).toEqual([])
  })

  it("type into the console and return only what followed", async () => {
    const ops = consoleOps([["old", "stuff"], [], ["print(1)\r\n", "1\r\n"], [">>> "]])
    const client = clientOf(ops)
    const result = await callTool(tool(client, "board_console"), noSession, {
      input: "print(1)\r",
      waitMs: 50
    })
    expect(result).toMatchObject({
      ok: true,
      data: { output: "print(1)\r\n1\r\n>>> ", next: 5, board: { serialNumber: "abc" } }
    })
    expect(ops.calls).toEqual(["write:-:print(1)\r"])
  })

  it("skip every page of old output before typing", async () => {
    const ops = consoleOps([])
    let calls = 0
    ops.logs = async (_s, after) => {
      calls++
      const more = calls === 1
      return Promise.resolve({ board: { port: "/p" }, chunks: [], next: after + 10, more })
    }
    const reply = await consoleExchange(clientOf(ops), "abc", "x", 1)
    expect(reply.next).toBeGreaterThanOrEqual(20)
    expect(ops.calls).toEqual(["write:abc:x\r\n"])
  })

  it("sends input that ends with a control character unchanged", async () => {
    const ops = consoleOps([])
    await consoleExchange(clientOf(ops), "abc", "\u0003", 1)
    expect(ops.calls).toEqual(["write:abc:\u0003"])
  })
})

async function projectDir(): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "proj-"))
  await writeFile(join(dir, "main.py"), "print(1)")
  return dir
}

describe("deploy", () => {
  it("sends the project's files to the core", async () => {
    const ops = fakeOps()
    const dir = await projectDir()
    const result = await callTool(tool(clientOf(ops), "deploy_project"), noSession, { dir })
    expect(result).toMatchObject({
      ok: true,
      data: { written: ["/main.py"], decisions: boardDecisions({ sdk: DEVICE_SDK.version }) }
    })
    expect(ops.calls).toEqual(["probe:-", `deploy:-:/main.py:${DEVICE_SDK.version}:false`])
  })

  it("sends the device SDK this CLI loads with the project, and names its release", async () => {
    const ops = fakeOps()
    const dir = await projectDir()
    const sdk = async (): Promise<LoadedSdk> =>
      Promise.resolve({
        version: "7.7.7",
        files: [{ path: "/lib/qualithm_device/pico.mpy", bytes: new Uint8Array([0x4d]) }]
      })
    const deploy = boardTools(clientOf(ops), { sdk }).find((t) => t.name === "deploy_project")
    if (deploy === undefined) {
      throw new Error("no deploy tool")
    }
    const result = await callTool(deploy, noSession, { dir })
    expect(ops.calls).toEqual([
      "probe:-",
      "deploy:-:/main.py,/lib/qualithm_device/pico.mpy:7.7.7:false"
    ])
    expect(result).toMatchObject({
      ok: true,
      data: { decisions: boardDecisions({ sdk: "7.7.7" }) }
    })
  })

  it("prints what it wrote, or would write", async () => {
    const ops = fakeOps()
    const dir = await projectDir()
    const c = capture({ client: clientOf(ops) })
    const code = await run(["deploy", dir, "--serial", "abc"], c)
    expect(c.err()).toBe("")
    expect(code).toBe(0)
    expect(c.out()).toBe(
      "write  /main.py\ndeployed to abc on /dev/cu.pico: 1 written, 0 removed, 0 unchanged; restarted\n" +
        "\nDecided for this deploy\n" +
        `Qualithm Device SDK  ${DEVICE_SDK.version}  https://docs.qualithm.com/micropython#the-device-sdk\n`
    )
    ops.deploy = async () =>
      Promise.resolve({
        board: { port: "/Volumes/RP2350" },
        written: ["/main.py"],
        removed: ["/old.py"],
        unchanged: 2,
        flashed: "1.29.0"
      })
    const dry = capture({ client: clientOf(ops) })
    expect(await run(["deploy", dir, "--dry-run"], dry)).toBe(0)
    expect(dry.out()).toBe(
      "would flash MicroPython 1.29.0 first\nwould write  /main.py\nwould remove /old.py\ndry-run: 2 change(s), 2 file(s) already match\n"
    )
    expect(ops.calls[1]).toBe(`deploy:abc:/main.py:${DEVICE_SDK.version}:false`)
  })

  it("deploys the current folder by default and names a missing one", async () => {
    const c = capture({ client: clientOf(fakeOps()) })
    expect(await run(["board", "deploy", "/no/such/project", "--json"], c)).toBe(4)
    expect(JSON.parse(c.out())).toMatchObject({ ok: false, code: "not_found" })
  })
})

describe("deploy provisioning", () => {
  const wifi = { ssid: "Home", passphrase: "pw" }
  const deployTool = (client: CoreClient, network = "Home"): Tool => {
    const found = boardTools(client, {
      wifi: async (named) => Promise.resolve({ ...wifi, ssid: named ?? network }),
      lookup: { networks: async () => Promise.resolve([network]) },
      sdk: noSdkFiles
    }).find((t) => t.name === "deploy_project")
    if (found === undefined) {
      throw new Error("no deploy tool")
    }
    return found
  }

  it("claims a new board: a fresh code, Wi-Fi and the API's URL, never echoed back", async () => {
    const ops = fakeOps()
    ops.state = { blank: true, credential: false, claimCode: false }
    const created: unknown[] = []
    const session = fakeSession([{ id: "spc_1", name: "Lab" }], created)
    const result = await callTool(deployTool(clientOf(ops)), () => session, {
      dir: await projectDir()
    })
    expect(ops.setups).toEqual([
      { provisioningUrl: "https://api.example.com", claimCode: "qmc_new.code", wifi }
    ])
    expect(result).toMatchObject({
      ok: true,
      data: { provisioned: { scopeId: "spc_1", wifiNetwork: "Home" } }
    })
    expect(JSON.stringify(result)).not.toContain("pw")
    expect(JSON.stringify(result)).not.toContain("qmc_new")
    expect(created).toHaveLength(1)
  })

  it("keeps the Wi-Fi a board's setup file already names", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: true, wifiNetwork: "Cafe" }
    const session = fakeSession([{ id: "spc_1", name: "Lab" }])
    const result = await callTool(deployTool(clientOf(ops)), () => session, {
      dir: await projectDir()
    })
    expect(ops.setups).toEqual([
      { provisioningUrl: "https://api.example.com", claimCode: "qmc_new.code" }
    ])
    expect(result).toMatchObject({ data: { provisioned: { wifiNetwork: "Cafe" } } })
  })

  it("uses a named network and scope", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false, wifiNetwork: "Cafe" }
    const session = fakeSession([])
    const result = await callTool(deployTool(clientOf(ops)), () => session, {
      dir: await projectDir(),
      scopeId: "spc_named",
      wifiNetwork: "Other"
    })
    expect(result).toMatchObject({
      data: { provisioned: { scopeId: "spc_named", wifiNetwork: "Other" } }
    })
  })

  it("plans a claim on a dry run without creating a code or reading a passphrase", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false }
    const created: unknown[] = []
    const session = fakeSession([{ id: "spc_1", name: "Lab" }], created)
    const result = await callTool(deployTool(clientOf(ops)), () => session, {
      dir: await projectDir(),
      dryRun: true
    })
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      data: { provisioned: { scopeId: "spc_1", wifiNetwork: "Home" } }
    })
    expect(created).toEqual([])
    expect(ops.setups).toEqual([undefined])
  })

  it("leaves a claimed board alone and needs no platform", async () => {
    const ops = fakeOps()
    const result = await callTool(deployTool(clientOf(ops)), noSession, { dir: await projectDir() })
    expect(result).toMatchObject({ ok: true })
    expect(result.data).not.toHaveProperty("provisioned")
  })

  it("reports a missing token as the deploy's error", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false }
    const result = await callTool(deployTool(clientOf(ops)), noSession, { dir: await projectDir() })
    expect(result).toMatchObject({
      ok: false,
      code: "auth",
      message: "the board isn't claimed yet, and claiming it needs the platform: no session"
    })
    const scopeless = await callTool(deployTool(clientOf(ops)), () => fakeSession([]), {
      dir: await projectDir()
    })
    expect(scopeless).toMatchObject({ ok: false, code: "not_found" })
  })

  it("asks at the terminal through qualithm deploy, and prints what it chose", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false }
    const answers = ["typed-pass"]
    const c = capture({
      client: clientOf(ops),
      newSession: () => () => fakeSession([{ id: "spc_1", name: "Lab" }]),
      wifiLookup: {
        networks: async () => Promise.resolve(["Home"]),
        passphrase: async () => Promise.resolve(undefined)
      },
      ask: {
        line: async (_q, fallback) => Promise.resolve(fallback),
        secret: async () => Promise.resolve(answers.shift() ?? "")
      }
    })
    const dir = await projectDir()
    expect(await run(["deploy", dir, "--wifi", "Named", "--scope", "spc_9"], c)).toBe(0)
    expect(ops.setups).toEqual([
      {
        provisioningUrl: "https://api.example.com",
        claimCode: "qmc_new.code",
        wifi: { ssid: "Named", passphrase: "typed-pass" }
      }
    ])
    expect(c.out()).toContain("set the board to claim itself into scope spc_9 on Wi-Fi Named")
  })
})

describe("qualithm board", () => {
  it("lists boards as a table, or as json", async () => {
    const ops = fakeOps()
    ops.list = async () =>
      Promise.resolve([
        { state: "micropython", port: "/dev/cu.pico", serialNumber: "abc" },
        { state: "micropython", port: "/dev/cu.anon" },
        { state: "bootsel", drive: "/Volumes/RP2350" },
        { state: "bootsel", drive: "/Volumes/RP2350 1", serialNumber: "A6AFD22C8A7C3EF8" }
      ])
    const c = capture({ client: clientOf(ops) })
    expect(await run(["board", "list"], c)).toBe(0)
    expect(c.out()).toContain("STATE")
    expect(c.out()).toMatch(/micropython\s+abc\s+\/dev\/cu\.pico/)
    expect(c.out()).toMatch(/micropython\s+-\s+\/dev\/cu\.anon/)
    expect(c.out()).toMatch(/bootsel\s+-\s+\/Volumes\/RP2350/)
    expect(c.out()).toMatch(/bootsel\s+A6AFD22C8A7C3EF8\s+\/Volumes\/RP2350 1/)
    const j = capture({ client: clientOf(ops) })
    expect(await run(["board", "list", "--json"], j)).toBe(0)
    const listed = JSON.parse(j.out()) as { ok: boolean; data: unknown[] }
    expect(listed.ok).toBe(true)
    expect(listed.data[0]).toMatchObject({ serialNumber: "abc" })
  })

  it("shows the SDK on record for each board and which a deploy would update", async () => {
    const ops = fakeOps()
    ops.list = async () =>
      Promise.resolve([
        { state: "micropython", port: "/dev/cu.pico", serialNumber: "abc", sdk: "0.8.0" },
        {
          state: "micropython",
          port: "/dev/cu.c3",
          serialNumber: "def",
          sdk: DEVICE_SDK.version
        },
        { state: "micropython", port: "/dev/cu.new", serialNumber: "ghi" }
      ])
    const c = capture({ client: clientOf(ops) })
    expect(await run(["board", "list"], c)).toBe(0)
    expect(c.out()).toMatch(/STATE\s+SERIAL\s+WHERE\s+SDK/)
    expect(c.out()).toMatch(/abc\s+\/dev\/cu\.pico\s+0\.8\.0/)
    expect(c.out()).toMatch(/ghi\s+\/dev\/cu\.new\s+-/)
    expect(c.out()).toContain(
      `abc holds Qualithm Device SDK 0.8.0: deploy its project again to install ${DEVICE_SDK.version}\n`
    )
    expect(c.out()).not.toContain("def holds")
    const j = capture({ client: clientOf(ops) })
    expect(await run(["board", "list", "--json"], j)).toBe(0)
    const listed = JSON.parse(j.out()) as { data: Record<string, unknown>[] }
    expect(listed.data[0]).toMatchObject({ sdk: "0.8.0", sdkCurrent: false })
    expect(listed.data[1]).toMatchObject({ sdk: DEVICE_SDK.version, sdkCurrent: true })
    expect(listed.data[2]).not.toHaveProperty("sdkCurrent")
  })

  it("says when no board is plugged in", async () => {
    const ops = fakeOps()
    ops.list = async () => Promise.resolve([])
    const c = capture({ client: clientOf(ops) })
    expect(await run(["board", "list"], c)).toBe(0)
    expect(c.out()).toBe("no boards plugged in\n")
  })

  it("flashes, resets and prints logs", async () => {
    const ops = fakeOps()
    const flash = capture({ client: clientOf(ops) })
    expect(await run(["board", "flash", "--serial", "abc"], flash)).toBe(0)
    expect(flash.out()).toBe(
      "flashed MicroPython 1.29.0 onto abc on /dev/cu.pico\n" +
        "\nDecided for this flash\n" +
        "MicroPython  1.29.0  https://docs.qualithm.com/micropython#the-micropython-release\n"
    )
    const reset = capture({ client: clientOf(ops) })
    expect(await run(["board", "reset"], reset)).toBe(0)
    expect(reset.out()).toBe("reset abc on /dev/cu.pico, running again\n")
    const logs = capture({ client: clientOf(ops) })
    expect(await run(["board", "logs", "--after", "7"], logs)).toBe(0)
    expect(logs.out()).toBe(">>> ")
    expect(ops.calls.at(-1)).toBe("logs:-:7:0:1000")
  })

  it("names the board a dry run would act on", async () => {
    const ops = fakeOps()
    ops.list = async () => Promise.resolve([{ state: "bootsel", drive: "/Volumes/RP2350" }])
    const c = capture({ client: clientOf(ops) })
    expect(await run(["board", "flash", "--dry-run"], c)).toBe(0)
    expect(c.out()).toBe("dry-run: would flash BOOTSEL drive /Volumes/RP2350\n")
    const r = capture({ client: clientOf(fakeOps()) })
    expect(await run(["board", "reset", "--dry-run"], r)).toBe(0)
    expect(r.out()).toBe("dry-run: would reset abc on /dev/cu.pico\n")
  })

  it("releases a board for another program and reconnects it, by its serial number", async () => {
    const ops = fakeOps()
    const released = capture({ client: clientOf(ops) })
    expect(await run(["board", "release", "--serial", "abc"], released)).toBe(0)
    expect(released.out()).toBe(
      "released abc: another program can use it until qualithm board reconnect --serial abc\n"
    )
    const back = capture({ client: clientOf(ops) })
    expect(await run(["board", "reconnect", "--serial", "abc", "--json"], back)).toBe(0)
    expect(JSON.parse(back.out())).toMatchObject({ ok: true, data: { serialNumber: "abc" } })
    const human = capture({ client: clientOf(ops) })
    expect(await run(["board", "reconnect", "--serial", "abc"], human)).toBe(0)
    expect(human.out()).toBe("reconnected abc\n")
    expect(ops.calls).toEqual(["release:abc", "reconnect:abc", "reconnect:abc"])
    const dry = capture({ client: clientOf(ops) })
    expect(await run(["board", "release", "--serial", "abc", "--dry-run"], dry)).toBe(0)
    expect(dry.out()).toBe("dry-run: would release abc\n")
    const dryBack = capture({ client: clientOf(ops) })
    expect(await run(["board", "reconnect", "--serial", "abc", "--dry-run"], dryBack)).toBe(0)
    expect(dryBack.out()).toBe("dry-run: would reconnect abc\n")
    expect(ops.calls).toHaveLength(3)
    const unnamed = capture({ client: clientOf(ops) })
    expect(await run(["board", "release"], unnamed)).toBe(2)
    expect(unnamed.err()).toBe(
      "qualithm: board release needs --serial: name the board by its serial number\n"
    )
  })

  it("reports a failure with its exit code", async () => {
    const ops = fakeOps()
    ops.fail = new CliError("no board found", "not_found")
    const c = capture({ client: clientOf(ops) })
    expect(await run(["board", "reset"], c)).toBe(4)
    expect(c.err()).toBe("qualithm: no board found\n")
    const j = capture({ client: clientOf(ops) })
    expect(await run(["board", "reset", "--json"], j)).toBe(4)
    expect(JSON.parse(j.out())).toMatchObject({ ok: false, code: "not_found" })
  })

  it("types console input and prints the answer", async () => {
    const ops = consoleOps([[], ["2\r\n"]])
    const c = capture({ client: clientOf(ops) })
    expect(await run(["board", "console", "--input", "1+1\r", "--wait", "30"], c)).toBe(0)
    expect(c.out()).toBe("2\r\n")
  })

  it("follows logs until stopped", async () => {
    const ops = consoleOps([["boot\r\n"], ["tick\r\n"]])
    const controller = new AbortController()
    const c = capture({ client: clientOf(ops), signal: controller.signal })
    setTimeout(() => {
      controller.abort()
    }, 30)
    expect(await run(["board", "logs", "-f", "--serial", "abc"], c)).toBe(0)
    expect(c.out()).toBe("boot\r\ntick\r\n")
  })

  it("keeps following while the board restarts", async () => {
    const ops = consoleOps([["before\r\n"], ["after\r\n"]])
    const { logs } = ops
    let calls = 0
    ops.logs = async (...args) => {
      calls++
      if (calls === 2) {
        throw new CliError("no board found", "not_found")
      }
      return logs(...args)
    }
    const controller = new AbortController()
    const c = capture({ client: clientOf(ops), signal: controller.signal })
    setTimeout(() => {
      controller.abort()
    }, 400)
    expect(await run(["board", "logs", "-f"], c)).toBe(0)
    expect(c.out()).toBe("before\r\nafter\r\n")
  })

  it("stops following on a failure it can't ride out", async () => {
    const ops = fakeOps()
    ops.logs = async () => Promise.reject(new Error("boom"))
    const c = capture({ client: clientOf(ops), signal: new AbortController().signal })
    expect(await run(["board", "logs", "-f"], c)).toBe(1)
    expect(c.err()).toBe("qualithm: boom\n")
  })

  it("rides out a board restarting, being flashed or briefly unplugged", async () => {
    const ops = consoleOps([["before\r\n"], ["after\r\n"]])
    const { logs } = ops
    const refusals = [
      new CliError("no board found", "not_found"),
      new CliError("the board is busy with a flash, reset or run: try again", "conflict"),
      new CliError("the board on /dev/cu.pico disconnected", "unavailable")
    ]
    const controller = new AbortController()
    let calls = 0
    ops.logs = async (...args) => {
      calls++
      const refusal = calls === 1 ? undefined : refusals.shift()
      if (refusal !== undefined) {
        throw refusal
      }
      if (calls > 1) {
        controller.abort()
      }
      return logs(...args)
    }
    const c = capture({ client: clientOf(ops), signal: controller.signal })
    expect(await run(["board", "logs", "-f"], c)).toBe(0)
    expect(c.out()).toBe("before\r\nafter\r\n")
    expect(calls).toBe(5)
  })

  it("stops following a core from another version, saying how to fix it", async () => {
    const client = staleAfter(1, clientOf(consoleOps([["boot\r\n"]])))
    const c = capture({ client, signal: new AbortController().signal })
    expect(await run(["board", "logs", "-f"], c)).toBe(5)
    expect(c.out()).toBe("boot\r\n")
    expect(c.err()).toBe(
      "qualithm: the running core is from another qualithm version: run `qualithm core stop`, then try again\n"
    )
    expect(client.sent()).toBe(2)
    const j = capture({
      client: staleAfter(0, clientOf(fakeOps())),
      signal: new AbortController().signal
    })
    expect(await run(["board", "logs", "-f", "--json"], j)).toBe(5)
    expect(JSON.parse(j.out())).toMatchObject({ ok: false, code: "conflict" })
  })

  it("runs an interactive console until Ctrl-] and stops reading", async () => {
    const ops = consoleOps([[">>> "], ["print(2)\r\n2\r\n>>> "]])
    async function* keys(): AsyncGenerator<Uint8Array | string> {
      yield "print(2)"
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield new Uint8Array([0x0d, 0x1d, 0x61])
    }
    const c = capture({ client: clientOf(ops), stdin: keys() })
    expect(await run(["board", "console", "--serial", "abc"], c)).toBe(0)
    expect(ops.calls).toEqual(["write:abc:print(2)", "write:abc:\r"])
    expect(c.out()).toContain(">>> ")
    expect(c.err()).toBe(
      "qualithm: connected; press Enter for a prompt, Ctrl-] leaves\n\nqualithm: left the console\n"
    )
  })

  it("leaves the console when stopped", async () => {
    const ops = consoleOps([])
    const controller = new AbortController()
    async function* keys(): AsyncGenerator<string> {
      await Promise.resolve()
      yield "a"
      controller.abort()
      yield "b"
      yield "c"
    }
    const c = capture({ client: clientOf(ops), stdin: keys(), signal: controller.signal })
    expect(await run(["board", "console"], c)).toBe(0)
    expect(ops.calls).toEqual(["write:-:a", "write:-:b"])
  })

  it("leaves the console once stopped, without waiting for a key", async () => {
    const ops = consoleOps([])
    const controller = new AbortController()
    let type = (): void => undefined
    const idle = new Promise<void>((resolve) => {
      type = resolve
    })
    async function* keys(): AsyncGenerator<string> {
      await idle
      yield "x"
    }
    const c = capture({ client: clientOf(ops), stdin: keys(), signal: controller.signal })
    setTimeout(() => {
      controller.abort()
    }, 20)
    expect(await run(["board", "console"], c)).toBe(0)
    type()
    expect(ops.calls).toEqual([])
    expect(c.err()).toBe(
      "qualithm: connected; press Enter for a prompt, Ctrl-] leaves\n\nqualithm: left the console\n"
    )
  })

  it("leaves the console without waiting for a key when its core is from another version", async () => {
    const ops = consoleOps([[">>> "]])
    let type = (): void => undefined
    const idle = new Promise<void>((resolve) => {
      type = resolve
    })
    async function* keys(): AsyncGenerator<string> {
      await idle
      yield "x"
    }
    const c = capture({
      client: staleAfter(2, clientOf(ops)),
      stdin: keys(),
      signal: new AbortController().signal
    })
    expect(await run(["board", "console"], c)).toBe(5)
    type()
    expect(ops.calls).toEqual([])
    expect(c.err()).toBe(
      "qualithm: connected; press Enter for a prompt, Ctrl-] leaves\n" +
        "qualithm: the running core is from another qualithm version: run `qualithm core stop`, then try again\n"
    )
  })

  it("refuses an interactive console with --json", async () => {
    const c = capture({ client: clientOf(fakeOps()) })
    expect(await run(["board", "console", "--json"], c)).toBe(2)
    expect(JSON.parse(c.out())).toMatchObject({ ok: false, code: "usage" })
  })

  it("prints help and refuses unknown verbs and flags", async () => {
    const help = capture(undefined)
    expect(await runBoard(["--help"], help)).toBe(0)
    expect(help.out()).toBe(BOARD_USAGE)
    expect(await runBoard(["help"], help)).toBe(0)
    const none = capture(undefined)
    expect(await runBoard([], none)).toBe(2)
    expect(none.err()).toBe(`qualithm: board needs a verb\n\n${BOARD_USAGE}`)
    const unknown = capture(undefined)
    expect(await runBoard(["explode"], unknown)).toBe(2)
    expect(unknown.err()).toContain('unknown command "board explode"')
    const flag = capture(undefined)
    expect(await runBoard(["list", "--nope"], flag)).toBe(2)
    expect(flag.err()).toMatch(/^qualithm: unknown option '--nope'/)
    const bad = capture({ client: clientOf(fakeOps()) })
    expect(await runBoard(["logs", "--after", "x"], bad)).toBe(2)
    expect(bad.err()).toBe("qualithm: --after must be a whole number\n")
  })
})

describe("virtual deploy", () => {
  const virtualOf = (dir: string): string =>
    `virtual:${(dir.split("/").at(-1) ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`

  it("claims a new virtual device with no Wi-Fi, named after its folder", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false }
    const created: unknown[] = []
    const dir = await projectDir()
    const result = await callTool(
      tool(clientOf(ops), "deploy_project"),
      () => fakeSession([{ id: "spc_1", name: "Lab" }], created),
      { dir, virtual: true }
    )
    expect(ops.calls).toEqual([
      `probe:${virtualOf(dir)}`,
      `deploy:${virtualOf(dir)}:/main.py:${DEVICE_SDK.version}:false`
    ])
    expect(ops.setups).toEqual([
      { provisioningUrl: "https://api.example.com", claimCode: "qmc_new.code" }
    ])
    expect(result).toMatchObject({ ok: true, data: { provisioned: { scopeId: "spc_1" } } })
    expect(result.data).not.toHaveProperty("provisioned.wifiNetwork")
    expect(created).toHaveLength(1)
  })

  it("plans the claim on a dry run without creating a code", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false }
    const created: unknown[] = []
    const result = await callTool(
      tool(clientOf(ops), "deploy_project"),
      () => fakeSession([{ id: "spc_1", name: "Lab" }], created),
      { dir: await projectDir(), virtual: true, dryRun: true }
    )
    expect(result).toMatchObject({ ok: true, data: { provisioned: { scopeId: "spc_1" } } })
    expect(created).toEqual([])
    expect(ops.setups).toEqual([undefined])
  })

  it("redeploys a claimed virtual device without the platform", async () => {
    const ops = fakeOps()
    const result = await callTool(tool(clientOf(ops), "deploy_project"), noSession, {
      dir: await projectDir(),
      virtual: true
    })
    expect(result).toMatchObject({ ok: true })
    expect(result.data).not.toHaveProperty("provisioned")
    expect(ops.setups).toEqual([undefined])
  })

  it("says claiming a new virtual device needs the platform", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false }
    const result = await callTool(tool(clientOf(ops), "deploy_project"), noSession, {
      dir: await projectDir(),
      virtual: true
    })
    expect(result).toMatchObject({ ok: false, code: "auth" })
  })

  it("refuses a serial number or Wi-Fi network for a virtual device", async () => {
    for (const extra of [{ serialNumber: "abc" }, { wifiNetwork: "Home" }]) {
      const result = await callTool(tool(clientOf(fakeOps()), "deploy_project"), noSession, {
        dir: await projectDir(),
        virtual: true,
        ...extra
      })
      expect(result).toMatchObject({ ok: false, code: "usage" })
    }
  })

  it("prints what qualithm deploy --virtual did and how to follow it", async () => {
    const ops = fakeOps()
    ops.state = { blank: false, credential: false, claimCode: false }
    const dir = await projectDir()
    const serial = virtualOf(dir)
    ops.deploy = async () =>
      Promise.resolve({
        board: { port: "/data/virtual/x", serialNumber: serial },
        written: ["/main.py"],
        removed: [],
        unchanged: 0
      })
    const c = capture({
      client: clientOf(ops),
      newSession: () => () => fakeSession([{ id: "spc_1", name: "Lab" }])
    })
    expect(await run(["deploy", dir, "--virtual"], c)).toBe(0)
    expect(c.out()).toBe(
      [
        "set the virtual device to claim itself into scope spc_1",
        "write  /main.py",
        `deployed to ${serial} on /data/virtual/x: 1 written, 0 removed, 0 unchanged; restarted`,
        `follow its output: qualithm board logs --serial ${serial} -f`,
        "",
        "Decided for this deploy",
        `Qualithm Device SDK  ${DEVICE_SDK.version}  https://docs.qualithm.com/micropython#the-device-sdk`,
        "Scope                spc_1  https://docs.qualithm.com/scopes#add-a-device-to-a-scope",
        ""
      ].join("\n")
    )
  })
})
