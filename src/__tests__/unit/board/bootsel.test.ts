import { describe, expect, it } from "vitest"

import {
  findBootselDrives,
  parseBootselIoreg,
  parseLsblk,
  parseMounts
} from "../../../board/bootsel.ts"
import type { DiscoverHost } from "../../../board/discover.ts"

// Trimmed from `ioreg -r -c IOUSBHostDevice -l -w0` on a Mac with a Pico 2 W in BOOTSEL and an
// ESP32-S3 running MicroPython.
const IOREG = [
  "+-o RP2350 Boot@00110000  <class IOUSBHostDevice, id 0x100013312, registered>",
  '  |   "idProduct" = 15',
  '  |   "USB Product Name" = "RP2350 Boot"',
  '  |   "idVendor" = 11914',
  '  |   "USB Serial Number" = "A6AFD22C8A7C3EF8"',
  "  +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x100013317, registered>",
  '  | |   "USB Serial Number" = "A6AFD22C8A7C3EF8"',
  "  |   +-o RPI RP2350 Media  <class IOMedia, id 0x10001332d, registered>",
  '  |     |   "BSD Name" = "disk4"',
  "  |     +-o IOMediaBSDClient  <class IOMediaBSDClient, id 0x10001332e, registered>",
  "+-o USB JTAG/serial debug unit@00140000  <class IOUSBHostDevice, id 0x2>",
  '  |   "idProduct" = 16385',
  '  |   "idVendor" = 12346',
  '  |   "USB Serial Number" = "441bf6f5521c0000"',
  "  +-o IOMedia  <class IOMedia, id 0x3>",
  '        "BSD Name" = "disk9"'
].join("\n")

const MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "/dev/disk4s1 on /Volumes/RP2350 (msdos, local, nodev, nosuid, noowners, noatime, fskit)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)"
].join("\n")

const INFO = "UF2 Bootloader v1.0\nModel: Raspberry Pi RP2350\nBoard-ID: RP2350\n"

function host(
  platform: NodeJS.Platform,
  outputs: Record<string, string>,
  mounts: string[]
): DiscoverHost {
  return {
    platform,
    run: async (command) => {
      const out = outputs[command]
      return out === undefined ? Promise.reject(new Error("not found")) : Promise.resolve(out)
    },
    readdir: async (path) =>
      Promise.resolve([
        ...new Set(
          mounts
            .filter((m) => m.startsWith(`${path}/`))
            .map((m) => m.slice(path.length + 1).split("/")[0] ?? "")
        )
      ]),
    readFile: async (path) =>
      mounts.some((m) => path === `${m}/INFO_UF2.TXT`)
        ? Promise.resolve(INFO)
        : Promise.reject(new Error("ENOENT")),
    realpath: async (path) => Promise.resolve(path)
  }
}

describe("BOOTSEL serial numbers", () => {
  it("reads each BOOTSEL device's serial number and disks from ioreg", () => {
    expect(parseBootselIoreg(IOREG)).toEqual([
      { serialNumber: "A6AFD22C8A7C3EF8", disks: ["disk4"] }
    ])
  })

  it("reads mount points' devices", () => {
    expect(parseMounts(MOUNT)).toEqual(
      new Map([
        ["/", "disk3s1s1"],
        ["/Volumes/RP2350", "disk4s1"]
      ])
    )
  })

  it("reads mount points' disk serial numbers from lsblk", () => {
    const lsblk = JSON.stringify({
      blockdevices: [
        {
          path: "/dev/sda",
          serial: "A6AFD22C8A7C3EF8",
          mountpoint: null,
          children: [{ path: "/dev/sda1", serial: null, mountpoint: "/media/me/RP2350" }]
        },
        { path: "/dev/nvme0n1", serial: null, mountpoint: "/" }
      ]
    })
    expect(parseLsblk(lsblk)).toEqual(new Map([["/media/me/RP2350", "A6AFD22C8A7C3EF8"]]))
    expect(parseLsblk("{}")).toEqual(new Map())
  })

  it("names a macOS BOOTSEL drive by its chip ID", async () => {
    const mac = host("darwin", { ioreg: IOREG, mount: MOUNT }, ["/Volumes/RP2350"])
    await expect(findBootselDrives(mac)).resolves.toEqual([
      { path: "/Volumes/RP2350", model: "Raspberry Pi RP2350", serialNumber: "A6AFD22C8A7C3EF8" }
    ])
  })

  it("names a Linux BOOTSEL drive by its chip ID", async () => {
    const lsblk = JSON.stringify({
      blockdevices: [
        {
          serial: "A6AFD22C8A7C3EF8",
          children: [{ serial: null, mountpoint: "/media/me/RP2350" }]
        }
      ]
    })
    const linux = host("linux", { lsblk }, ["/media/me/RP2350"])
    await expect(findBootselDrives(linux, "me")).resolves.toEqual([
      { path: "/media/me/RP2350", model: "Raspberry Pi RP2350", serialNumber: "A6AFD22C8A7C3EF8" }
    ])
  })

  it("still lists a drive whose serial number the OS won't give", async () => {
    const mac = host("darwin", {}, ["/Volumes/RP2350"])
    await expect(findBootselDrives(mac)).resolves.toEqual([
      { path: "/Volumes/RP2350", model: "Raspberry Pi RP2350" }
    ])
    const windows = host("win32", {}, [])
    windows.readFile = async (path) =>
      path === "E:\\INFO_UF2.TXT" ? Promise.resolve(INFO) : Promise.reject(new Error("ENOENT"))
    await expect(findBootselDrives(windows)).resolves.toEqual([
      { path: "E:\\", model: "Raspberry Pi RP2350" }
    ])
  })
})
