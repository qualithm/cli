import { defaultDiscoverHost } from "./discover.ts"

/** What the Wi-Fi lookup runs on; the real OS by default. */
export type WifiHost = {
  platform: NodeJS.Platform
  /** Runs a command and returns its stdout; rejects when it exits non-zero. */
  run: (command: string, args: readonly string[]) => Promise<string>
}

/** A Wi-Fi network's name and passphrase, as the board needs them. */
export type WifiDetails = { ssid: string; passphrase: string }

export const defaultWifiHost: WifiHost = {
  platform: process.platform,
  run: defaultDiscoverHost.run
}

async function quiet(host: WifiHost, command: string, args: readonly string[]): Promise<string> {
  try {
    return await host.run(command, args)
  } catch {
    // A missing tool or a refused lookup means only that this source knows nothing.
    return ""
  }
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")

async function macInterface(host: WifiHost): Promise<string | undefined> {
  const ports = await quiet(host, "networksetup", ["-listallhardwareports"])
  const match = /Hardware Port: Wi-Fi\s*\nDevice: (\S+)/.exec(ports)
  return match?.[1]
}

/**
 * Splits `nmcli -t` output, where `:` separates fields and `\:` is a literal colon.
 *
 * @param line - one line of terse output
 * @returns the fields
 */
export function nmcliFields(line: string): string[] {
  return line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ":"))
}

/**
 * The laptop's Wi-Fi networks, the likeliest first: the one it is on where the OS says so, then
 * the saved ones in the OS's priority order.
 *
 * @param host - the OS
 * @returns network names, without repeats
 */
export async function knownNetworks(host: WifiHost = defaultWifiHost): Promise<string[]> {
  const read = NETWORKS[host.platform]
  return read === undefined ? [] : [...new Set(await read(host))]
}

async function macNetworks(host: WifiHost): Promise<string[]> {
  const device = await macInterface(host)
  if (device === undefined) {
    return []
  }
  const found: string[] = []
  const summary = await quiet(host, "ipconfig", ["getsummary", device])
  const current = /^\s*SSID : (.+)$/m.exec(summary)?.[1]?.trim()
  // Without location permission macOS redacts the name.
  if (current !== undefined && current !== "<redacted>") {
    found.push(current)
  }
  const saved = await quiet(host, "networksetup", ["-listpreferredwirelessnetworks", device])
  found.push(...lines(saved).filter((l) => !l.startsWith("Preferred networks on")))
  return found
}

async function linuxNetworks(host: WifiHost): Promise<string[]> {
  const found: string[] = []
  const active = await quiet(host, "nmcli", ["-t", "-f", "ACTIVE,SSID", "dev", "wifi"])
  for (const [on, ssid] of lines(active).map(nmcliFields)) {
    if (on === "yes" && ssid !== undefined && ssid !== "") {
      found.push(ssid)
    }
  }
  const saved = await quiet(host, "nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"])
  for (const [name, type] of lines(saved).map(nmcliFields)) {
    if (type === "802-11-wireless" && name !== undefined && name !== "") {
      found.push(name)
    }
  }
  return found
}

async function windowsNetworks(host: WifiHost): Promise<string[]> {
  const found: string[] = []
  const current = await quiet(host, "netsh", ["wlan", "show", "interfaces"])
  const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(current)?.[1]?.trim()
  if (ssid !== undefined && ssid !== "") {
    found.push(ssid)
  }
  const saved = await quiet(host, "netsh", ["wlan", "show", "profiles"])
  for (const match of saved.matchAll(/All User Profile\s*:\s*(.+)/g)) {
    const name = match[1]?.trim()
    if (name !== undefined && name !== "") {
      found.push(name)
    }
  }
  return found
}

const NETWORKS: Partial<Record<NodeJS.Platform, (host: WifiHost) => Promise<string[]>>> = {
  darwin: macNetworks,
  linux: linuxNetworks,
  win32: windowsNetworks
}

/**
 * A saved network's passphrase from the OS's own store. The OS may ask the person to allow it.
 *
 * @param ssid - the network
 * @param host - the OS
 * @returns the passphrase, or undefined when the OS has none or refuses
 */
export async function savedPassphrase(
  ssid: string,
  host: WifiHost = defaultWifiHost
): Promise<string | undefined> {
  let found: string | undefined
  if (host.platform === "darwin") {
    found = await quiet(host, "security", [
      "find-generic-password",
      "-D",
      "AirPort network password",
      "-a",
      ssid,
      "-w"
    ])
  } else if (host.platform === "linux") {
    found = await quiet(host, "nmcli", [
      "-s",
      "-g",
      "802-11-wireless-security.psk",
      "connection",
      "show",
      ssid
    ])
  } else if (host.platform === "win32") {
    const profile = await quiet(host, "netsh", [
      "wlan",
      "show",
      "profile",
      `name=${ssid}`,
      "key=clear"
    ])
    found = /^\s*Key Content\s*:\s*(.+)$/m.exec(profile)?.[1]?.replace(/\r$/, "")
  }
  // Keep inner spaces: they can be part of a passphrase. Only the trailing newline goes.
  const passphrase = found?.replace(/\r?\n$/, "")
  return passphrase === undefined || passphrase === "" ? undefined : passphrase
}
