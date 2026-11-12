import { CliError } from "../envelope.ts"
import {
  type ControlSerialPort,
  defaultSerialConfig,
  type Kernel32,
  type Libc,
  openPosix,
  openWindows,
  type Ptr,
  type SerialConfig
} from "./serial.ts"

const LIBC_PATHS: Readonly<Record<string, string>> = {
  darwin: "libc.dylib",
  linux: "libc.so.6"
}

function unsupported(platform: string): CliError {
  return new CliError(`talking to a board isn't supported on ${platform}`, "error")
}

/**
 * Opens a USB serial port through the OS's own calls. Needs Bun: the compiled `qualithm` binary
 * has it built in.
 *
 * @param path - the port: a device path, or `COMn` on Windows
 * @param platform - the OS; defaults to this one
 * @param config - polling settings
 * @returns the open port, which also drives its modem lines and speed
 * @throws {CliError} when not running under Bun, on an unsupported OS, or when the port can't be
 *   opened
 */
export async function openSerial(
  path: string,
  platform: NodeJS.Platform = process.platform,
  config: SerialConfig = defaultSerialConfig
): Promise<ControlSerialPort> {
  if (typeof Bun === "undefined") {
    throw new CliError("talking to a board needs the qualithm binary, not node", "error")
  }
  const libc = LIBC_PATHS[platform]
  if (platform !== "win32" && libc === undefined) {
    throw unsupported(platform)
  }
  const ffi = await import("bun:ffi")
  const ptr = ffi.ptr as unknown as Ptr
  if (platform === "win32") {
    // A number when it fits, which every handle does; INVALID_HANDLE_VALUE reads as -1.
    const handle = ffi.FFIType.i64_fast
    const { symbols } = ffi.dlopen("kernel32.dll", {
      CreateFileW: {
        args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"],
        returns: handle
      },
      GetCommState: { args: [handle, "ptr"], returns: "i32" },
      SetCommState: { args: [handle, "ptr"], returns: "i32" },
      SetCommTimeouts: { args: [handle, "ptr"], returns: "i32" },
      ReadFile: { args: [handle, "ptr", "u32", "ptr", "ptr"], returns: "i32" },
      WriteFile: { args: [handle, "ptr", "u32", "ptr", "ptr"], returns: "i32" },
      CloseHandle: { args: [handle], returns: "i32" },
      EscapeCommFunction: { args: [handle, "u32"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" }
    })
    const k = symbols as unknown as Record<string, (...args: unknown[]) => number>
    const call = (name: string, ...args: unknown[]): number =>
      (k[name] as (...a: unknown[]) => number)(...args)
    const kernel32: Kernel32 = {
      createFile: (name, access, disposition) =>
        call("CreateFileW", name, access, 0, null, disposition, 0, null),
      getCommState: (handle, dcb) => call("GetCommState", handle, dcb),
      setCommState: (handle, dcb) => call("SetCommState", handle, dcb),
      setCommTimeouts: (handle, timeouts) => call("SetCommTimeouts", handle, timeouts),
      readFile: (handle, buffer, size, done) => call("ReadFile", handle, buffer, size, done, null),
      writeFile: (handle, buffer, size, done) =>
        call("WriteFile", handle, buffer, size, done, null),
      closeHandle: (handle) => call("CloseHandle", handle),
      escapeCommFunction: (handle, code) => call("EscapeCommFunction", handle, code),
      getLastError: () => call("GetLastError")
    }
    return openWindows(path, kernel32, ptr, config)
  }
  if (libc === undefined) {
    throw unsupported(platform)
  }
  // FFI can't pass variadic arguments the way Apple's arm64 ABI wants, so on macOS it calls the
  // syscall stub `ioctl` wraps, which takes its argument in a register.
  const ioctl = platform === "darwin" ? "__ioctl" : "ioctl"
  const { symbols } = ffi.dlopen(libc, {
    tcgetattr: { args: ["i32", "ptr"], returns: "i32" },
    tcsetattr: { args: ["i32", "i32", "ptr"], returns: "i32" },
    cfmakeraw: { args: ["ptr"], returns: "void" },
    cfsetspeed: { args: ["ptr", "u64"], returns: "i32" },
    [ioctl]: { args: ["i32", "u64", "ptr"], returns: "i32" }
  })
  const calls = symbols as unknown as Record<string, (...args: unknown[]) => number>
  const posix: Libc = {
    platform: platform === "linux" ? "linux" : "darwin",
    tcgetattr: (fd, termios) => (calls.tcgetattr as (...a: unknown[]) => number)(fd, termios),
    tcsetattr: (fd, action, termios) =>
      (calls.tcsetattr as (...a: unknown[]) => number)(fd, action, termios),
    cfmakeraw: (termios) => {
      ;(calls.cfmakeraw as (...a: unknown[]) => number)(termios)
    },
    cfsetspeed: (termios, speed) =>
      (calls.cfsetspeed as (...a: unknown[]) => number)(termios, speed),
    ioctl: (fd, request, arg) => (calls[ioctl] as (...a: unknown[]) => number)(fd, request, arg)
  }
  return openPosix(path, posix, ptr, undefined, config)
}
