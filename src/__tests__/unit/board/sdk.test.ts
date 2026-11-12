import { createHash } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { DEVICE_SDK, isSdkPath, loadSdk, type Sdk } from "../../../board/sdk.ts"

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

describe("DEVICE_SDK", () => {
  it("pins every file by a full SHA-256 under /lib", () => {
    for (const file of DEVICE_SDK.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.path.startsWith("/lib/")).toBe(true)
      expect(isSdkPath(file.path)).toBe(true)
    }
  })

  it("downloads its own modules from the release named by its version", () => {
    const own = DEVICE_SDK.files.filter((f) => f.path.startsWith("/lib/qualithm_device/"))
    expect(own.length).toBeGreaterThan(0)
    for (const file of own) {
      expect(file.url).toContain(`/releases/download/${DEVICE_SDK.version}/qualithm_device.`)
    }
  })

  it("installs device-sdk-py 0.9.2, which keeps its session across credential renewal", () => {
    expect(DEVICE_SDK.version).toBe("0.9.2")
    const paths = DEVICE_SDK.files.map((f) => f.path)
    expect(paths).toContain("/lib/qualithm_device/esp32.mpy")
    expect(paths).toContain("/lib/qualithm_device/_onboard.mpy")
  })

  it("names index files by their checksum's prefix", () => {
    const simple = DEVICE_SDK.files.find((f) => f.path === "/lib/umqtt/simple.mpy")
    expect(simple?.url).toBe("https://micropython.org/pi/v2/file/92/9240e244")
  })
})

describe("isSdkPath", () => {
  it.each([
    ["/lib/qualithm_device/pico.mpy", true],
    ["/lib/umqtt/simple.mpy", true],
    ["/lib/ssl.mpy", true],
    ["/lib/ssl.py", false],
    ["/lib/sensor.py", false],
    ["/main.py", false]
  ])("%s → %s", (path, owned) => {
    expect(isSdkPath(path)).toBe(owned)
  })
})

describe("loadSdk", () => {
  it("returns each file at its board path, checked against its pin", async () => {
    const a = new TextEncoder().encode("a")
    const b = new TextEncoder().encode("b")
    const sdk: Sdk = {
      version: "9.9.9",
      files: [
        { path: "/lib/qualithm_device/a.mpy", url: "https://example.test/a", sha256: sha256(a) },
        { path: "/lib/umqtt/b.mpy", url: "https://example.test/b", sha256: sha256(b) }
      ]
    }
    const fetched: string[] = []
    const config = {
      cache_dir: await mkdtemp(join(tmpdir(), "sdk-")),
      fetch: async (url: string) => {
        fetched.push(url)
        return Promise.resolve(new Response(url.endsWith("/a") ? a : b))
      }
    }
    expect(await loadSdk(sdk, config)).toEqual([
      { path: "/lib/qualithm_device/a.mpy", bytes: a },
      { path: "/lib/umqtt/b.mpy", bytes: b }
    ])
    await loadSdk(sdk, config)
    expect(fetched.sort()).toEqual(["https://example.test/a", "https://example.test/b"])
  })

  it("refuses a download that doesn't match its pin", async () => {
    const sdk: Sdk = {
      version: "9.9.9",
      files: [{ path: "/lib/umqtt/b.mpy", url: "https://example.test/b", sha256: "0".repeat(64) }]
    }
    const config = {
      cache_dir: await mkdtemp(join(tmpdir(), "sdk-")),
      fetch: async () => Promise.resolve(new Response("tampered"))
    }
    await expect(loadSdk(sdk, config)).rejects.toThrow(
      "the Qualithm Device SDK 9.9.9 (/lib/umqtt/b.mpy) download doesn't match its pinned checksum"
    )
  })
})
