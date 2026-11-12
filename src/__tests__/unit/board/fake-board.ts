import { LED_OFF } from "../../../board/raw-repl.ts"
import {
  type ControlSerialPort,
  type ModemSignals,
  PortClosedError
} from "../../../board/serial.ts"

/** What the fake board does with a piece of code: print, raise, or never answer. */
export type Reply = { stdout?: string; stderr?: string } | "silent"

/**
 * A serial port with a MicroPython raw REPL behind it. Code in `replies` gets that reply; any
 * other code prints nothing.
 */
export class FakeBoard implements ControlSerialPort {
  readonly path = "/dev/fake"
  readonly ran: string[] = []
  readonly written: string[] = []
  /** Each modem-line change and speed the port was asked for, in order. */
  readonly controls: (ModemSignals | number)[] = []
  closed = false
  /** How many soft resets the board took in the raw REPL. */
  softResets = 0
  /** How many times the board was told to turn its LED off; kept out of `ran`. */
  ledOffs = 0
  /** When false, the board ignores everything, as a hung board would. */
  answers = true
  /** When true, the board drops off USB as soon as it takes code, before replying. */
  vanishes = false
  #gone = false
  /** When set, replaces the `OK` the board sends on accepting code. */
  accept = "OK"
  #raw = false
  #code = ""
  #out = ""

  readonly #replies: Readonly<Record<string, Reply>>

  constructor(replies: Readonly<Record<string, Reply>> = {}) {
    this.#replies = replies
  }

  async setSignals(signals: ModemSignals): Promise<void> {
    this.controls.push(signals)
    return Promise.resolve()
  }

  async setBaudRate(baud: number): Promise<void> {
    this.controls.push(baud)
    return Promise.resolve()
  }

  async write(data: Uint8Array): Promise<void> {
    const text = Buffer.from(data).toString("latin1")
    this.written.push(text)
    if (!this.answers) {
      return
    }
    for (const char of text) {
      this.#key(char)
    }
    return Promise.resolve()
  }

  async read(): Promise<Uint8Array> {
    if (this.#gone) {
      throw new PortClosedError(this.path)
    }
    if (this.#out === "") {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return new Uint8Array(0)
    }
    // Hand back a few bytes at a time, so markers arrive split across reads.
    const out = this.#out.slice(0, 5)
    this.#out = this.#out.slice(5)
    return new Uint8Array(Buffer.from(out, "latin1"))
  }

  async close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  #key(char: string): void {
    switch (char) {
      case "\x01":
        this.#raw = true
        this.#code = ""
        this.#out += "raw REPL; CTRL-B to exit\r\n>"
        return
      case "\x02":
        this.#raw = false
        this.#out += "\r\nMicroPython\r\n>>> "
        return
      case "\x03":
        this.#code = ""
        this.#out += this.#raw ? "" : "\r\n>>> "
        return
      case "\x04": {
        if (!this.#raw) {
          return
        }
        const code = this.#code
        this.#code = ""
        if (code === "") {
          // An empty Ctrl-D in the raw REPL soft-resets the board, staying in the raw REPL.
          this.softResets++
          this.#out += `OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>`
          return
        }
        if (code === LED_OFF) {
          this.ledOffs++
          this.#out += "OK\x04\x04>"
          return
        }
        this.ran.push(code)
        if (this.vanishes) {
          this.#gone = true
          this.#out = ""
          return
        }
        this.#out += this.accept
        const reply = this.#replies[code] ?? {}
        if (reply !== "silent") {
          this.#out += `${reply.stdout ?? ""}\x04${reply.stderr ?? ""}\x04>`
        }
        return
      }
      default:
        if (this.#raw) {
          this.#code += char
        }
    }
  }
}
