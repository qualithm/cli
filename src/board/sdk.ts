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

const SDK_VERSION = "0.10.0"

/** Each module of the release and its SHA-256. */
const SDK_MODULES: readonly (readonly [string, string])[] = [
  ["__init__", "7bd0f5235a7a6a6349723bbddb198483ac5a6909a8fdf28f241bf5638d39f634"],
  ["_backoff", "424c0e9793cac20f6d62c56eed1c75d8e20e515ef83322fcd938b0d5bc0f9a70"],
  ["_capability", "bfeb819beda64f0c419dd1e5faf52c7260342b521babfff176e0305bc5cbeec3"],
  ["_credential", "0b79a07410cac8549dca50079c0986b09e1ddf46d9c7de58bafc916f29012f75"],
  ["_device", "a413ff02d5090ec74906842365116a8565fbe596b5cee07ba515b05432c3d04c"],
  ["_errors", "1952c3b118f8d0c121e3925435171ec20ed11d96b07ceb08601eabd80a679811"],
  ["_micropython", "e7e2f847aeb21a60f240357e0f508d7e5cfb4d1c18e360cb4a35c2f32cc916ae"],
  ["_onboard", "cf0364075a3fdc899704cf9f70461aee56442c228698a3af799303a1554a72e8"],
  ["_provision", "01d5367569a3c865708b5c59003d5b431326c7f3504c7dabab450c54d7a9e4a9"],
  ["_roots", "76c07bf0f2b9267b8ed3cc5f96800b4c690bde6dd78dcf600d4d73093c15c0a8"],
  ["_subject", "6aa20f20b336dc89c6790293d66d224f686fde6b4e38c6dc01621477d1e4cc72"],
  ["_time", "7af5a7a627e00423dd4908dcb34cc3814a8fae6ef0a539fad15e3b4a10c1a9ab"],
  ["board", "d32e166da6737b97582172f1b1d70c2726e666998c162e74e39cc08c2dd6a83c"],
  ["esp32", "85c953a5892f8083893f43dba86d9e3f2c5c14031f4a83ea06b357e957a5aa25"],
  ["interfaces", "f2c0224899abdb26ea68b0fa882fe7b5440aacdf5c12e67af28a1d20df34e526"],
  ["pico", "5be9da3ccab65408e3a7b7dbfd3ab0dce67b57a7ce00ab744ffef93dfdc7c3e6"],
  ["ui", "6855b6b90dcf742314fea3b4c355d1f158187282c98ab8bfa69014af545cd270"],
  ["virtual", "85f5417c7327003658ad94da8ca40055ffdc6b8c68d08b0b2913a7c9e4501557"]
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

/** The SDK's own package on the board, which a Qualithm firmware may freeze in instead. */
export const SDK_PACKAGE_DIR = "/lib/qualithm_device"

/**
 * The board-side check for an SDK frozen into the firmware: prints the release the firmware's
 * `qualithm_firmware` module names, or an empty line on firmware without one.
 */
export const FROZEN_SDK_PROBE = `try:
    import qualithm_firmware
    print(qualithm_firmware.SDK_VERSION)
except ImportError:
    print("")`

/** Folders on the board that hold only the SDK, so a deploy clears anything else in them. */
export const SDK_DIRS = [SDK_PACKAGE_DIR, "/lib/umqtt"] as const

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
  config: FirmwareConfig = defaultFirmwareConfig
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

/** A device SDK release, its files loaded and checked, as a deploy sends it to the core. */
export type LoadedSdk = {
  version: string
  files: ProjectFile[]
}

/**
 * Loads the device SDK release a deploy installs, from the cache or by downloading it.
 *
 * @param sdk - the release; the one this CLI pins by default
 * @param config - cache folder and download
 * @returns the release and its files
 * @throws {CliError} when a download fails or doesn't match
 */
export async function loadDeviceSdk(
  sdk: Sdk = DEVICE_SDK,
  config: FirmwareConfig = defaultFirmwareConfig
): Promise<LoadedSdk> {
  return { version: sdk.version, files: await loadSdk(sdk, config) }
}
