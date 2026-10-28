import { describe, expect, it } from "vitest"

import { knownNetworks, nmcliFields, savedPassphrase, type WifiHost } from "../../../board/wifi.ts"

/** A host that answers each command line from `answers`, and fails any other. */
function host(
  platform: NodeJS.Platform,
  answers: Record<string, string>
): WifiHost & { ran: string[] } {
  const ran: string[] = []
  return {
    platform,
    ran,
    run: async (command, args) => {
      const line = [command, ...args].join(" ")
      ran.push(line)
      const answer = answers[line]
      return answer === undefined ? Promise.reject(new Error("exit 1")) : Promise.resolve(answer)
    }
  }
}

const MAC_PORTS =
  "Hardware Port: Ethernet\nDevice: en0\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: x\n"

describe("knownNetworks", () => {
  it("lists a Mac's saved networks when it hides the current one", async () => {
    const mac = host("darwin", {
      "networksetup -listallhardwareports": MAC_PORTS,
      "ipconfig getsummary en1": "  InterfaceType : WiFi\n  SSID : <redacted>\n",
      "networksetup -listpreferredwirelessnetworks en1":
        "Preferred networks on en1:\n\tHome\n\tCafe\n"
    })
    expect(await knownNetworks(mac)).toEqual(["Home", "Cafe"])
  })

  it("puts a Mac's current network first when it shows it", async () => {
    const mac = host("darwin", {
      "networksetup -listallhardwareports": MAC_PORTS,
      "ipconfig getsummary en1": "  SSID : Cafe\n",
      "networksetup -listpreferredwirelessnetworks en1":
        "Preferred networks on en1:\n\tHome\n\tCafe\n"
    })
    expect(await knownNetworks(mac)).toEqual(["Cafe", "Home"])
  })

  it("knows nothing on a Mac with no Wi-Fi", async () => {
    expect(
      await knownNetworks(host("darwin", { "networksetup -listallhardwareports": "" }))
    ).toEqual([])
  })

  it("reads NetworkManager on Linux, active network first", async () => {
    const linux = host("linux", {
      "nmcli -t -f ACTIVE,SSID dev wifi": "no:Other\nyes:Home\\:5G\n",
      "nmcli -t -f NAME,TYPE connection show":
        "Wired:802-3-ethernet\nHome\\:5G:802-11-wireless\nCafe:802-11-wireless\n"
    })
    expect(await knownNetworks(linux)).toEqual(["Home:5G", "Cafe"])
  })

  it("reads netsh on Windows, current network first", async () => {
    const windows = host("win32", {
      "netsh wlan show interfaces": "    Name : Wi-Fi\r\n    BSSID : aa\r\n    SSID : Home\r\n",
      "netsh wlan show profiles":
        "    All User Profile     : Cafe\r\n    All User Profile     : Home\r\n"
    })
    expect(await knownNetworks(windows)).toEqual(["Home", "Cafe"])
  })

  it("knows nothing where its tools are missing or on another OS", async () => {
    expect(await knownNetworks(host("linux", {}))).toEqual([])
    expect(await knownNetworks(host("win32", {}))).toEqual([])
    expect(await knownNetworks(host("freebsd", {}))).toEqual([])
  })
})

describe("savedPassphrase", () => {
  it("reads a Mac's keychain", async () => {
    const mac = host("darwin", {
      "security find-generic-password -D AirPort network password -a Home -w": "pass word\n"
    })
    expect(await savedPassphrase("Home", mac)).toBe("pass word")
  })

  it("reads NetworkManager's secret on Linux", async () => {
    const linux = host("linux", {
      "nmcli -s -g 802-11-wireless-security.psk connection show Home": "secret\n"
    })
    expect(await savedPassphrase("Home", linux)).toBe("secret")
  })

  it("reads a Windows profile's key", async () => {
    const windows = host("win32", {
      "netsh wlan show profile name=Home key=clear": "    Key Content            : s3cret\r\n"
    })
    expect(await savedPassphrase("Home", windows)).toBe("s3cret")
  })

  it("has none when the OS refuses, has nothing, or is another OS", async () => {
    expect(await savedPassphrase("Home", host("darwin", {}))).toBeUndefined()
    expect(
      await savedPassphrase(
        "Home",
        host("linux", { "nmcli -s -g 802-11-wireless-security.psk connection show Home": "\n" })
      )
    ).toBeUndefined()
    expect(await savedPassphrase("Home", host("win32", {}))).toBeUndefined()
    expect(await savedPassphrase("Home", host("freebsd", {}))).toBeUndefined()
  })
})

describe("nmcliFields", () => {
  it("splits on unescaped colons only", () => {
    expect(nmcliFields("a\\:b:c")).toEqual(["a:b", "c"])
  })
})
