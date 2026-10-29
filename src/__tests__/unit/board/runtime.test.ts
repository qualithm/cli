import { createHash } from "node:crypto"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { loadRuntime, MICROPYTHON_UNIX, runtimeTarget } from "../../../board/runtime.ts"
import { CliError } from "../../../envelope.ts"

describe("runtimeTarget", () => {
  it("names the build for macOS and Linux on arm64 and x64", () => {
    expect(runtimeTarget("darwin", "arm64")).toBe("darwin-arm64")
    expect(runtimeTarget("darwin", "x64")).toBe("darwin-x64")
    expect(runtimeTarget("linux", "arm64")).toBe("linux-arm64")
    expect(runtimeTarget("linux", "x64")).toBe("linux-x64")
  })

  it("refuses a host no build runs on, pointing Windows at WSL", () => {
    expect(() => runtimeTarget("win32", "x64")).toThrow(/run it under WSL/)
    expect(() => runtimeTarget("linux", "ia32")).toThrow(CliError)
  })

  it("pins a build for every target", () => {
    expect(Object.keys(MICROPYTHON_UNIX.builds).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64"
    ])
    for (const sha of Object.values(MICROPYTHON_UNIX.builds)) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe("loadRuntime", () => {
  it("downloads the host's build from the release, checks it and makes it executable", async () => {
    const binary = new TextEncoder().encode("#!micropython")
    const sha = createHash("sha256").update(binary).digest("hex")
    const cache = await mkdtemp(join(tmpdir(), "runtime-"))
    const fetched: string[] = []
    const path = await loadRuntime(
      "linux-x64",
      {
        version: "1.29.0",
        release: "0.3.1",
        builds: { ...MICROPYTHON_UNIX.builds, "linux-x64": sha }
      },
      {
        cache_dir: cache,
        fetch: async (url) => {
          fetched.push(url)
          return Promise.resolve(new Response(binary))
        }
      }
    )
    expect(fetched).toEqual([
      "https://github.com/qualithm/device-sdk-py/releases/download/0.3.1/micropython-1.29.0-linux-x64"
    ])
    expect(path).toBe(join(cache, `${sha}.micropython`))
    expect((await stat(path)).mode & 0o111).toBe(0o111)
  })

  it("refuses a download that doesn't match its pin", async () => {
    const cache = await mkdtemp(join(tmpdir(), "runtime-"))
    await expect(
      loadRuntime("darwin-arm64", MICROPYTHON_UNIX, {
        cache_dir: cache,
        fetch: async () => Promise.resolve(new Response("tampered"))
      })
    ).rejects.toThrow(/doesn't match its pinned checksum/)
  })
})
