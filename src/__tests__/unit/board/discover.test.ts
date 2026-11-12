import { describe, expect, it } from "vitest"

import { findBootselDrives } from "../../../board/bootsel.ts"
import {
  defaultDiscoverHost,
  type DiscoverHost,
  isEsp32Port,
  isMicroPythonEsp32Port,
  listSerialPorts,
  parseIoreg,
  parseWindowsPorts,
  sameSerial,
  type SerialInfo
} from "../../../board/discover.ts"
import { CliError } from "../../../envelope.ts"

function host(
  platform: NodeJS.Platform,
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
  links: Record<string, string> = {},
  output = ""
): DiscoverHost & { commands: string[][] } {
  const commands: string[][] = []
  return {
    platform,
    commands,
    run: async (command, args) => {
      commands.push([command, ...args])
      return Promise.resolve(output)
    },
    readdir: async (path) => {
      const names = dirs[path]
      return names === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(names)
    },
    readFile: async (path) => {
      const text = files[path]
      return text === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(text)
    },
    realpath: async (path) => {
      const target = links[path]
      return target === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(target)
    }
  }
}

// Shaped like `ioreg -r -c IOUSBHostDevice -l -w0`: a hub whose subtree holds a board, then the
// same board again as its own root.
const IOREG = [
  "+-o USB4206 Smart Hub@00100000  <class IOUSBHostDevice, id 0x10>",
  "  | {",
  '  |   "idProduct" = 16902',
  '  |   "idVendor" = 1060',
  "  | }",
  "  | ",
  "  +-o Board in FS mode@00110000  <class IOUSBHostDevice, id 0x11>",
  "  | | {",
  '  | |   "idProduct" = 5',
  '  | |   "USB Product Name" = "Board in FS mode"',
  '  | |   "idVendor" = 11914',
  '  | |   "USB Serial Number" = "pico-serial"',
  "  | | }",
  "  | +-o IOUSBHostInterface@1  <class IOUSBHostInterface, id 0x12>",
  "  |   | {",
  '  |   |   "idProduct" = 5',
  '  |   |   "idVendor" = 11914',
  "  |   | }",
  "  |   +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x13>",
  "  |         {",
  '  |           "IOCalloutDevice" = "/dev/cu.usbmodem1101"',
  "  |         }",
  "  +-o Ethernet@00140000  <class IOUSBHostDevice, id 0x14>",
  '      "idVendor" = 3034',
  '      "idProduct" = 33107',
  "+-o Board in FS mode@00110000  <class IOUSBHostDevice, id 0x11>",
  '  |   "idProduct" = 5',
  '  |   "idVendor" = 11914',
  '  |   "USB Serial Number" = "pico-serial"',
  "  +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x13>",
  '        "IOCalloutDevice" = "/dev/cu.usbmodem1101"',
  "+-o UART bridge@00130000  <class IOUSBHostDevice, id 0x15>",
  '  |   "idProduct" = 21972',
  '  |   "idVendor" = 6790',
  "  +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x16>",
  '        "IOCalloutDevice" = "/dev/cu.usbserial-1"',
  "+-o Bluetooth  <class IOSerialBSDClient, id 0x17>",
  '    "IOCalloutDevice" = "/dev/cu.Bluetooth-Incoming-Port"'
].join("\n")

describe("parseIoreg", () => {
  it("gives each port the USB device nearest above it, once", () => {
    expect(parseIoreg(IOREG)).toEqual([
      {
        path: "/dev/cu.usbmodem1101",
        vendorId: "2e8a",
        productId: "0005",
        serialNumber: "pico-serial"
      },
      { path: "/dev/cu.usbserial-1", vendorId: "1a86", productId: "55d4" }
    ])
  })
})

