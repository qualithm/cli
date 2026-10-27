import { closeSync, constants, openSync, readSync, writeSync } from "node:fs"

import { CliError } from "../envelope.ts"

/** An open USB serial port. Reads never block the event loop. */
export type SerialPort = {
  /** The OS path the port was opened at. */
  readonly path: string
  /** Writes every byte of `data`. */
  write: (data: Uint8Array) => Promise<void>
  /**
   * Waits up to `waitMs` for bytes and returns what arrived, possibly nothing.
   *
   * @throws {PortClosedError} when the board went away
   */
  read: (waitMs?: number) => Promise<Uint8Array>
  /** Closes the port; safe to call twice. */
  close: () => Promise<void>
}

/** How a port polls for bytes. */
export type SerialConfig = {
  /** Default wait for one `read`. */
  read_wait_ms: number
  /** Pause between polls while no bytes are waiting. */
  poll_ms: number
  sleep: (ms: number) => Promise<void>
}

export const defaultSerialConfig: SerialConfig = {
  read_wait_ms: 100,
  poll_ms: 10,
  sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/** Turns a buffer into the address an FFI call takes. */
export type Ptr = (buffer: Uint8Array) => number

/** The libc calls the POSIX port makes. */
export type Libc = {
  tcgetattr: (fd: number, termios: number) => number
  tcsetattr: (fd: number, action: number, termios: number) => number
  cfmakeraw: (termios: number) => void
}

/** The file calls the POSIX port makes; Node's `fs` by default. */
export type PosixFs = {
  open: (path: string, flags: number) => number
  read: (fd: number, buffer: Uint8Array) => number
  write: (fd: number, buffer: Uint8Array) => number
  close: (fd: number) => void
}

const nodeFs: PosixFs = {
  open: (path, flags) => openSync(path, flags),
  read: (fd, buffer) => readSync(fd, buffer),
  write: (fd, buffer) => writeSync(fd, buffer),
  close: (fd) => {
    closeSync(fd)
  }
}

const TCSANOW = 0
// Larger than `struct termios` on every supported libc.
const TERMIOS_BYTES = 256
const READ_CHUNK_BYTES = 4096

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function openFailure(path: string, error: unknown): CliError {
  const code = errnoCode(error)
  if (code === "ENOENT") {
    return new CliError(`no serial port at ${path}`, "not_found")
  }
  if (code === "EBUSY") {
    return new CliError(`serial port ${path} is in use`, "unavailable")
  }
  if (code === "EACCES") {
    return new CliError(
      `permission denied opening ${path}: add your user to the group that owns it, then sign in again`,
      "error"
    )
  }
  const reason = error instanceof Error ? error.message : String(error)
  return new CliError(`open ${path}: ${reason}`, "error")
}

/** The board behind an open port went away, by unplugging or restarting. */
export class PortClosedError extends CliError {
  /**
   * @param path - the port that closed
   */
  constructor(path: string) {
    super(`the board on ${path} disconnected`, "unavailable")
  }
}

function gone(path: string): PortClosedError {
  return new PortClosedError(path)
}

/**
 * Opens a serial port on macOS or Linux: non-blocking, in raw mode.
 *
 * @param path - the device path, e.g. `/dev/cu.usbmodem1101`
 * @param libc - the termios calls
 * @param ptr - turns a buffer into an FFI address
 * @param fs - the file calls
 * @param config - polling settings
 * @returns the open port
 * @throws {CliError} when the port can't be opened or configured
 */
export function openPosix(
  path: string,
  libc: Libc,
  ptr: Ptr,
  fs: PosixFs = nodeFs,
  config: SerialConfig = defaultSerialConfig
): SerialPort {
  let fd: number
  try {
    fd = fs.open(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK)
  } catch (error) {
    throw openFailure(path, error)
  }
  const termios = new Uint8Array(TERMIOS_BYTES)
  if (libc.tcgetattr(fd, ptr(termios)) !== 0) {
    fs.close(fd)
    throw new CliError(`${path} is not a serial port`, "error")
  }
  libc.cfmakeraw(ptr(termios))
  if (libc.tcsetattr(fd, TCSANOW, ptr(termios)) !== 0) {
    fs.close(fd)
    throw new CliError(`configure serial port ${path}`, "error")
  }
  let open = true
  const chunk = new Uint8Array(READ_CHUNK_BYTES)

  return {
    path,
    write: async (data) => {
      let sent = 0
      while (sent < data.length) {
        try {
          sent += fs.write(fd, data.subarray(sent))
        } catch (error) {
          if (errnoCode(error) !== "EAGAIN") {
            throw gone(path)
          }
          await config.sleep(config.poll_ms)
        }
      }
    },
    read: async (waitMs = config.read_wait_ms) => {
      const deadline = Date.now() + waitMs
      for (;;) {
        let count: number
        try {
          count = fs.read(fd, chunk)
        } catch (error) {
          if (errnoCode(error) !== "EAGAIN") {
            throw gone(path)
          }
          if (Date.now() >= deadline) {
            return new Uint8Array(0)
          }
          await config.sleep(config.poll_ms)
          continue
        }
        // A tty reads zero bytes only once the device has hung up.
        if (count === 0) {
          throw gone(path)
        }
        return chunk.slice(0, count)
      }
    },
    close: async () => {
      if (open) {
        open = false
        fs.close(fd)
      }
      return Promise.resolve()
    }
  }
}

/** The kernel32 calls the Windows port makes. Handles are numbers, `-1` when invalid. */
export type Kernel32 = {
  /** `CreateFileW` with no sharing, security, flags or template. */
  createFile: (name: number, access: number, disposition: number) => number
  getCommState: (handle: number, dcb: number) => number
  setCommState: (handle: number, dcb: number) => number
  setCommTimeouts: (handle: number, timeouts: number) => number
  /** `ReadFile` without overlapped I/O. */
  readFile: (handle: number, buffer: number, size: number, done: number) => number
  /** `WriteFile` without overlapped I/O. */
  writeFile: (handle: number, buffer: number, size: number, done: number) => number
  closeHandle: (handle: number) => number
  getLastError: () => number
}

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
// `|` yields a signed number; the Win32 call takes the unsigned one.
const READ_WRITE = (GENERIC_READ | GENERIC_WRITE) >>> 0
const OPEN_EXISTING = 3
const INVALID_HANDLE = -1
const ERROR_FILE_NOT_FOUND = 2
const ERROR_ACCESS_DENIED = 5
const DCB_BYTES = 28
const BAUD_RATE = 115200
// DCB flag bits: fBinary on, DTR and RTS held on, every flow control and parity check off.
const DCB_FLAGS = 0x1 | (0x1 << 4) | (0x1 << 12)
const MAXDWORD = 0xffffffff
const WRITE_TIMEOUT_MS = 2000

/**
 * Opens a COM port on Windows: 115200 8N1, DTR on, reads that return at once.
 *
 * @param path - the port, e.g. `COM5`
 * @param kernel32 - the Win32 calls
 * @param ptr - turns a buffer into an FFI address
 * @param config - polling settings
 * @returns the open port
 * @throws {CliError} when the port can't be opened or configured
 */
export function openWindows(
  path: string,
  kernel32: Kernel32,
  ptr: Ptr,
  config: SerialConfig = defaultSerialConfig
): SerialPort {
  const name = new Uint8Array(Buffer.from(`\\\\.\\${path}\0`, "utf16le"))
  const handle = kernel32.createFile(ptr(name), READ_WRITE, OPEN_EXISTING)
  if (handle === INVALID_HANDLE) {
    const code = kernel32.getLastError()
    if (code === ERROR_FILE_NOT_FOUND) {
      throw new CliError(`no serial port at ${path}`, "not_found")
    }
    if (code === ERROR_ACCESS_DENIED) {
      throw new CliError(`serial port ${path} is in use`, "unavailable")
    }
    throw new CliError(`open ${path}: windows error ${String(code)}`, "error")
  }
  const dcb = new Uint8Array(DCB_BYTES)
  const view = new DataView(dcb.buffer)
  view.setUint32(0, DCB_BYTES, true)
  if (kernel32.getCommState(handle, ptr(dcb)) === 0) {
    kernel32.closeHandle(handle)
    throw new CliError(`${path} is not a serial port`, "error")
  }
  view.setUint32(4, BAUD_RATE, true)
  view.setUint32(8, DCB_FLAGS, true)
  dcb[18] = 8 // ByteSize
  dcb[19] = 0 // no parity
  dcb[20] = 0 // one stop bit
  const timeouts = new Uint8Array(20)
  const times = new DataView(timeouts.buffer)
  // MAXDWORD with zero totals makes ReadFile return whatever is waiting, at once.
  times.setUint32(0, MAXDWORD, true)
  times.setUint32(16, WRITE_TIMEOUT_MS, true)
  if (
    kernel32.setCommState(handle, ptr(dcb)) === 0 ||
    kernel32.setCommTimeouts(handle, ptr(timeouts)) === 0
  ) {
    kernel32.closeHandle(handle)
    throw new CliError(`configure serial port ${path}`, "error")
  }
  let open = true
  const chunk = new Uint8Array(READ_CHUNK_BYTES)
  const done = new Uint32Array(1)
  const doneBytes = new Uint8Array(done.buffer)

  return {
    path,
    write: async (data) => {
      let sent = 0
      while (sent < data.length) {
        const rest = data.slice(sent)
        if (kernel32.writeFile(handle, ptr(rest), rest.length, ptr(doneBytes)) === 0) {
          throw gone(path)
        }
        sent += done[0] ?? 0
        if (sent < data.length) {
          await config.sleep(config.poll_ms)
        }
      }
    },
    read: async (waitMs = config.read_wait_ms) => {
      const deadline = Date.now() + waitMs
      for (;;) {
        if (kernel32.readFile(handle, ptr(chunk), chunk.length, ptr(doneBytes)) === 0) {
          throw gone(path)
        }
        const count = done[0] ?? 0
        if (count > 0) {
          return chunk.slice(0, count)
        }
        if (Date.now() >= deadline) {
          return new Uint8Array(0)
        }
        await config.sleep(config.poll_ms)
      }
    },
    close: async () => {
      if (open) {
        open = false
        kernel32.closeHandle(handle)
      }
      return Promise.resolve()
    }
  }
}
