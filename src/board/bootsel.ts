import { userInfo } from "node:os"
import { join } from "node:path"

import type { DiscoverHost } from "./discover.ts"

/** An RP2350 in BOOTSEL mode, mounted as a drive that takes a UF2 file. */
export type BootselDrive = {
  /** Where the drive is mounted. */
  path: string
  /** The `Model:` line of the drive's `INFO_UF2.TXT`, when present. */
  model?: string
  /**
   * The chip's unique ID, as the BOOTSEL device's USB serial number reports it: the same ID
   * MicroPython reports once flashed. Read on macOS and Linux.
   */
  serialNumber?: string
}

/** The RP2350's USB identity in BOOTSEL mode: Raspberry Pi's vendor ID, product `000f`. */
const BOOTSEL_VENDOR_ID = 11914
const BOOTSEL_PRODUCT_ID = 15

/**
 * Reads the BOOTSEL devices' USB serial numbers and disks from `ioreg -r -c IOUSBHostDevice -l
 * -w0` output.
 *
 * @param text - the `ioreg` output
 * @returns each device's serial number and the BSD names of the disks below it
 */
export function parseBootselIoreg(text: string): { serialNumber: string; disks: string[] }[] {
  type Node = { depth: number; device?: { props: Map<string, string>; disks: string[] } }
  const stack: Node[] = []
  const devices: { props: Map<string, string>; disks: string[] }[] = []
  for (const line of text.split("\n")) {
    const node = /^([ |]*)\+-o .*<class (\w+)/.exec(line)
    if (node !== null) {
      const depth = node[1]?.length ?? 0
      while ((stack.at(-1)?.depth ?? -1) >= depth) {
        stack.pop()
      }
      const device = node[2] === "IOUSBHostDevice" ? { props: new Map(), disks: [] } : undefined
      if (device !== undefined) {
        devices.push(device)
      }
      stack.push({ depth, ...(device === undefined ? {} : { device }) })
      continue
    }
    const prop = /^[ |]*"([^"]+)" = "?([^"]*)"?$/.exec(line)
    const owner = stack.findLast((n) => n.device !== undefined)?.device
    if (prop === null || owner === undefined) {
      continue
    }
    const [, key = "", value = ""] = prop
    if (key === "BSD Name") {
      owner.disks.push(value)
    } else if (stack.at(-1)?.device === owner) {
      owner.props.set(key, value)
    }
  }
  return devices.flatMap((d) => {
    const serialNumber = d.props.get("USB Serial Number")
    const ours =
      Number(d.props.get("idVendor")) === BOOTSEL_VENDOR_ID &&
      Number(d.props.get("idProduct")) === BOOTSEL_PRODUCT_ID
    return ours && serialNumber !== undefined ? [{ serialNumber, disks: d.disks }] : []
  })
}

/**
 * Reads `mount` output into each mount point's device, e.g. `/Volumes/RP2350` to `disk4s1`.
 *
 * @param text - the `mount` output
 * @returns the device under `/dev` for each mount point
 */
export function parseMounts(text: string): Map<string, string> {
  const mounts = new Map<string, string>()
  for (const line of text.split("\n")) {
    const found = /^\/dev\/(\S+) on (.+) \(/.exec(line)
    if (found !== null) {
      mounts.set(found[2] ?? "", found[1] ?? "")
    }
  }
  return mounts
}

type Lsblk = { mountpoint?: string | null; serial?: string | null; children?: Lsblk[] }

/**
 * Reads `lsblk -J -o PATH,SERIAL,MOUNTPOINT` output into each mount point's disk serial number.
 *
 * @param text - the `lsblk` output
 * @returns the serial number of the disk under each mount point
 */
export function parseLsblk(text: string): Map<string, string> {
  const serials = new Map<string, string>()
  const walk = (devices: Lsblk[], serial: string | undefined): void => {
    for (const d of devices) {
      const own = d.serial ?? serial
      if (typeof d.mountpoint === "string" && own !== undefined) {
        serials.set(d.mountpoint, own)
      }
      walk(d.children ?? [], own)
    }
  }
  const parsed = JSON.parse(text) as { blockdevices?: Lsblk[] }
  walk(parsed.blockdevices ?? [], undefined)
  return serials
}

/**
 * The USB serial number of the BOOTSEL device behind each mounted drive, where the OS says.
 *
 * @param host - what to read
 * @returns the serial number for each mount point; empty when the OS can't say
 */
async function bootselSerials(host: DiscoverHost): Promise<Map<string, string>> {
  try {
    if (host.platform === "darwin") {
      const devices = parseBootselIoreg(
        await host.run("ioreg", ["-r", "-c", "IOUSBHostDevice", "-l", "-w0"])
      )
      const serials = new Map<string, string>()
      for (const [mount, disk] of parseMounts(await host.run("mount", []))) {
        const device = devices.find((d) =>
          d.disks.some((name) => disk === name || disk.startsWith(`${name}s`))
        )
        if (device !== undefined) {
          serials.set(mount, device.serialNumber)
        }
      }
      return serials
    }
    if (host.platform === "linux") {
      return parseLsblk(await host.run("lsblk", ["-J", "-o", "PATH,SERIAL,MOUNTPOINT"]))
    }
  } catch {
    // The drive is still listed, only without its serial number.
  }
  return new Map()
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
  let serials: Map<string, string> | undefined
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
    serials ??= await bootselSerials(host)
    const serialNumber = serials.get(root.replace(/[\\/]$/, ""))
    drives.push({
      path: root,
      ...(model === undefined ? {} : { model }),
      ...(serialNumber === undefined ? {} : { serialNumber })
    })
  }
  return drives
}
