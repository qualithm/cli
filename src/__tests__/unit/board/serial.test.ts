import { constants } from "node:fs"

import { describe, expect, it } from "vitest"

import { openSerial } from "../../../board/native.ts"
import {
  defaultSerialConfig,
  type Kernel32,
  type Libc,
  openPosix,
  openWindows,
  type PosixFs,
  type SerialConfig,
  type SerialPort
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
  port: SerialPort
  calls: string[]
  incoming: (Uint8Array | Error | 0)[]
  written: string[]
  closes: () => number
}

type WindowsSeen = { name?: string; dcb?: Uint8Array; timeouts?: Uint8Array; closed: number }

type WindowsSetup = {
  port: SerialPort
  seen: WindowsSeen
  incoming: Uint8Array[]
  written: string[]
}

describe("openPosix", () => {
  function setup(
    fsOverrides: Partial<PosixFs> = {},
    libcOverrides: Partial<Libc> = {}
  ): PosixSetup {
    const mem = addresses()
    const calls: string[] = []
    const libc: Libc = {
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
    return { port, calls, incoming, written, closes: () => closes }
  }

  it("opens non-blocking and switches the port to raw mode", () => {
    const { calls } = setup()
    const flags = constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK
    expect(calls).toEqual([
      `open /dev/cu.test ${String(flags)}`,
      "tcgetattr 7",
      "cfmakeraw 170",
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
  const libc: Libc = { tcgetattr: () => 0, cfmakeraw: () => undefined, tcsetattr: () => 0 }

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
    const seen: WindowsSeen = { closed: 0 }
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
      getLastError: () => 0,
      ...overrides
    }
    const port = openWindows("COM5", kernel32, mem.ptr, quick)
    return { port, seen, incoming, written }
  }

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
