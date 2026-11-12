import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { defaultRawReplConfig } from "../../../board/raw-repl.ts"
import {
  collectProject,
  emptiedDirs,
  MANIFEST,
  PROBE,
  probeSetup,
  type ProjectFile,
  type Repl,
  sha256,
  syncProject,
  syncWith,
  writeSetup
} from "../../../board/sync.ts"
import { FakeBoard } from "./fake-board.ts"

/**
 * A raw REPL over an in-memory filesystem, understanding the statements a sync sends. `failOn`
 * makes any statement containing it raise `error`.
 */
class FakeFs implements Repl {
  readonly files = new Map<string, Uint8Array>()
  /** Folders made with `_md`; a file's folder also exists without being listed here. */
  readonly dirs = new Set<string>()
  readonly ran: string[] = []
  failOn?: string
  error = "OSError: [Errno 28] ENOSPC"
  #open?: { path: string; chunks: Uint8Array[] }

  async exec(code: string): Promise<{ stdout: string; stderr: string }> {
    this.ran.push(code)
    await Promise.resolve()
    if (this.failOn !== undefined && code.includes(this.failOn)) {
      return { stdout: "", stderr: `Traceback (most recent call last):\n${this.error}\n` }
    }
    return { stdout: this.#run(code), stderr: "" }
  }

  #run(code: string): string {
    if (code === PROBE) {
      let setup: unknown
      try {
        setup = JSON.parse(Buffer.from(this.files.get("/qualithm-setup.json") ?? []).toString())
      } catch {
        setup = {}
      }
      const s = (typeof setup === "object" && setup !== null ? setup : {}) as {
        claimCode?: string
        wifi?: { ssid?: string }
      }
      return `${JSON.stringify({
        credential: this.files.has("/qualithm-credential.json"),
        claimCode: Boolean(s.claimCode),
        wifiNetwork: s.wifi?.ssid ?? null
      })}\r\n`
    }
    const setupWrite = /^import json, os\n_n = json\.loads\((".*")\)\n/.exec(code)
    if (setupWrite !== null) {
      const next = JSON.parse(JSON.parse(setupWrite[1] ?? '""') as string) as Record<
        string,
        unknown
      >
      if (!("wifi" in next)) {
        const old = this.files.get("/qualithm-setup.json")
        if (old === undefined) {
          throw new Error("no setup to keep")
        }
        next.wifi = (JSON.parse(Buffer.from(old).toString()) as { wifi: unknown }).wifi
      }
      this.files.set("/qualithm-setup.json", Buffer.from(JSON.stringify(next)))
      return ""
    }
    if (code.startsWith("import os, hashlib")) {
      return ""
    }
    const listing = /^for _p in (\[.*\]):/.exec(code)
    if (listing !== null) {
      const paths = JSON.parse(listing[1] ?? "[]") as string[]
      return paths
        .map((p) => {
          const bytes = this.files.get(p)
          return bytes === undefined ? "" : sha256(bytes)
        })
        .map((h) => `${h}\r\n`)
        .join("")
    }
    const owned = /^for _d in (\[.*\]):/.exec(code)
    if (owned !== null) {
      const dirs = JSON.parse(owned[1] ?? "[]") as string[]
      return [...this.files.keys()]
        .filter((p) => dirs.some((d) => p.startsWith(`${d}/`)))
        .map((p) => `${p}\r\n`)
        .join("")
    }
    if (code.startsWith("try:\n    print(open(")) {
      const manifest = this.files.get(MANIFEST)
      return `${manifest === undefined ? "[]" : Buffer.from(manifest).toString()}\r\n`
    }
    const opening = /^_md\((".*")\)\n_f = open\((".*"), "wb"\)$/.exec(code)
    if (opening !== null) {
      const parts = (JSON.parse(opening[1] ?? '""') as string).split("/").slice(1, -1)
      parts.forEach((_, i) => this.dirs.add(`/${parts.slice(0, i + 1).join("/")}`))
      this.#open = { path: JSON.parse(opening[2] ?? '""') as string, chunks: [] }
      return ""
    }
    const chunk = /^_f\.write\(binascii\.a2b_base64\((".*")\)\)$/.exec(code)
    if (chunk !== null && this.#open !== undefined) {
      this.#open.chunks.push(Buffer.from(JSON.parse(chunk[1] ?? '""') as string, "base64"))
      return ""
    }
    const rename = /^_f\.close\(\)\n_rm\((".*")\)\nos\.rename\((".*"), (".*")\)$/.exec(code)
    if (rename !== null && this.#open !== undefined) {
      const to = JSON.parse(rename[3] ?? '""') as string
      this.files.set(to, Buffer.concat(this.#open.chunks))
      this.#open = undefined
      return ""
    }
    const remove = /^_rm\((".*")\)$/.exec(code)
    if (remove !== null) {
      this.files.delete(JSON.parse(remove[1] ?? '""') as string)
      return ""
    }
    const rmdir = /^_rd\((\[.*\])\)$/.exec(code)
    if (rmdir !== null) {
      for (const dir of JSON.parse(rmdir[1] ?? "[]") as string[]) {
        const inside = (p: string): boolean => p.startsWith(`${dir}/`)
        if (![...this.files.keys(), ...this.dirs].some(inside)) {
          this.dirs.delete(dir)
        }
      }
      return ""
    }
    const manifest = /^_f = open\((".*"), "w"\)\n_f\.write\((".*")\)\n_f\.close\(\)$/.exec(code)
    if (manifest !== null) {
      const text = JSON.parse(manifest[2] ?? '""') as string
      this.files.set(MANIFEST, Buffer.from(text))
      return ""
    }
    throw new Error(`unexpected code: ${code}`)
  }
}

const file = (path: string, text: string): ProjectFile => ({
  path,
  bytes: new Uint8Array(Buffer.from(text))
})

describe("collectProject", () => {
  async function project(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "proj-"))
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true })
      await writeFile(join(dir, path), text)
    }
    return dir
  }

  it("reads every file at its board path, skipping hidden files and caches", async () => {
    const dir = await project({
      "main.py": "print(1)",
      "lib/sensor.py": "X = 1",
      ".env": "secret",
      ".git/HEAD": "ref",
      "__pycache__/main.cpython.pyc": "x",
      "node_modules/x/index.js": "x"
    })
    const files = await collectProject(dir)
    expect(files.map((f) => f.path)).toEqual(["/lib/sensor.py", "/main.py"])
    expect(Buffer.from(files[1]?.bytes ?? []).toString()).toBe("print(1)")
  })

  it.each(["lib/qualithm_device/pico.py", "lib/umqtt/simple.py", "lib/ssl.mpy"])(
    "refuses %s, where deploy installs the SDK",
    async (file) => {
      const dir = await mkdtemp(join(tmpdir(), "proj-"))
      await mkdir(join(dir, file, ".."), { recursive: true })
      await writeFile(join(dir, file), "x")
      await expect(collectProject(dir)).rejects.toThrow(
        `the project has /${file}, where deploy installs the device SDK: rename it`
      )
    }
  )

  it("refuses a file the device SDK owns", async () => {
    const dir = await project({ "main.py": "", "qualithm-credential.json": "{}" })
    await expect(collectProject(dir)).rejects.toThrow(
      "the project has /qualithm-credential.json, which the device SDK owns on the board: rename it"
    )
  })

  it("refuses an empty project", async () => {
    const dir = await project({ ".hidden": "x" })
    await expect(collectProject(dir)).rejects.toMatchObject({ code: "usage" })
  })

  it("names a folder it can't read", async () => {
    await expect(collectProject(join(tmpdir(), "no-such-project-folder"))).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringMatching(/^read the project folder /) as unknown
    })
  })
})

