import { execFile } from "node:child_process"
import { readdir, readFile, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { CliError } from "../envelope.ts"

/** A USB serial port the OS reports, with the USB identity of the device behind it. */
export type SerialInfo = {
  /** What to open: a device path, or `COMn` on Windows. */
  path: string
  /** USB vendor ID, four lowercase hex digits. */
  vendorId: string
  /** USB product ID, four lowercase hex digits. */
  productId: string
  /** The device's USB serial number, when it reports one. */
  serialNumber?: string
}

/** What discovery reads from the machine; the real OS by default. */
export type DiscoverHost = {
  platform: NodeJS.Platform
  run: (command: string, args: readonly string[]) => Promise<string>
  readdir: (path: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
  realpath: (path: string) => Promise<string>
}

export const defaultDiscoverHost: DiscoverHost = {
  platform: process.platform,
  run: async (command, args) => {
    const { stdout } = await promisify(execFile)(command, args, { maxBuffer: 16 * 1024 * 1024 })
    return stdout
  },
  readdir: async (path) => readdir(path),
  readFile: async (path) => readFile(path, "utf8"),
  realpath: async (path) => realpath(path)
}

const hex4 = (value: number): string => value.toString(16).padStart(4, "0")

type IoregNode = { depth: number; usbDevice: boolean; props: Map<string, string> }

/**
 * Reads serial ports from `ioreg -r -c IOUSBHostDevice -l -w0` output. Each port takes the USB
 * identity of the nearest USB device above it, so a board behind a hub isn't reported as the hub.
 *
 * @param text - the `ioreg` output
 * @returns the ports, one per callout device
 */
export function parseIoreg(text: string): SerialInfo[] {
  const stack: IoregNode[] = []
  const ports = new Map<string, SerialInfo>()
  for (const line of text.split("\n")) {
    const node = /^([ |]*)\+-o .*<class (\w+)/.exec(line)
    if (node !== null) {
      const depth = node[1]?.length ?? 0
      while ((stack.at(-1)?.depth ?? -1) >= depth) {
        stack.pop()
      }
      stack.push({ depth, usbDevice: node[2] === "IOUSBHostDevice", props: new Map() })
      continue
    }
    const prop = /^[ |]*"([^"]+)" = (.*)$/.exec(line)
    const current = stack.at(-1)
    if (prop === null || current === undefined) {
      continue
    }
    const [, key = "", raw = ""] = prop
    const value = raw.replace(/^"(.*)"$/, "$1")
    if (key !== "IOCalloutDevice") {
      current.props.set(key, value)
      continue
    }
    const device = stack.findLast((n) => n.usbDevice)
    const vendor = Number(device?.props.get("idVendor"))
    const product = Number(device?.props.get("idProduct"))
    if (device === undefined || !Number.isInteger(vendor) || !Number.isInteger(product)) {
      continue
    }
    const serialNumber = device.props.get("USB Serial Number")
    ports.set(value, {
      path: value,
      vendorId: hex4(vendor),
      productId: hex4(product),
      ...(serialNumber === undefined ? {} : { serialNumber })
    })
  }
  return [...ports.values()]
}

/** One entry of the PowerShell query `listWindows` runs. */
type PnpPort = { InstanceId?: string; FriendlyName?: string; Parent?: string }

const WINDOWS_QUERY = [
  "$ports = @(Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {",
  "[pscustomobject]@{ InstanceId = $_.InstanceId; FriendlyName = $_.FriendlyName;",
  "Parent = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_Parent).Data } })",
  "ConvertTo-Json -Compress -InputObject $ports"
].join(" ")

function usbSerial(instanceId: string | undefined): string | undefined {
  // `USB\VID_2E8A&PID_0005\<serial>`; an ID the OS made up for a port without one contains `&`.
  const match = /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\([^\\&]+)$/i.exec(instanceId ?? "")
  return match?.[1]
}

/**
 * Reads serial ports from the JSON the Windows PnP query prints.
 *
 * @param text - the query's output
 * @returns the USB ports among them
 */
export function parseWindowsPorts(text: string): SerialInfo[] {
  const trimmed = text.trim()
  if (trimmed === "") {
    return []
  }
  const parsed = JSON.parse(trimmed) as PnpPort | PnpPort[] | null
  const entries = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]
  const ports: SerialInfo[] = []
  for (const entry of entries) {
    const com = /\((COM\d+)\)/.exec(entry.FriendlyName ?? "")?.[1]
    const ids = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(entry.InstanceId ?? "")
    if (com === undefined || ids === null) {
      continue
    }
    const serialNumber = usbSerial(entry.InstanceId) ?? usbSerial(entry.Parent)
    ports.push({
      path: com,
      vendorId: (ids[1] ?? "").toLowerCase(),
      productId: (ids[2] ?? "").toLowerCase(),
      ...(serialNumber === undefined ? {} : { serialNumber })
    })
  }
  return ports
}

async function tryRead(host: DiscoverHost, path: string): Promise<string | undefined> {
  try {
    return (await host.readFile(path)).trim()
  } catch {
    return undefined
  }
}

async function listLinux(host: DiscoverHost): Promise<SerialInfo[]> {
  const names = (await host.readdir("/sys/class/tty")).filter((n) => /^tty(ACM|USB)\d+$/.test(n))
  const ports: SerialInfo[] = []
  for (const name of names.sort()) {
    let dir: string
    try {
      dir = await host.realpath(`/sys/class/tty/${name}/device`)
    } catch {
      continue
    }
    // The tty's device is a USB interface; the IDs sit on the USB device a level or two up.
    for (let level = 0; level < 4 && dir !== "/"; level++, dir = dirname(dir)) {
      const vendorId = await tryRead(host, join(dir, "idVendor"))
      const productId = await tryRead(host, join(dir, "idProduct"))
      if (vendorId !== undefined && productId !== undefined) {
        const serialNumber = await tryRead(host, join(dir, "serial"))
        ports.push({
          path: `/dev/${name}`,
          vendorId: vendorId.toLowerCase(),
          productId: productId.toLowerCase(),
          ...(serialNumber === undefined ? {} : { serialNumber })
        })
        break
      }
    }
  }
  return ports
}

/**
 * Lists the USB serial ports on this machine.
 *
 * @param host - what to read; the real OS by default
 * @returns the ports
 * @throws {CliError} on an unsupported OS, or when the OS query fails
 */
export async function listSerialPorts(
  host: DiscoverHost = defaultDiscoverHost
): Promise<SerialInfo[]> {
  try {
    if (host.platform === "darwin") {
      return parseIoreg(await host.run("ioreg", ["-r", "-c", "IOUSBHostDevice", "-l", "-w0"]))
    }
    if (host.platform === "linux") {
      return await listLinux(host)
    }
    if (host.platform === "win32") {
      return parseWindowsPorts(
        await host.run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_QUERY
        ])
      )
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(`list serial ports: ${reason}`, "error")
  }
  throw new CliError(`listing boards isn't supported on ${host.platform}`, "error")
}
