import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import type { ProjectFile } from "../../../board/sync.ts"
import {
  defaultVirtualOps,
  isVirtual,
  launchMicroPython,
  routedOps,
  type VirtualDeps,
  virtualOps,
  type VirtualProcess,
  virtualRoot,
  virtualSerial
} from "../../../core/virtual.ts"
import { CliError } from "../../../envelope.ts"
import { fakeOps } from "./fake-ops.ts"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const file = (path: string, text: string): ProjectFile => ({ path, bytes: bytes(text) })
const SDK = [file("/lib/qualithm_device/__init__.mpy", "sdk")]
const SETUP = { provisioningUrl: "https://api.example.com", claimCode: "qmc_x.y" }

/** A virtual device process a test drives by hand. */
type FakeProcess = VirtualProcess & {
  print: (text: string) => void
  exit: (code: number | null) => void
  killed: boolean
}

function fakeProcess(): FakeProcess {
  const outputs: ((text: string) => void)[] = []
  const exits: ((code: number | null) => void)[] = []
  const proc: FakeProcess = {
    killed: false,
    onOutput: (listener) => {
      outputs.push(listener)
    },
    onExit: (listener) => {
      exits.push(listener)
    },
    print: (text) => {
      for (const listener of outputs) {
        listener(text)
      }
    },
    exit: (code) => {
      for (const listener of exits.splice(0)) {
        listener(code)
      }
    },
    kill: () => {
      proc.killed = true
      proc.exit(null)
    }
  }
  return proc
}