describe("emptiedDirs", () => {
  it("lists removed files' folders deepest first, less /, /lib and the project's", () => {
    expect(emptiedDirs(["/a/b/c.py", "/a/d.py", "/top.py", "/lib/x.py"], ["/a/keep/k.py"])).toEqual(
      ["/a/b"]
    )
    expect(emptiedDirs(["/a/b/c.py", "/z/y.py"], [])).toEqual(["/a/b", "/a", "/z"])
  })
})

describe("syncWith", () => {
  it("writes every file on a first deploy and records them", async () => {
    const fs = new FakeFs()
    const big = "x".repeat(5000)
    const result = await syncWith(fs, [file("/main.py", "print(1)"), file("/data.txt", big)], false)
    expect(result).toEqual({ written: ["/main.py", "/data.txt"], removed: [], unchanged: 0 })
    expect(Buffer.from(fs.files.get("/data.txt") ?? []).toString()).toBe(big)
    expect(Buffer.from(fs.files.get(MANIFEST) ?? []).toString()).toBe('["/main.py","/data.txt"]')
  })

  it("writes only what changed, and removes files gone from the project", async () => {
    const fs = new FakeFs()
    await syncWith(fs, [file("/main.py", "a"), file("/lib/x.py", "b"), file("/old.py", "c")], false)
    fs.files.set("/mine.txt", new Uint8Array([1]))
    fs.ran.length = 0
    const result = await syncWith(fs, [file("/main.py", "a"), file("/lib/x.py", "B")], false)
    expect(result).toEqual({ written: ["/lib/x.py"], removed: ["/old.py"], unchanged: 1 })
    expect([...fs.files.keys()].sort()).toEqual([MANIFEST, "/lib/x.py", "/main.py", "/mine.txt"])
  })

  it("removes the folders a redeploy empties, keeping /lib and folders still in use", async () => {
    const fs = new FakeFs()
    await syncWith(
      fs,
      [
        file("/main.py", "a"),
        file("/qualithm_device/board.py", "b"),
        file("/pkg/sub/deep.py", "c"),
        file("/pkg/keep.py", "d"),
        file("/lib/only.py", "e"),
        file("/data/log.txt", "f")
      ],
      false
    )
    fs.files.set("/data/mine.txt", new Uint8Array([1]))
    fs.ran.length = 0
    const result = await syncWith(fs, [file("/main.py", "a"), file("/pkg/keep.py", "d")], false)
    expect(result.removed).toEqual([
      "/qualithm_device/board.py",
      "/pkg/sub/deep.py",
      "/lib/only.py",
      "/data/log.txt"
    ])
    expect([...fs.dirs].sort()).toEqual(["/data", "/lib", "/pkg"])
    expect(fs.ran).toContain('_rd(["/pkg/sub","/data","/qualithm_device"])')
  })

  it("tries no folder when nothing was removed", async () => {
    const fs = new FakeFs()
    await syncWith(fs, [file("/pkg/a.py", "a")], false)
    fs.ran.length = 0
    await syncWith(fs, [file("/pkg/a.py", "b")], false)
    expect(fs.ran.some((code) => code.startsWith("_rd("))).toBe(false)
  })

  it("never removes the SDK's files, even when a manifest lists them", async () => {
    const fs = new FakeFs()
    fs.files.set("/qualithm-credential.json", new Uint8Array([1]))
    fs.files.set(MANIFEST, Buffer.from('["/qualithm-credential.json","/main.py"]'))
    const result = await syncWith(fs, [file("/main.py", "a")], false)
    expect(result.removed).toEqual([])
    expect(fs.files.has("/qualithm-credential.json")).toBe(true)
  })

  it("clears anything in the SDK's folders that isn't the SDK, such as a shadowing .py", async () => {
    const fs = new FakeFs()
    fs.files.set("/lib/qualithm_device/pico.py", new Uint8Array([1]))
    fs.files.set("/lib/umqtt/robust.mpy", new Uint8Array([1]))
    fs.files.set("/lib/sensor.py", new Uint8Array([1]))
    const sdk = file("/lib/qualithm_device/pico.mpy", "m")
    const result = await syncWith(fs, [file("/main.py", "a"), sdk], false)
    expect(result.removed).toEqual(["/lib/qualithm_device/pico.py", "/lib/umqtt/robust.mpy"])
    expect([...fs.files.keys()].sort()).toEqual([
      MANIFEST,
      "/lib/qualithm_device/pico.mpy",
      "/lib/sensor.py",
      "/main.py"
    ])
  })

  it("reports what would change on a dry run, changing nothing", async () => {
    const fs = new FakeFs()
    fs.files.set(MANIFEST, Buffer.from('["/gone.py"]'))
    const result = await syncWith(fs, [file("/main.py", "a")], true)
    expect(result).toEqual({ written: ["/main.py"], removed: ["/gone.py"], unchanged: 0 })
    expect(fs.files.has("/main.py")).toBe(false)
  })

  it("ignores a manifest it can't read", async () => {
    const fs = new FakeFs()
    fs.files.set(MANIFEST, Buffer.from("not json"))
    expect((await syncWith(fs, [file("/a.py", "a")], true)).removed).toEqual([])
    fs.files.set(MANIFEST, Buffer.from('{"not": "a list"}'))
    expect((await syncWith(fs, [file("/a.py", "a")], true)).removed).toEqual([])
  })

  it("names a full filesystem", async () => {
    const fs = new FakeFs()
    fs.failOn = "a2b_base64"
    await expect(syncWith(fs, [file("/main.py", "a")], false)).rejects.toThrow(
      "the board's filesystem is full: deploy fewer or smaller files"
    )
  })

  it("passes on any other error from the board", async () => {
    const fs = new FakeFs()
    fs.failOn = "os.rename"
    fs.error = "OSError: [Errno 5] EIO"
    await expect(syncWith(fs, [file("/main.py", "a")], false)).rejects.toThrow(
      "the board raised OSError: [Errno 5] EIO"
    )
  })
})

