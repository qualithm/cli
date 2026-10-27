import { userInfo } from "node:os"
import { join } from "node:path"

import type { DiscoverHost } from "./discover.ts"

/** An RP2350 in BOOTSEL mode, mounted as a drive that takes a UF2 file. */
export type BootselDrive = {
  /** Where the drive is mounted. */
  path: string
  /** The `Model:` line of the drive's `INFO_UF2.TXT`, when present. */
  model?: string
}

async function children(host: DiscoverHost, dir: string): Promise<string[]> {
  try {
    return (await host.readdir(dir)).map((name) => join(dir, name))
  } catch {
    return []
  }
}

async function mountRoots(host: DiscoverHost, user: string): Promise<string[]> {
  if (host.platform === "darwin") {
    return children(host, "/Volumes")
  }
  if (host.platform === "linux") {
    return [
      ...(await children(host, `/media/${user}`)),
      ...(await children(host, `/run/media/${user}`)),
      ...(await children(host, "/media"))
    ]
  }
  if (host.platform === "win32") {
    return Array.from({ length: 24 }, (_, i) => `${String.fromCharCode(67 + i)}:\\`)
  }
  return []
}

/**
 * Finds RP2350 boards waiting in BOOTSEL mode: mounted drives whose `INFO_UF2.TXT` names an
 * RP2350.
 *
 * @param host - what to read
 * @param user - whose removable-media folders to look in on Linux
 * @returns the drives
 */
export async function findBootselDrives(
  host: DiscoverHost,
  user: string = userInfo().username
): Promise<BootselDrive[]> {
  const drives: BootselDrive[] = []
  for (const root of await mountRoots(host, user)) {
    let info: string
    try {
      info = await host.readFile(
        host.platform === "win32" ? `${root}INFO_UF2.TXT` : join(root, "INFO_UF2.TXT")
      )
    } catch {
      continue
    }
    if (!info.includes("RP2350")) {
      continue
    }
    const model = /^Model:\s*(.+?)\s*$/m.exec(info)?.[1]
    drives.push({ path: root, ...(model === undefined ? {} : { model }) })
  }
  return drives
}