async function setup(overrides: Partial<VirtualDeps> = {}): Promise<{
  root: string
  launched: { runtime: string; cwd: string; proc: FakeProcess }[]
  ops: ReturnType<typeof virtualOps>
}> {
  const root = await mkdtemp(join(tmpdir(), "virtual-"))
  const launched: { runtime: string; cwd: string; proc: FakeProcess }[] = []
  const ops = virtualOps({
    root: () => root,
    runtime: async () => Promise.resolve("/cache/micropython"),
    sdk: async () => Promise.resolve(SDK),
    launch: (runtime, cwd) => {
      const proc = fakeProcess()
      launched.push({ runtime, cwd, proc })
      return proc
    },
    max_chunks: 3,
    stop_timeout_ms: 50,
    ...overrides
  })
  return { root, launched, ops }
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

describe("virtual device names", () => {
  it("name a virtual device after its project folder", () => {
    expect(virtualSerial("/home/me/My Sensor_v2")).toBe("virtual:my-sensor-v2")
    expect(virtualSerial("/home/me/__")).toBe("virtual:project")
    expect(isVirtual("virtual:x")).toBe(true)
    expect(isVirtual("abc")).toBe(false)
    expect(isVirtual(undefined)).toBe(false)
  })

  it("keep virtual devices in the user's data folder, not the cache", () => {
    expect(virtualRoot("darwin", {}, "/Users/me")).toBe(
      "/Users/me/Library/Application Support/qualithm/virtual"
    )
    expect(virtualRoot("linux", {}, "/home/me")).toBe("/home/me/.local/share/qualithm/virtual")
    expect(virtualRoot("linux", { XDG_DATA_HOME: "/data" }, "/home/me")).toBe(
      "/data/qualithm/virtual"
    )
  })
})

describe("virtual device operations", () => {
  it("write the project, the SDK and the setup, then start main.py", async () => {
    const { root, launched, ops } = await setup()
    const result = await ops.deploy("virtual:demo", [file("/main.py", "print(1)")], false, {
      ...SETUP,
      wifi: { ssid: "Home", passphrase: "secret" }
    })
    const dir = join(root, "demo")
    expect(result).toEqual({
      board: { port: dir, serialNumber: "virtual:demo" },
      written: ["/main.py", "/lib/qualithm_device/__init__.mpy"],
      removed: [],
      unchanged: 0
    })
    expect(await readFile(join(dir, "main.py"), "utf8")).toBe("print(1)")
    expect(await readFile(join(dir, "lib", "qualithm_device", "__init__.mpy"), "utf8")).toBe("sdk")
    // The host's network stands in for Wi-Fi, so no passphrase is written.
    expect(JSON.parse(await readFile(join(dir, "qualithm-setup.json"), "utf8"))).toEqual(SETUP)
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe("700")
    expect(launched.map((l) => [l.runtime, l.cwd])).toEqual([["/cache/micropython", dir]])
  })

  it("write nothing and start nothing on a dry run", async () => {
    const { root, launched, ops } = await setup()
    const result = await ops.deploy("virtual:demo", [file("/main.py", "x")], true, SETUP)
    expect(result.written).toEqual(["/main.py", "/lib/qualithm_device/__init__.mpy"])
    expect(await exists(join(root, "demo"))).toBe(false)
    expect(launched).toEqual([])
  })

  it("redeploy only what changed, remove what the project dropped, and restart", async () => {
    const { root, launched, ops } = await setup()
    await ops.deploy("virtual:demo", [file("/main.py", "a"), file("/old.py", "o")], false, SETUP)
    await writeFile(join(root, "demo", "qualithm-credential.json"), "{}")

    const again = await ops.deploy("virtual:demo", [file("/main.py", "b")], false)

    expect(again).toMatchObject({ written: ["/main.py"], removed: ["/old.py"], unchanged: 1 })
    expect(await exists(join(root, "demo", "old.py"))).toBe(false)
    expect(await exists(join(root, "demo", "qualithm-credential.json"))).toBe(true)
    expect(launched).toHaveLength(2)
    expect(launched[0]?.proc.killed).toBe(true)
  })

  it("treat an unreadable record of the last deploy as empty", async () => {
    const { root, ops } = await setup()
    await ops.deploy("virtual:demo", [file("/main.py", "a")], false, SETUP)
    for (const record of ["not json", '{"not": "a list"}']) {
      await writeFile(join(root, "demo", ".qualithm-deployed.json"), record)
      const again = await ops.deploy("virtual:demo", [file("/main.py", "a")], true)
      expect(again.removed).toEqual([])
    }
  })

  it("report a stored credential and an unspent claim code", async () => {
    const { root, ops } = await setup()
    expect(await ops.probe("virtual:demo")).toEqual({
      blank: false,
      credential: false,
      claimCode: false
    })
    await ops.deploy("virtual:demo", [file("/main.py", "a")], false, SETUP)
    expect(await ops.probe("virtual:demo")).toMatchObject({ credential: false, claimCode: true })
    await writeFile(join(root, "demo", "qualithm-credential.json"), "{}")
    await writeFile(join(root, "demo", "qualithm-setup.json"), "not json")
    expect(await ops.probe("virtual:demo")).toMatchObject({ credential: true, claimCode: false })
  })

  it("buffer what the device prints, wait for more, and mark when it stops", async () => {
    const { launched, ops } = await setup()
    await ops.deploy("virtual:demo", [file("/main.py", "a")], false, SETUP)
    const proc = launched[0]?.proc
    proc?.print("hello\n")

    const first = await ops.logs("virtual:demo", 0, 0, 10)
    expect(first.chunks.map((c) => c.text)).toEqual(["hello\n"])

    const waiting = ops.logs("virtual:demo", first.next, 1000, 10)
    proc?.exit(1)
    const second = await waiting
    expect(second.chunks.map((c) => c.text)).toEqual(["\n[stopped, exit code 1]\n"])

    const quiet = await ops.logs("virtual:demo", second.next, 5, 10)
    expect(quiet).toMatchObject({ chunks: [], next: second.next, more: false })
  })

  it("keep only the newest output and page it by limit", async () => {
    const { launched, ops } = await setup()
    await ops.deploy("virtual:demo", [file("/main.py", "a")], false, SETUP)
    for (const text of ["1", "2", "3", "4"]) {
      launched[0]?.proc.print(text)
    }
    const page = await ops.logs("virtual:demo", 0, 0, 2)
    expect(page.chunks.map((c) => c.text)).toEqual(["2", "3"])
    expect(page.more).toBe(true)
  })

  it("restart a deployed device on reset, and name one that isn't deployed", async () => {
    const { launched, ops } = await setup()
    await expect(ops.reset("virtual:demo")).rejects.toMatchObject({ code: "not_found" })
    await expect(ops.logs("virtual:demo", 0, 0, 10)).rejects.toMatchObject({ code: "not_found" })

    await ops.deploy("virtual:demo", [file("/main.py", "a")], false, SETUP)
    const board = await ops.reset("virtual:demo")
    expect(board.serialNumber).toBe("virtual:demo")
    expect(launched).toHaveLength(2)
    expect(launched[0]?.proc.killed).toBe(true)
  })

  it("refuse what a board has but a virtual device doesn't", async () => {
    const { ops } = await setup()
    for (const call of [
      async () => ops.flash("virtual:demo"),
      async () => ops.run("virtual:demo", "print(1)"),
      async () => ops.write("virtual:demo", "x")
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CliError)
    }
    await expect(ops.probe("virtual:Bad Name")).rejects.toMatchObject({ code: "not_found" })
    expect(await ops.list()).toEqual([])
  })

  it("stop every device on close", async () => {
    const { launched, ops } = await setup()
    await ops.deploy("virtual:a", [file("/main.py", "a")], false, SETUP)
    await ops.deploy("virtual:b", [file("/main.py", "b")], false, SETUP)
    await ops.close()
    expect(launched.every((l) => l.proc.killed)).toBe(true)
  })

  it("move on from a device that won't stop", async () => {
    const stubborn = fakeProcess()
    stubborn.kill = () => {
      stubborn.killed = true
    }
    const { ops } = await setup({ launch: () => stubborn })
    await ops.deploy("virtual:demo", [file("/main.py", "a")], false, SETUP)
    await ops.close()
    expect(stubborn.killed).toBe(true)
  })
})

describe("routed operations", () => {
  it("send virtual serial numbers to the virtual devices and the rest to boards", async () => {
    const boards = fakeOps()
    const virtual = fakeOps()
    const ops = routedOps(boards, virtual)
    await ops.probe("virtual:demo")
    await ops.probe("abc")
    await ops.reset("virtual:demo")
    await ops.flash(undefined)
    await ops.run("virtual:demo", "x")
    await ops.write("abc", "x")
    await ops.logs("virtual:demo", 0, 0, 1)
    await ops.deploy("virtual:demo", [file("/main.py", "a")], false)
    expect(await ops.list()).toEqual(await boards.list())
    await ops.close()
    const verbs = (calls: string[]): Set<string | undefined> =>
      new Set(calls.map((c) => c.split(":")[0]))
    expect(verbs(virtual.calls)).toEqual(
      new Set(["probe", "reset", "run", "logs", "deploy", "close"])
    )
    expect(verbs(boards.calls)).toEqual(new Set(["probe", "flash", "write", "close"]))
    expect(boards.calls.some((c) => c.includes("virtual:"))).toBe(false)
  })
})

describe("launchMicroPython", () => {
  // Any runtime that takes `main.py` will do; this one runs it as JavaScript.
  it("runs main.py in the device's folder and forwards what it prints and how it ends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launch-"))
    await writeFile(
      join(dir, "main.py"),
      'process.stdout.write(process.env.MICROPYPATH + "\\n"); process.stderr.write("err\\n")'
    )
    const proc = launchMicroPython(process.execPath, dir)
    let output = ""
    proc.onOutput((text) => {
      output += text
    })
    const code = await new Promise((resolve) => {
      proc.onExit(resolve)
    })
    expect(code).toBe(0)
    expect(output).toContain("lib:.frozen\n")
    expect(output).toContain("err\n")
  })

  it("stops a running device on kill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launch-"))
    await writeFile(join(dir, "main.py"), "setInterval(() => undefined, 1000)")
    const proc = launchMicroPython(process.execPath, dir)
    const ended = new Promise((resolve) => {
      proc.onExit(resolve)
    })
    proc.kill()
    expect(await ended).not.toBe(0)
  })

  it("reports a runtime that can't start as stopped", async () => {
    const proc = launchMicroPython("/no/such/micropython", tmpdir())
    expect(
      await new Promise((resolve) => {
        proc.onExit(resolve)
      })
    ).toBeNull()
  })

  it("builds the real machine's operations without touching the disk", async () => {
    const ops = defaultVirtualOps()
    expect(await ops.list()).toEqual([])
    await ops.close()
  })
})
