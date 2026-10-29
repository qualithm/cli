import { chmod } from "node:fs/promises"
import { join } from "node:path"

import { CliError } from "../envelope.ts"
import { defaultFirmwareConfig, type FirmwareConfig, loadPinned } from "./firmware.ts"

/** A host a virtual device runs on, as the runtime's release names it. */
export type RuntimeTarget = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64"

/** The MicroPython Unix port a virtual device runs on, pinned per host. */
export type Runtime = {
  version: string
  /** Each host's build and its SHA-256, lowercase hex. */
  builds: Readonly<Record<RuntimeTarget, string>>
}

const RELEASE = "https://github.com/qualithm/device-sdk-py/releases/download"

/** The Unix port device-sdk-py 0.3.1 released, the release its CI tested the SDK against. */
export const MICROPYTHON_UNIX: Runtime & { release: string } = {
  version: "1.29.0",
  release: "0.3.1",
  builds: {
    "darwin-arm64": "787ab8f5033b4b9722409394fbd1d20cdc756fb202006a9acc4ae79421273313",
    "darwin-x64": "9d250c8054e62131c15adb43cc197460ad8659414c69e21eb6e4182df129dccd",
    "linux-arm64": "42d0343266ea4983785c0c63d9825b846e2c5ba6fee817bc635262c8e51a68f5",
    "linux-x64": "f7904fa7408034907d78f385ae028515cb6ac808029fd1f49ae823d699b88e90"
  }
}

/**
 * The runtime build for a host.
 *
 * @param platform - the OS
 * @param arch - the CPU
 * @returns the target
 * @throws {CliError} when no build runs there, such as on Windows
 */
export function runtimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): RuntimeTarget {
  const os = platform === "darwin" || platform === "linux" ? platform : undefined
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined
  if (os === undefined || cpu === undefined) {
    const hint = platform === "win32" ? ": run it under WSL" : ""
    throw new CliError(
      `a virtual device runs on macOS or Linux, on arm64 or x64, not ${platform} ${arch}${hint}`,
      "usage"
    )
  }
  return `${os}-${cpu}`
}

/**
 * Returns the path of the runtime for this host, downloading it on first use and checking it
 * against its pinned checksum every time.
 *
 * @param target - the host
 * @param runtime - the pinned builds
 * @param config - cache folder and download
 * @returns an executable path
 * @throws {CliError} when the download fails or doesn't match
 */
export async function loadRuntime(
  target: RuntimeTarget = runtimeTarget(),
  runtime: Runtime & { release: string } = MICROPYTHON_UNIX,
  config: FirmwareConfig = defaultFirmwareConfig
): Promise<string> {
  const sha256 = runtime.builds[target]
  const name = `micropython-${runtime.version}-${target}`
  await loadPinned(
    {
      label: `MicroPython ${runtime.version} for ${target}`,
      url: `${RELEASE}/${runtime.release}/${name}`,
      sha256,
      ext: ".micropython"
    },
    config
  )
  const path = join(config.cache_dir, `${sha256}.micropython`)
  await chmod(path, 0o755)
  return path
}
