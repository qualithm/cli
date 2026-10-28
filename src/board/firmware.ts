import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { CliError } from "../envelope.ts"

/** A MicroPython build pinned by its checksum. */
export type Firmware = {
  /** The release, as `os.uname().release` reports it on the board. */
  version: string
  /** Where to download it. */
  url: string
  /** The file's SHA-256, lowercase hex. */
  sha256: string
  /** The UF2 family IDs its blocks may carry. */
  families: readonly number[]
}

/** UF2 family IDs: RP2350 Arm Secure, and the absolute family RP2350 builds also carry. */
const RP2350_ARM_S = 0xe48bff59
const ABSOLUTE = 0xe48bff57

/** MicroPython for the Raspberry Pi Pico 2 W. */
export const MICROPYTHON_PICO_2_W: Firmware = {
  version: "1.29.0",
  url: "https://micropython.org/resources/firmware/RPI_PICO2_W-20260824-v1.29.0.uf2",
  sha256: "c49c7ed93eb7eeaaa78436b17bd4329e5d4ccbaebc1e79503ad75e0a29c4530e",
  families: [RP2350_ARM_S, ABSOLUTE]
}

const BLOCK_BYTES = 512
const MAGIC_START_0 = 0x0a324655
const MAGIC_START_1 = 0x9e5d5157
const MAGIC_END = 0x0ab16f30
const FLAG_FAMILY_ID = 0x2000

/**
 * Checks that bytes are a UF2 file whose every block targets one of the given chip families.
 *
 * @param bytes - the file
 * @param families - the family IDs allowed
 * @throws {CliError} naming the first block that fails
 */
export function checkUf2(bytes: Uint8Array, families: readonly number[]): void {
  if (bytes.length === 0 || bytes.length % BLOCK_BYTES !== 0) {
    throw new CliError("the firmware isn't a UF2 file", "error")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at < bytes.length; at += BLOCK_BYTES) {
    const block = at / BLOCK_BYTES
    if (
      view.getUint32(at, true) !== MAGIC_START_0 ||
      view.getUint32(at + 4, true) !== MAGIC_START_1 ||
      view.getUint32(at + BLOCK_BYTES - 4, true) !== MAGIC_END
    ) {
      throw new CliError(
        `the firmware isn't a UF2 file: block ${String(block)} is malformed`,
        "error"
      )
    }
    const flags = view.getUint32(at + 8, true)
    const family = view.getUint32(at + 28, true)
    if ((flags & FLAG_FAMILY_ID) === 0 || !families.includes(family)) {
      throw new CliError(
        `the firmware is for another chip: block ${String(block)} targets family 0x${family.toString(16)}`,
        "error"
      )
    }
  }
}

/** Where firmware is cached and how it's downloaded. */
export type FirmwareConfig = {
  /** The folder downloads are kept in. */
  cache_dir: string
  fetch: (url: string) => Promise<Response>
}

/**
 * The per-user cache folder for this OS.
 *
 * @param platform - the OS
 * @param env - environment variables
 * @param home - the user's home folder
 * @returns the folder qualithm caches downloads in
 */
export function cacheDir(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "qualithm")
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "qualithm", "cache")
  }
  const xdg = env.XDG_CACHE_HOME
  return join(xdg === undefined || xdg === "" ? join(home, ".cache") : xdg, "qualithm")
}

export const defaultFirmwareConfig: FirmwareConfig = {
  // A getter, so importing the package never reads the home folder; config fields are snake_case.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  get cache_dir() {
    return cacheDir()
  },
  fetch: async (url) => fetch(url)
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** A download pinned by its checksum. */
export type Pinned = {
  /** Names it in errors, e.g. `MicroPython 1.29.0`. */
  label: string
  url: string
  /** The file's SHA-256, lowercase hex. */
  sha256: string
  /** The cached copy's extension, e.g. `.uf2`. */
  ext: string
}

/**
 * Returns a pinned file's bytes, from the cache or by downloading it. Every copy is checked
 * against the pinned checksum before it's returned.
 *
 * @param file - what to load
 * @param config - cache folder and download
 * @param check - a further check a download must pass before it's cached
 * @returns the verified bytes
 * @throws {CliError} when the download fails or doesn't match
 */
export async function loadPinned(
  file: Pinned,
  config: FirmwareConfig,
  check: (bytes: Uint8Array) => void = () => undefined
): Promise<Uint8Array> {
  const path = join(config.cache_dir, `${file.sha256}${file.ext}`)
  try {
    const cached = new Uint8Array(await readFile(path))
    if (sha256(cached) === file.sha256) {
      return cached
    }
  } catch {
    // Not cached yet.
  }
  let response: Response
  try {
    response = await config.fetch(file.url)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(`download ${file.label}: ${reason}`, "unavailable")
  }
  if (!response.ok) {
    throw new CliError(
      `download ${file.label}: ${file.url} answered ${String(response.status)}`,
      "unavailable"
    )
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha256(bytes) !== file.sha256) {
    throw new CliError(`the ${file.label} download doesn't match its pinned checksum`, "error")
  }
  check(bytes)
  await mkdir(config.cache_dir, { recursive: true })
  const partial = `${path}.${String(process.pid)}.partial`
  await writeFile(partial, bytes)
  await rename(partial, path)
  return bytes
}

/**
 * Returns a firmware file's bytes, from the cache or by downloading it, checked against the
 * pinned checksum and as UF2.
 *
 * @param firmware - the build
 * @param config - cache folder and download
 * @returns the verified bytes
 * @throws {CliError} when the download fails or doesn't match
 */
export async function loadFirmware(
  firmware: Firmware,
  config: FirmwareConfig = defaultFirmwareConfig
): Promise<Uint8Array> {
  const pinned = {
    label: `MicroPython ${firmware.version}`,
    url: firmware.url,
    sha256: firmware.sha256,
    ext: ".uf2"
  }
  return loadPinned(pinned, config, (bytes) => {
    checkUf2(bytes, firmware.families)
  })
}