describe("setup", () => {
  const setup = {
    provisioningUrl: "https://api.example.com",
    claimCode: "qmc_a.b",
    wifi: { ssid: 'Home "5G"', passphrase: "p\\w'd" }
  }

  it("finds nothing on a board deploy hasn't set up", async () => {
    expect(await probeSetup(new FakeFs())).toEqual({ credential: false, claimCode: false })
  })

  it("writes the setup file, quotes and all, and reads it back", async () => {
    const fs = new FakeFs()
    await writeSetup(fs, setup)
    expect(JSON.parse(Buffer.from(fs.files.get("/qualithm-setup.json") ?? []).toString())).toEqual(
      setup
    )
    expect(await probeSetup(fs)).toEqual({
      credential: false,
      claimCode: true,
      wifiNetwork: 'Home "5G"'
    })
  })

  it("keeps the board's Wi-Fi when the new setup has none", async () => {
    const fs = new FakeFs()
    await writeSetup(fs, setup)
    await writeSetup(fs, { provisioningUrl: setup.provisioningUrl, claimCode: "qmc_c.d" })
    const written = JSON.parse(Buffer.from(fs.files.get("/qualithm-setup.json") ?? []).toString())
    expect(written).toEqual({ ...setup, claimCode: "qmc_c.d" })
  })

  it("sees a stored credential", async () => {
    const fs = new FakeFs()
    fs.files.set("/qualithm-credential.json", Buffer.from("{}"))
    expect((await probeSetup(fs)).credential).toBe(true)
  })
})

