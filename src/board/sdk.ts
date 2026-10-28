import { defaultFirmwareConfig, type FirmwareConfig, loadPinned } from "./firmware.ts"
import type { ProjectFile } from "./sync.ts"

/** One file of the device SDK, pinned by its checksum. */
export type SdkFile = {
  /** Absolute on the board, under `/lib` where MicroPython imports from. */
  path: string
  url: string
  /** The file's SHA-256, lowercase hex. */
  sha256: string
}

/** A device SDK release and the packages it needs, as `mip` would install them. */
export type Sdk = {
  version: string
  files: readonly SdkFile[]
}

const RELEASE = "https://github.com/qualithm/device-sdk-py/releases/download"
const INDEX = "https://micropython.org/pi/v2/file"

const sdkFile = (version: string, module: string, sha256: string): SdkFile => ({
  path: `/lib/qualithm_device/${module}.mpy`,
  url: `${RELEASE}/${version}/qualithm_device.${module}.mpy`,
  sha256
})

const indexFile = (path: string, sha256: string): SdkFile => ({
  path,
  url: `${INDEX}/${sha256.slice(0, 2)}/${sha256.slice(0, 8)}`,
  sha256
})

const SDK_VERSION = "0.2.0"

/** Each module of the release and its SHA-256. */
const SDK_MODULES: readonly (readonly [string, string])[] = [
  ["__init__", "5ad20f88fec73b21b1bac55593acc7e492de19a365a0dd2ee5a9b75ff2ccd999"],
  ["_backoff", "424c0e9793cac20f6d62c56eed1c75d8e20e515ef83322fcd938b0d5bc0f9a70"],
  ["_capability", "d67c2b42f06ef36390c076bd40c600271eb16973098c2dc1a5cfd6b1e04ccd58"],
  ["_credential", "acb4c7a2ae566a41bf0e75bbeda6b164196863e09eb118158effff9ac3017caa"],
  ["_device", "91378951974c63c8f8575ac640c6c06d01ed20915c278e96df8238164e22136f"],
  ["_errors", "5ca6bc4b558f05257cf74838a3cfe9d7ffdc9737210706a2254807b0a7aba3be"],
  ["_provision", "ab702bb8684f61b31e8f322f380d6b6bf5c891b4e018e200e24bba58e2468e7a"],
  ["_roots", "76c07bf0f2b9267b8ed3cc5f96800b4c690bde6dd78dcf600d4d73093c15c0a8"],
  ["_subject", "64fdfef573256093ee31fbe2ce5ab0994464d11606fe4f812465ec327b4e6280"],
  ["_time", "d7bcc5a5c2fa8e9c1909644fce69c960688725f5dcdb90b78eaf557c1f69e4f6"],
  ["interfaces", "b6ddf6d4fb8bbd2b78e3208bbcf5381fad8f416402a439995bffa0bb328b2ee3"],
  ["pico", "74759fbed7164e31ab55a1b1e5cb16d39a0e5f07b5a5456b69d22441decb70a6"],
  ["ui", "f64ac5f06ae124d59dbd7f0c8715b526c3b7ae5e3ac283da618ee69569ea85d1"]
]

/** The Qualithm Device SDK for MicroPython, built for the MicroPython deploy flashes. */
export const DEVICE_SDK: Sdk = {
  version: SDK_VERSION,
  files: [
    ...SDK_MODULES.map(([module, sha256]) => sdkFile(SDK_VERSION, module, sha256)),
    // umqtt.simple 1.8.0 from micropython-lib, the SDK's one dependency.
    indexFile("/lib/ssl.mpy", "d53a3211a6645705f915f879200eda2ecd93d95964efc154c0c9ed6e6c361405"),
    indexFile(
      "/lib/umqtt/simple.mpy",
      "9240e244db5bceea7a43b7579a8e473cfad72a67ba07e027e421c512b06b90b3"
    )
  ]
}

/** Folders on the board that hold only the SDK, so a deploy clears anything else in them. */
export const SDK_DIRS = ["/lib/qualithm_device", "/lib/umqtt"] as const

/** Folders and files on the board that belong to the SDK a deploy installs. */
export const SDK_PATHS = [...SDK_DIRS.map((d) => `${d}/`), "/lib/ssl.mpy"] as const

/**
 * Says whether a path on the board belongs to the SDK a deploy installs.
 *
 * @param path - absolute on the board
 * @returns true when a project may not hold it
 */
export function isSdkPath(path: string): boolean {
  return SDK_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p))
}

/**
 * Returns the SDK's files, from the cache or by downloading them, each checked against its
 * pinned checksum.
 *
 * @param sdk - the release
 * @param config - cache folder and download
 * @returns the files, at their paths on the board
 * @throws {CliError} when a download fails or doesn't match
 */
export async function loadSdk(
  sdk: Sdk = DEVICE_SDK,
  config: FirmwareConfig = defaultFirmwareConfig()
): Promise<ProjectFile[]> {
  const label = `Qualithm Device SDK ${sdk.version}`
  return Promise.all(
    sdk.files.map(async (file) => ({
      path: file.path,
      bytes: await loadPinned(
        { label: `${label} (${file.path})`, url: file.url, sha256: file.sha256, ext: ".mpy" },
        config
      )
    }))
  )
}
