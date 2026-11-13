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

const SDK_VERSION = "0.9.3"

/** Each module of the release and its SHA-256. */
const SDK_MODULES: readonly (readonly [string, string])[] = [
  ["__init__", "acedb0c11865fdc8273ec799614ca26ff540df7af020a017f6d5f03b5b284954"],
  ["_backoff", "424c0e9793cac20f6d62c56eed1c75d8e20e515ef83322fcd938b0d5bc0f9a70"],
  ["_capability", "bfeb819beda64f0c419dd1e5faf52c7260342b521babfff176e0305bc5cbeec3"],
  ["_credential", "d8a6a933b3b0a3a69637976924687256f59b051ec66e3ef556238a11ecde5a94"],
  ["_device", "8e75077ce0eb99bcfca5652f790c1b48bfbe934a5a7561ed5375a38d171a1d4f"],
  ["_errors", "1952c3b118f8d0c121e3925435171ec20ed11d96b07ceb08601eabd80a679811"],
  ["_micropython", "e7e2f847aeb21a60f240357e0f508d7e5cfb4d1c18e360cb4a35c2f32cc916ae"],
  ["_onboard", "cf0364075a3fdc899704cf9f70461aee56442c228698a3af799303a1554a72e8"],
  ["_provision", "0b039f33a354a9552ca8302562b2263c33ccfc98d58306fa27cd549cc553be44"],
  ["_roots", "76c07bf0f2b9267b8ed3cc5f96800b4c690bde6dd78dcf600d4d73093c15c0a8"],
  ["_subject", "6aa20f20b336dc89c6790293d66d224f686fde6b4e38c6dc01621477d1e4cc72"],
  ["_time", "7af5a7a627e00423dd4908dcb34cc3814a8fae6ef0a539fad15e3b4a10c1a9ab"],
  ["board", "d32e166da6737b97582172f1b1d70c2726e666998c162e74e39cc08c2dd6a83c"],
  ["esp32", "a28fcba546bbe5d4a8879e984fc5b323910bac65862a32b55bf8557bc7b5496b"],
  ["interfaces", "f2c0224899abdb26ea68b0fa882fe7b5440aacdf5c12e67af28a1d20df34e526"],
  ["pico", "6bd4a4559a7b97da1bc4c53ad4306939833229f50eeeb3966954f9c3b2d24691"],
  ["ui", "f64ac5f06ae124d59dbd7f0c8715b526c3b7ae5e3ac283da618ee69569ea85d1"],
  ["virtual", "9689951dc6f95d6d8a3e0c72e94a73d2bfe170440acc999872d1f7b91c7a3f98"]
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