describe("syncProject", () => {
  const fast = { ...defaultRawReplConfig, enter_timeout_ms: 5000, exec_timeout_ms: 5000 }

  it("soft-resets the board after a deploy, but not after a dry run", async () => {
    const board = new FakeBoard()
    const files = [file("/main.py", "a")]
    // The fake board prints nothing, so every file reads as missing and is written.
    const dry = await syncProject(board, files, true, fast)
    expect(dry.written).toEqual(["/main.py"])
    expect(board.written.at(-1)).toBe("\x02")
    const real = await syncProject(board, files, false, fast)
    expect(real.written).toEqual(["/main.py"])
    expect(board.written.at(-1)).toBe("\x04")
    const setup = { provisioningUrl: "https://a.example", claimCode: "qmc_a.b" }
    await syncProject(board, files, false, fast, setup)
    expect(board.ran.some((code) => code.includes("qmc_a.b"))).toBe(true)
  })
})

describe("probeBoard", () => {
  it("reads the setup state over the raw REPL", async () => {
    const { probeBoard } = await import("../../../board/sync.ts")
    const board = new FakeBoard({
      [PROBE]: { stdout: '{"credential": true, "claimCode": false, "wifiNetwork": null}\r\n' }
    })
    expect(await probeBoard(board, { ...defaultRawReplConfig, enter_timeout_ms: 5000 })).toEqual({
      credential: true,
      claimCode: false
    })
  })
})