describe("parseWindowsPorts", () => {
  it("reads a composite board's serial from its parent", () => {
    const json = JSON.stringify([
      {
        InstanceId: "USB\\VID_2E8A&PID_0005&MI_00\\6&1F2E3D4C&0&0000",
        FriendlyName: "USB Serial Device (COM5)",
        Parent: "USB\\VID_2E8A&PID_0005\\PICO-SERIAL"
      },
      {
        InstanceId: "USB\\VID_1A86&PID_55D4\\5&2A&0&3",
        FriendlyName: "USB-SERIAL CH340 (COM7)",
        Parent: "USB\\ROOT_HUB30\\4&1"
      },
      { InstanceId: "ACPI\\PNP0501\\1", FriendlyName: "Communications Port (COM1)" },
      { InstanceId: "USB\\VID_2341&PID_0070\\NANO", FriendlyName: "No port here" }
    ])
    expect(parseWindowsPorts(json)).toEqual([
      { path: "COM5", vendorId: "2e8a", productId: "0005", serialNumber: "PICO-SERIAL" },
      { path: "COM7", vendorId: "1a86", productId: "55d4" }
    ])
  })

  it("takes the serial from the port itself when it isn't composite", () => {
    const json = JSON.stringify({
      InstanceId: "USB\\VID_2341&PID_0070\\NANO123",
      FriendlyName: "USB Serial Device (COM9)"
    })
    expect(parseWindowsPorts(json)).toEqual([
      { path: "COM9", vendorId: "2341", productId: "0070", serialNumber: "NANO123" }
    ])
  })

  it.each(["", "  \n", "null", "[]"])("reads %j as no ports", (text) => {
    expect(parseWindowsPorts(text)).toEqual([])
  })
})

describe("listSerialPorts", () => {
  it("asks ioreg on macOS", async () => {
    const mac = host("darwin", {}, {}, {}, IOREG)
    expect(await listSerialPorts(mac)).toHaveLength(2)
    expect(mac.commands).toEqual([["ioreg", "-r", "-c", "IOUSBHostDevice", "-l", "-w0"]])
  })

  it("asks PowerShell on Windows", async () => {
    const win = host("win32", {}, {}, {}, "[]")
    expect(await listSerialPorts(win)).toEqual([])
    expect(win.commands[0]?.[0]).toBe("powershell.exe")
  })

  it("walks sysfs up to the USB device on Linux", async () => {
    const usb = "/sys/devices/pci0000:00/usb1/1-1/1-1.2"
    const linux = host(
      "linux",
      {
        [`${usb}/idVendor`]: "2e8a\n",
        [`${usb}/idProduct`]: "0005\n",
        [`${usb}/serial`]: "pico-serial\n",
        "/sys/devices/pci0000:00/usb1/1-1/1-1.3/idVendor": "1A86\n",
        "/sys/devices/pci0000:00/usb1/1-1/1-1.3/idProduct": "55D4\n"
      },
      { "/sys/class/tty": ["ttyS0", "ttyACM0", "ttyUSB0", "ttyACM1", "ttyACM2", "tty1"] },
      {
        "/sys/class/tty/ttyACM0/device": `${usb}/1-1.2:1.0`,
        "/sys/class/tty/ttyUSB0/device": "/sys/devices/pci0000:00/usb1/1-1/1-1.3/1-1.3:1.0/ttyUSB0",
        "/sys/class/tty/ttyACM1/device": "/sys/devices/virtual/nowhere"
      }
    )
    expect(await listSerialPorts(linux)).toEqual([
      { path: "/dev/ttyACM0", vendorId: "2e8a", productId: "0005", serialNumber: "pico-serial" },
      { path: "/dev/ttyUSB0", vendorId: "1a86", productId: "55d4" }
    ])
  })

  it("wraps a failed OS query", async () => {
    const broken: DiscoverHost = {
      ...host("darwin"),
      run: async () => Promise.reject(new Error("ioreg: not found"))
    }
    await expect(listSerialPorts(broken)).rejects.toEqual(
      new CliError("list serial ports: ioreg: not found", "error")
    )
  })

  it("refuses an OS it doesn't know", async () => {
    await expect(listSerialPorts(host("freebsd"))).rejects.toThrow(
      "listing boards isn't supported on freebsd"
    )
  })

  it("runs real commands by default", async () => {
    await expect(
      defaultDiscoverHost.run("node", ["-e", "process.stdout.write('hi')"])
    ).resolves.toBe("hi")
    await expect(defaultDiscoverHost.readdir(import.meta.dirname)).resolves.toContain(
      "discover.test.ts"
    )
    await expect(defaultDiscoverHost.readFile(import.meta.filename)).resolves.toContain(
      "parseIoreg"
    )
    await expect(defaultDiscoverHost.realpath(import.meta.filename)).resolves.toContain(
      "discover.test.ts"
    )
  })
})

