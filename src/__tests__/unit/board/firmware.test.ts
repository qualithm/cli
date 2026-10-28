import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  cacheDir,
  checkUf2,
  defaultFirmwareConfig,
  type Firmware,
  loadFirmware,
  MICROPYTHON_PICO_2_W
} from "../../../board/firmware.ts"
import { CliError } from "../../../envelope.ts"
import { uf2 } from "./uf2.ts"

const FAMILY = 0xe48bff59

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

function firmwareFor(bytes: Uint8Array): Firmware {
  return { ...MICROPYTHON_PICO_2_W, url: "https://example.test/fw.uf2", sha256: sha256(bytes) }
}

describe("checkUf2", () => {
  it("accepts blocks for an allowed family", () => {
    expect(() => {
      checkUf2(uf2(3), [FAMILY])
    }).not.toThrow()
  })

  it.each([
    ["an empty file", new Uint8Array(0)],
    ["a partial block", new Uint8Array(700)]
  ])("refuses %s", (_name, bytes) => {
    expect(() => {
      checkUf2(bytes, [FAMILY])
    }).toThrow(new CliError("the firmware isn't a UF2 file", "error"))
  })

  it.each([0, 4, 508])("names a block whose magic at byte %i is wrong", (offset) => {
    const bytes = uf2(2)
    bytes[512 + offset] = 0
    expect(() => {
      checkUf2(bytes, [FAMILY])
    }).toThrow("the firmware isn't a UF2 file: block 1 is malformed")
  })

  it("refuses another chip's firmware", () => {
    expect(() => {
      checkUf2(uf2(1, 0xe48bff56), [FAMILY])
    }).toThrow("the firmware is for another chip: block 0 targets family 0xe48bff56")
  })

  it("refuses a block with no family", () => {
    expect(() => {
      checkUf2(uf2(1, FAMILY, 0), [FAMILY])
    }).toThrow("the firmware is for another chip")
  })
})

describe("cacheDir", () => {
  it.each([
    ["darwin", {}, "/home/ada/Library/Caches/qualithm"],
    ["linux", {}, "/home/ada/.cache/qualithm"],
    ["linux", { XDG_CACHE_HOME: "" }, "/home/ada/.cache/qualithm"],
    ["linux", { XDG_CACHE_HOME: "/xdg" }, "/xdg/qualithm"],
    ["win32", {}, "/home/ada/AppData/Local/qualithm/cache"],
    ["win32", { LOCALAPPDATA: "/local" }, "/local/qualithm/cache"]
  ] as const)("on %s with %j is %s", (platform, env, dir) => {
    expect(cacheDir(platform, env, "/home/ada")).toBe(dir)
  })

  it("defaults to this machine", () => {
    expect(cacheDir()).toContain("qualithm")
    expect(defaultFirmwareConfig.cache_dir).toBe(cacheDir())
  })
})

describe("MICROPYTHON_PICO_2_W", () => {
  it("pins a release by checksum", () => {
    expect(MICROPYTHON_PICO_2_W.version).toBe("1.29.0")
    expect(MICROPYTHON_PICO_2_W.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(MICROPYTHON_PICO_2_W.url).toContain(MICROPYTHON_PICO_2_W.version)
  })
})

describe("loadFirmware", () => {
  async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "qualithm-fw-"))
  }

  it("downloads, checks and caches the file, then reads the cache", async () => {
    const bytes = uf2(4)
    const firmware = firmwareFor(bytes)
    const dir = join(await tempDir(), "nested")
    let fetches = 0
    const config = {
      cache_dir: dir,
      fetch: async () => {
        fetches++
        return Promise.resolve(new Response(bytes))
      }
    }
    expect(await loadFirmware(firmware, config)).toEqual(bytes)
    expect(await readdir(dir)).toEqual([`${firmware.sha256}.uf2`])
    expect(await loadFirmware(firmware, config)).toEqual(bytes)
    expect(fetches).toBe(1)
  })

  it("downloads again when the cached copy is damaged", async () => {
    const bytes = uf2(2)
    const firmware = firmwareFor(bytes)
    const dir = await tempDir()
    await writeFile(join(dir, `${firmware.sha256}.uf2`), "garbage")
    const config = { cache_dir: dir, fetch: async () => Promise.resolve(new Response(bytes)) }
    expect(await loadFirmware(firmware, config)).toEqual(bytes)
    expect(new Uint8Array(await readFile(join(dir, `${firmware.sha256}.uf2`)))).toEqual(bytes)
  })

  it("refuses a download that doesn't match the pinned checksum", async () => {
    const firmware = firmwareFor(uf2(2))
    const config = {
      cache_dir: await tempDir(),
      fetch: async () => Promise.resolve(new Response(uf2(3)))
    }
    await expect(loadFirmware(firmware, config)).rejects.toThrow(
      "the MicroPython 1.29.0 download doesn't match its pinned checksum"
    )
  })

  it("refuses a matching download that isn't firmware for this chip", async () => {
    const bytes = uf2(1, 0x1234)
    const config = {
      cache_dir: await tempDir(),
      fetch: async () => Promise.resolve(new Response(bytes))
    }
    await expect(loadFirmware(firmwareFor(bytes), config)).rejects.toThrow(
      "the firmware is for another chip"
    )
  })

  it("reports an HTTP error as unavailable", async () => {
    const config = {
      cache_dir: await tempDir(),
      fetch: async () => Promise.resolve(new Response("gone", { status: 404 }))
    }
    await expect(loadFirmware(firmwareFor(uf2(1)), config)).rejects.toEqual(
      new CliError(
        "download MicroPython 1.29.0: https://example.test/fw.uf2 answered 404",
        "unavailable"
      )
    )
  })

  it.each([
    ["an error", new Error("offline")],
    ["anything else", "offline"]
  ])("reports a fetch that throws %s as unavailable", async (_name, thrown) => {
    const config = {
      cache_dir: await tempDir(),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a fetch can reject with anything
      fetch: async () => Promise.reject(thrown)
    }
    await expect(loadFirmware(firmwareFor(uf2(1)), config)).rejects.toEqual(
      new CliError("download MicroPython 1.29.0: offline", "unavailable")
    )
  })

  it("fetches with the global fetch by default", async () => {
    const response = await defaultFirmwareConfig.fetch("data:application/octet-stream,hi")
    expect(await response.text()).toBe("hi")
  })
})
