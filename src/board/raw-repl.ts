import { CliError } from "../envelope.ts"
import { PortClosedError, type SerialPort } from "./serial.ts"

/** Timings for MicroPython's raw REPL. */
export type RawReplConfig = {
  /** How long to wait for the raw REPL banner. */
  enter_timeout_ms: number
  /** How long to wait for the banner before interrupting again. */
  interrupt_retry_ms: number
  /** How long code may run before `exec` gives up. */
  exec_timeout_ms: number
  /** Bytes written before pausing, so the board's input buffer never overflows. */
  chunk_bytes: number
  /** The pause between chunks. */
  chunk_pause_ms: number
  sleep: (ms: number) => Promise<void>
}

export const defaultRawReplConfig: RawReplConfig = {
  enter_timeout_ms: 3000,
  interrupt_retry_ms: 500,
  exec_timeout_ms: 10000,
  chunk_bytes: 256,
  chunk_pause_ms: 10,
  sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/** What a run of code printed. */
export type ExecOutput = { stdout: string; stderr: string }

const CTRL_A = "\x01"
const CTRL_B = "\x02"
const CTRL_C = "\x03"
const CTRL_D = "\x04"
const BANNER = "raw REPL; CTRL-B to exit\r\n>"
const SOFT_REBOOT = "soft reboot\r\n"

/**
 * Turns off the board's LED. A soft reset stops the timer a status light plays from but leaves
 * the pin as it was, which would read as a state. Boards without an `LED` pin skip it.
 */
export const LED_OFF = `try:
    import machine
    machine.Pin("LED", machine.Pin.OUT).value(0)
except (ImportError, ValueError):
    pass`

/**
 * MicroPython's raw REPL over a serial port: code in, stdout and stderr out, with no echo. The
 * protocol `mpremote` uses.
 */
export class RawRepl {
  readonly #port: SerialPort
  readonly #config: RawReplConfig
  #pending = Buffer.alloc(0)

  /**
   * @param port - the board's open serial port
   * @param config - timings
   */
  constructor(port: SerialPort, config: RawReplConfig = defaultRawReplConfig) {
    this.#port = port
    this.#config = config
  }

  /**
   * Stops whatever the board is running and enters the raw REPL. A soft reset there stops the
   * program's timers without running `main.py`, then the LED is turned off, so no light keeps
   * showing a state nothing is running.
   *
   * @throws {CliError} with code `unavailable` when the board doesn't answer
   */
  async enter(): Promise<void> {
    // A board can reset as its port opens, as an ESP32 behind a USB serial bridge does, and lose
    // the interrupt while it boots; ask again until it answers.
    const deadline = Date.now() + this.#config.enter_timeout_ms
    for (;;) {
      await this.#write(`\r${CTRL_C}${CTRL_C}${CTRL_A}`)
      const wait = Math.min(this.#config.interrupt_retry_ms, deadline - Date.now())
      try {
        await this.#readUntil(BANNER, Math.max(wait, 0), "enter the raw REPL")
        break
      } catch (error) {
        if (!(error instanceof CliError) || Date.now() >= deadline) {
          throw error
        }
      }
    }
    await this.#write(CTRL_D)
    await this.#readUntil(SOFT_REBOOT, this.#config.enter_timeout_ms, "soft-reset the board")
    await this.#readUntil(BANNER, this.#config.enter_timeout_ms, "enter the raw REPL")
    await this.exec(LED_OFF)
  }

  /**
   * Runs code and waits for it to finish.
   *
   * @param code - Python source
   * @returns what the code printed, and any traceback
   * @throws {CliError} when the board refuses the code or doesn't finish in time
   */
  async exec(code: string): Promise<ExecOutput> {
    await this.#send(code)
    const timeout = this.#config.exec_timeout_ms
    const stdout = await this.#readUntil(CTRL_D, timeout, "run code")
    const stderr = await this.#readUntil(`${CTRL_D}>`, timeout, "run code")
    return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") }
  }

  /**
   * Starts code the board won't come back from, such as a reset. Returns once the board accepts
   * it, or drops off USB first because it already ran.
   *
   * @param code - Python source
   * @throws {CliError} when the board refuses the code or doesn't answer
   */
  async start(code: string): Promise<void> {
    try {
      await this.#send(code)
    } catch (error) {
      if (!(error instanceof PortClosedError)) {
        throw error
      }
    }
  }

  /** Leaves the raw REPL for the normal one. */
  async exit(): Promise<void> {
    await this.#write(CTRL_B)
  }

  async #send(code: string): Promise<void> {
    const bytes = Buffer.from(code, "utf8")
    for (let at = 0; at < bytes.length; at += this.#config.chunk_bytes) {
      await this.#port.write(bytes.subarray(at, at + this.#config.chunk_bytes))
      await this.#config.sleep(this.#config.chunk_pause_ms)
    }
    await this.#write(CTRL_D)
    const reply = await this.#readExactly(2, this.#config.enter_timeout_ms, "send code")
    if (reply.toString("latin1") !== "OK") {
      throw new CliError(
        "the board isn't ready to take code: plug it back in and try again",
        "error"
      )
    }
  }

  async #write(text: string): Promise<void> {
    await this.#port.write(Buffer.from(text, "latin1"))
  }

  async #fill(deadline: number, what: string): Promise<void> {
    if (Date.now() >= deadline) {
      throw new CliError(`the board didn't answer in time: ${what}`, "unavailable")
    }
    const bytes = await this.#port.read()
    this.#pending = Buffer.concat([this.#pending, bytes])
  }

  async #readUntil(marker: string, timeoutMs: number, what: string): Promise<Buffer> {
    const needle = Buffer.from(marker, "latin1")
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const at = this.#pending.indexOf(needle)
      if (at >= 0) {
        const before = this.#pending.subarray(0, at)
        this.#pending = this.#pending.subarray(at + needle.length)
        return before
      }
      await this.#fill(deadline, what)
    }
  }

  async #readExactly(count: number, timeoutMs: number, what: string): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs
    while (this.#pending.length < count) {
      await this.#fill(deadline, what)
    }
    const bytes = this.#pending.subarray(0, count)
    this.#pending = this.#pending.subarray(count)
    return bytes
  }
}