describe("findBootselDrives", () => {
  const info = "UF2 Bootloader v1.0\nModel: Raspberry Pi RP2350\nBoard-ID: RP2350\n"

  it("finds an RP2350 drive among macOS volumes", async () => {
    const mac = host(
      "darwin",
      { "/Volumes/RP2350/INFO_UF2.TXT": info, "/Volumes/OTHER/INFO_UF2.TXT": "Board-ID: RPI-RP2" },
      { "/Volumes": ["Macintosh HD", "RP2350", "OTHER"] }
    )
    await expect(findBootselDrives(mac, "ada")).resolves.toEqual([
      { path: "/Volumes/RP2350", model: "Raspberry Pi RP2350" }
    ])
  })

  it("looks in the Linux media folders", async () => {
    const linux = host(
      "linux",
      { "/media/ada/RP2350/INFO_UF2.TXT": "Board-ID: RP2350\n" },
      { "/media/ada": ["RP2350"], "/media": ["ada"] }
    )
    await expect(findBootselDrives(linux, "ada")).resolves.toEqual([{ path: "/media/ada/RP2350" }])
  })

  it("checks drive letters on Windows", async () => {
    const win = host("win32", { "E:\\INFO_UF2.TXT": info })
    await expect(findBootselDrives(win, "ada")).resolves.toEqual([
      { path: "E:\\", model: "Raspberry Pi RP2350" }
    ])
  })

  it("finds nothing on an OS it doesn't know", async () => {
    await expect(findBootselDrives(host("freebsd"), "ada")).resolves.toEqual([])
  })

  it("defaults to the current user", async () => {
    await expect(findBootselDrives(host("linux"))).resolves.toEqual([])
  })
})

describe("ESP32 ports", () => {
  const port = (vendorId: string, productId: string): SerialInfo => ({
    path: "/dev/x",
    vendorId,
    productId
  })

  it("takes the built-in USB serial unit and the CH9102 bridge as ESP32s", () => {
    expect(isEsp32Port(port("303a", "1001"))).toBe(true)
    expect(isEsp32Port(port("1a86", "55d4"))).toBe(true)
    expect(isEsp32Port(port("303a", "4001"))).toBe(false)
    expect(isEsp32Port(port("1a86", "7523"))).toBe(false)
    expect(isEsp32Port(port("2e8a", "0005"))).toBe(false)
  })

  it("knows MicroPython's own ESP32 port", () => {
    expect(isMicroPythonEsp32Port(port("303a", "4001"))).toBe(true)
    expect(isMicroPythonEsp32Port(port("303a", "1001"))).toBe(false)
  })
})

describe("sameSerial", () => {
  it("matches an ESP32-S3's ROM and MicroPython serial numbers", () => {
    expect(sameSerial("44:1B:F6:F5:52:1C", "441bf6f5521c0000")).toBe(true)
    expect(sameSerial("441bf6f5521c0000", "44:1B:F6:F5:52:1C")).toBe(true)
    expect(sameSerial("44:1B:F6:F5:52:1C", "9C:CC:01:33:91:AC")).toBe(false)
  })

  it("compares short or non-hex serial numbers whole, ignoring case", () => {
    expect(sameSerial("PICO-SERIAL", "pico-serial")).toBe(true)
    expect(sameSerial("abc", "abcd")).toBe(false)
  })
})
