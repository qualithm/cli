import { constants } from "node:fs"

import { describe, expect, it } from "vitest"

import { openSerial } from "../../../board/native.ts"
import {
  type ControlSerialPort,
  defaultSerialConfig,
  type Kernel32,
  type Libc,
  openPosix,
  openWindows,
  type PosixFs,
  type SerialConfig
} from "../../../board/serial.ts"
import { CliError } from "../../../envelope.ts"

/** Hands out addresses for buffers and finds the buffer again, as FFI does. */
function addresses(): { ptr: (b: Uint8Array) => number; at: (p: number) => Uint8Array } {
  const buffers: Uint8Array[] = []
  return {
    ptr: (buffer) => buffers.push(buffer),
    at: (pointer) => {
      const buffer = buffers[pointer - 1]
      if (buffer === undefined) {
        throw new Error(`no buffer at ${String(pointer)}`)
      }
      return buffer
    }
  }
}

const quick: SerialConfig = {
  ...defaultSerialConfig,
  read_wait_ms: 20,
  poll_ms: 1
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

type PosixSetup = {
  port: ControlSerialPort
  /** The modem-line bits the fake port holds. */
  lines: { bits: number }
  calls: string[]
  incoming: (Uint8Array | Error | 0)[]
  written: string[]
  closes: () => number
}

type WindowsSeen = {
  name?: string
  dcb?: Uint8Array
  timeouts?: Uint8Array
  closed: number
  escapes: number[]
}

type WindowsSetup = {
  port: ControlSerialPort
  seen: WindowsSeen
  incoming: Uint8Array[]
  written: string[]
}

describe("openPosix", () => {
  function setup(
    fsOverrides: Partial<PosixFs> = {},
    libcOverrides: Partial<Libc> = {},
    platform: "darwin" | "linux" = "darwin"
  ): PosixSetup {
    const mem = addresses()
    const calls: string[] = []
    const lines = { bits: 0x2 | 0x4 | 0x100 }
    const libc: Libc = {
      platform,
      tcgetattr: (fd, p) => {
        calls.push(`tcgetattr ${String(fd)}`)
        mem.at(p)[0] = 0xaa
        return 0
      },
      cfmakeraw: (p) => {
        calls.push(`cfmakeraw ${String(mem.at(p)[0])}`)
      },
      tcsetattr: (fd, action) => {
        calls.push(`tcsetattr ${String(fd)} ${String(action)}`)
        return 0
      },
      cfsetspeed: (_p, speed) => {
        calls.push(`cfsetspeed ${String(speed)}`)
        return 0
      },
      ioctl: (fd, request, arg) => {
        const view = new DataView(mem.at(arg).buffer)
        calls.push(`ioctl ${String(fd)} 0x${request.toString(16)}`)
        if (request === 0x4004746a || request === 0x5415) {
          view.setInt32(0, lines.bits, true)
        } else {
          lines.bits = view.getInt32(0, true)
        }
        return 0
      },
      ...libcOverrides
    }
    const incoming: (Uint8Array | Error | 0)[] = []
    const written: string[] = []
    let closes = 0
    const fs: PosixFs = {
      open: (path, flags) => {
        calls.push(`open ${path} ${String(flags)}`)
        return 7
      },
      read: (_fd, buffer) => {
        const next = incoming.shift() ?? errno("EAGAIN")
        if (next instanceof Error) {
          throw next
        }
        if (next === 0) {
          return 0
        }
        buffer.set(next)
        return next.length
      },
      write: (_fd, buffer) => {
        // Take at most three bytes per call, as a full output buffer would.
        const taken = buffer.subarray(0, 3)
        written.push(Buffer.from(taken).toString())
        return taken.length
      },
      close: () => {
        closes++
      },
      ...fsOverrides
    }
    const port = openPosix("/dev/cu.test", libc, mem.ptr, fs, quick)
    return { port, lines, calls, incoming, written, closes: () => closes }
  }

  it("drives DTR and RTS, keeping the other lines", async () => {
    const { port, lines, calls } = setup()
    await port.setSignals({ dtr: false })
    expect(lines.bits).toBe(0x4 | 0x100)
    await port.setSignals({ dtr: true, rts: false })
    expect(lines.bits).toBe(0x2 | 0x100)
    await port.setSignals({})
    expect(lines.bits).toBe(0x2 | 0x100)
    expect(calls.filter((c) => c.startsWith("ioctl")).slice(0, 2)).toEqual([
      "ioctl 7 0x4004746a",
      "ioctl 7 0x8004746d"
    ])
  })

  it("uses linux's modem-line requests on linux", async () => {
    const { port, lines, calls } = setup({}, {}, "linux")
    await port.setSignals({ rts: false })
    expect(lines.bits).toBe(0x2 | 0x100)
    expect(calls.filter((c) => c.startsWith("ioctl"))).toEqual(["ioctl 7 0x5415", "ioctl 7 0x5418"])
  })

  it("throws when the board has gone as it sets the lines", async () => {
    const { port } = setup({}, { ioctl: () => -1 })
    await expect(port.setSignals({ dtr: true })).rejects.toThrow(
      "the board on /dev/cu.test disconnected"
    )
    const late = setup({}, { ioctl: (_fd, request) => (request === 0x8004746d ? -1 : 0) })
    await expect(late.port.setSignals({ dtr: true })).rejects.toThrow("disconnected")
  })

  it("changes speed with the rate on macOS and the speed code on linux", async () => {
    const mac = setup()
    await mac.port.setBaudRate(460800)
    expect(mac.calls.slice(-2)).toEqual(["cfsetspeed 460800", "tcsetattr 7 0"])
    const linux = setup({}, {}, "linux")
    await linux.port.setBaudRate(921600)
    expect(linux.calls.slice(-2)).toEqual([`cfsetspeed ${String(0o10007)}`, "tcsetattr 7 0"])
  })

  it("refuses a speed the system can't set", async () => {
    const linux = setup({}, {}, "linux")
    await expect(linux.port.setBaudRate(123)).rejects.toThrow("set /dev/cu.test to 123 baud")
    let speeds = 0
    const refused = setup({}, { cfsetspeed: () => (speeds++ === 0 ? 0 : -1) })
    await expect(refused.port.setBaudRate(230400)).rejects.toThrow("230400 baud")
    expect(() => setup({}, { cfsetspeed: () => -1 })).toThrow("configure serial port /dev/cu.test")
  })

  it("opens non-blocking and switches the port to raw mode", () => {
    const { calls } = setup()
    const flags = constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK
    expect(calls).toEqual([
      `open /dev/cu.test ${String(flags)}`,
      "tcgetattr 7",
      "cfmakeraw 170",
      "cfsetspeed 115200",
      "tcsetattr 7 0"
    ])
  })

  it("returns bytes as they arrive and nothing once the wait runs out", async () => {
    const { port, incoming } = setup()
    incoming.push(errno("EAGAIN"), new Uint8Array([104, 105]))
    expect(Buffer.from(await port.read()).toString()).toBe("hi")
    expect(await port.read(5)).toEqual(new Uint8Array(0))
  })

  it("writes everything across partial writes", async () => {
    const { port, written } = setup({})
    await port.write(Buffer.from("hello!!"))
    expect(written).toEqual(["hel", "lo!", "!"])
  })

  it("retries a write the port isn't ready for", async () => {
    let first = true
    const { port } = setup({
      write: (_fd, buffer) => {
        if (first) {
          first = false
          throw errno("EAGAIN")
        }
        return buffer.length
      }
    })
    await expect(port.write(Buffer.from("x"))).resolves.toBeUndefined()
  })

  it.each([
    ["a hang-up", 0 as const],
    ["an I/O error", errno("EIO")]
  ])("reports %s as the board going away", async (_name, next) => {
    const { port, incoming } = setup()
    incoming.push(next)
    await expect(port.read()).rejects.toEqual(
      new CliError("the board on /dev/cu.test disconnected", "unavailable")
    )
  })

  it("reports a failed write as the board going away", async () => {
    const { port } = setup({
      write: () => {
        throw errno("ENXIO")
      }
    })
    await expect(port.write(Buffer.from("x"))).rejects.toMatchObject({ code: "unavailable" })
  })

  it("closes once", async () => {
    const { port, closes } = setup()
    await port.close()
    await port.close()
    expect(closes()).toBe(1)
  })

  it.each([
    ["ENOENT", "no serial port at /dev/cu.test", "not_found"],
    ["EBUSY", "serial port /dev/cu.test is in use", "unavailable"],
    [
      "EACCES",
      "permission denied opening /dev/cu.test: add your user to the group that owns it, then sign in again",
      "error"
    ],
    ["EINVAL", "open /dev/cu.test: EINVAL", "error"]
  ])("explains an open that fails with %s", (code, message, errorCode) => {
    expect(() =>
      setup({
        open: () => {
          throw errno(code)
        }
      })
    ).toThrow(new CliError(message, errorCode as CliError["code"]))
  })

  it("explains an open that throws something odd", () => {
    expect(() =>
      setup({
        open: () => {
          throw "boom" as unknown as Error
        }
      })
    ).toThrow("open /dev/cu.test: boom")
  })

  it("refuses a file that isn't a serial port, and closes it", () => {
    let closed = 0
    expect(() =>
      setup(
        {
          close: () => {
            closed++
          }
        },
        { tcgetattr: () => -1 }
      )
    ).toThrow("/dev/cu.test is not a serial port")
    expect(closed).toBe(1)
  })

  it("fails when the port can't be configured, and closes it", () => {
    let closed = 0
    expect(() =>
      setup(
        {
          close: () => {
            closed++
          }
        },
        { tcsetattr: () => -1 }
      )
    ).toThrow("configure serial port /dev/cu.test")
    expect(closed).toBe(1)
  })
})

describe("openPosix with the real file calls", () => {
  const libc: Libc = {
    platform: "darwin",
    tcgetattr: () => 0,
    cfmakeraw: () => undefined,
    tcsetattr: () => 0,
    cfsetspeed: () => 0,
    ioctl: () => 0
  }

  it.skipIf(process.platform === "win32")(
    "opens, writes, reads and closes a real file",
    async () => {
      const port = openPosix("/dev/null", libc, () => 1, undefined, quick)
      await port.write(Buffer.from("x"))
      // /dev/null reads as end of file, which a serial port does only once the board has gone.
      await expect(port.read()).rejects.toThrow("the board on /dev/null disconnected")
      await port.close()
    }
  )
})

describe("openWindows", () => {
  function setup(overrides: Partial<Kernel32> = {}): WindowsSetup {
    const mem = addresses()
    const incoming: Uint8Array[] = []
    const written: string[] = []
    const seen: WindowsSeen = { closed: 0, escapes: [] }
    const done = (p: number, n: number): void => {
      new DataView(mem.at(p).buffer).setUint32(0, n, true)
    }
    const kernel32: Kernel32 = {
      createFile: (name, access, disposition) => {
        seen.name = Buffer.from(mem.at(name)).toString("utf16le")
        expect(access).toBe(0xc0000000)
        expect(disposition).toBe(3)
        return 42
      },
      getCommState: (_h, dcb) => {
        mem.at(dcb)[8] = 0xff
        return 1
      },
      setCommState: (_h, dcb) => {
        seen.dcb = mem.at(dcb).slice()
        return 1
      },
      setCommTimeouts: (_h, t) => {
        seen.timeouts = mem.at(t).slice()
        return 1
      },
      readFile: (_h, buffer, _size, n) => {
        const next = incoming.shift() ?? new Uint8Array(0)
        mem.at(buffer).set(next)
        done(n, next.length)
        return 1
      },
      writeFile: (_h, buffer, size, n) => {
        const taken = Math.min(size, 3)
        written.push(Buffer.from(mem.at(buffer).subarray(0, taken)).toString())
        done(n, taken)
        return 1
      },
      closeHandle: () => {
        seen.closed++
        return 1
      },
      escapeCommFunction: (_h, code) => {
        seen.escapes.push(code)
        return 1
      },
      getLastError: () => 0,
      ...overrides
    }
    const port = openWindows("COM5", kernel32, mem.ptr, quick)
    return { port, seen, incoming, written }
  }

  it("drives DTR and RTS through EscapeCommFunction", async () => {
    const { port, seen } = setup()
    await port.setSignals({ dtr: false, rts: true })
    await port.setSignals({ dtr: true, rts: false })
    await port.setSignals({})
    expect(seen.escapes).toEqual([6, 3, 5, 4])
  })

  it("throws when the board has gone as it sets the lines", async () => {
    const { port } = setup({ escapeCommFunction: () => 0 })
    await expect(port.setSignals({ rts: true })).rejects.toThrow("the board on COM5 disconnected")
  })

  it("changes speed in the port's settings", async () => {
    const { port, seen } = setup()
    await port.setBaudRate(921600)
    expect(new DataView((seen.dcb ?? new Uint8Array(28)).buffer).getUint32(4, true)).toBe(921600)
    let calls = 0
    const failing = setup({
      setCommState: () => {
        calls++
        return calls === 1 ? 1 : 0
      }
    })
    await expect(failing.port.setBaudRate(460800)).rejects.toThrow("set COM5 to 460800 baud")
  })

  it("opens the port by its device name at 115200 8N1 with DTR on", () => {
    const { seen } = setup()
    expect(seen.name).toBe("\\\\.\\COM5\0")
    const dcb = new DataView((seen.dcb ?? new Uint8Array(28)).buffer)
    expect(dcb.getUint32(0, true)).toBe(28)
    expect(dcb.getUint32(4, true)).toBe(115200)
    expect(dcb.getUint32(8, true)).toBe(0x1011)
    expect([...(seen.dcb ?? new Uint8Array(28)).subarray(18, 21)]).toEqual([8, 0, 0])
    const timeouts = new DataView((seen.timeouts ?? new Uint8Array(20)).buffer)
    expect(timeouts.getUint32(0, true)).toBe(0xffffffff)
    expect(timeouts.getUint32(4, true)).toBe(0)
    expect(timeouts.getUint32(8, true)).toBe(0)
    expect(timeouts.getUint32(16, true)).toBe(2000)
  })

  it("polls until bytes arrive, and returns nothing once the wait runs out", async () => {
    const { port, incoming } = setup()
    expect(await port.read(5)).toEqual(new Uint8Array(0))
    incoming.push(new Uint8Array(0), new Uint8Array([79, 75]))
    expect(Buffer.from(await port.read()).toString()).toBe("OK")
  })

  it("writes everything across partial writes", async () => {
    const { port, written } = setup()
    await port.write(Buffer.from("hello!!"))
    expect(written).toEqual(["hel", "lo!", "!"])
  })

  it("reports failed reads and writes as the board going away", async () => {
    const { port } = setup({ readFile: () => 0, writeFile: () => 0 })
    await expect(port.read()).rejects.toMatchObject({ code: "unavailable" })
    await expect(port.write(Buffer.from("x"))).rejects.toThrow("the board on COM5 disconnected")
  })

  it("closes once", async () => {
    const { port, seen } = setup()
    await port.close()
    await port.close()
    expect(seen.closed).toBe(1)
  })

  it.each([
    [2, "no serial port at COM5", "not_found"],
    [5, "serial port COM5 is in use", "unavailable"],
    [31, "open COM5: windows error 31", "error"]
  ])("explains Windows error %i on open", (code, message, errorCode) => {
    expect(() => setup({ createFile: () => -1, getLastError: () => code })).toThrow(
      new CliError(message, errorCode as CliError["code"])
    )
  })

  it("refuses a handle that isn't a serial port", () => {
    expect(() => setup({ getCommState: () => 0 })).toThrow("COM5 is not a serial port")
  })

  it.each([
    ["state", { setCommState: () => 0 }],
    ["timeouts", { setCommTimeouts: () => 0 }]
  ] as const)("fails when the %s can't be set", (_what, override) => {
    expect(() => setup(override)).toThrow("configure serial port COM5")
  })
})

describe("openSerial", () => {
  it("needs Bun, which the qualithm binary has built in", async () => {
    await expect(openSerial("/dev/cu.test")).rejects.toEqual(
      new CliError("talking to a board needs the qualithm binary, not node", "error")
    )
  })

  it("polls every few milliseconds by default", async () => {
    const started = Date.now()
    await defaultSerialConfig.sleep(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(0)
    expect(defaultSerialConfig).toMatchObject({ read_wait_ms: 100, poll_ms: 10 })
  })
})
