import type { ControlSerialPort } from "./serial.ts"

/** The USB identity a Web Serial port reports. */
export type WebSerialInfo = {
  usbVendorId?: number
  usbProductId?: number
}

/** The options of Web Serial's `open` the shim honours. */
export type WebSerialOpenOptions = { baudRate?: number }

/** The lines of Web Serial's `setSignals`; `break` isn't driven. */
export type WebSerialSignals = {
  dataTerminalReady?: boolean
  requestToSend?: boolean
  break?: boolean
}

/**
 * The part of the Web Serial API's `SerialPort` that esptool-js drives, over a port this process
 * opened itself. Closing it drops its streams and leaves the port open: whoever opened the port
 * closes it.
 */
export class WebSerialPort {
  readonly #port: ControlSerialPort
  readonly #info: WebSerialInfo
  readonly #readWaitMs: number
  #open = false
  #readable: ReadableStream<Uint8Array> | null = null
  #writable: WritableStream<Uint8Array> | null = null

  /**
   * @param port - the open port
   * @param info - the USB identity to report
   * @param readWaitMs - how long one pull waits for bytes before checking for a cancel
   */
  constructor(port: ControlSerialPort, info: WebSerialInfo, readWaitMs = 20) {
    this.#port = port
    this.#info = info
    this.#readWaitMs = readWaitMs
  }

  /** The bytes the board sends, while open. */
  get readable(): ReadableStream<Uint8Array> | null {
    if (this.#open && this.#readable === null) {
      this.#readable = this.#makeReadable()
    }
    return this.#readable
  }

  /** Where bytes for the board go, while open. A closed writer is replaced on the next read. */
  get writable(): WritableStream<Uint8Array> | null {
    if (this.#open && this.#writable === null) {
      this.#writable = this.#makeWritable()
    }
    return this.#writable
  }

  /**
   * The USB identity of the port.
   *
   * @returns the vendor and product IDs
   */
  getInfo(): WebSerialInfo {
    return { ...this.#info }
  }

  /**
   * Opens the streams at a speed.
   *
   * @param options - the speed, 115200 baud when left out
   */
  async open(options: WebSerialOpenOptions = {}): Promise<void> {
    await this.#port.setBaudRate(options.baudRate ?? 115200)
    this.#open = true
  }

  /** Drops the streams; the port stays open. */
  async close(): Promise<void> {
    this.#open = false
    const readable = this.#readable
    this.#readable = null
    this.#writable = null
    if (readable !== null && !readable.locked) {
      await readable.cancel()
    }
  }

  /**
   * Sets DTR and RTS.
   *
   * @param signals - the levels to set
   */
  async setSignals(signals: WebSerialSignals): Promise<void> {
    await this.#port.setSignals({
      ...(signals.dataTerminalReady === undefined ? {} : { dtr: signals.dataTerminalReady }),
      ...(signals.requestToSend === undefined ? {} : { rts: signals.requestToSend })
    })
  }

  /**
   * Changes speed without reopening, which esptool-js prefers when a port offers it.
   *
   * @param baud - the new speed
   */
  async setBaudRate(baud: number): Promise<void> {
    await this.#port.setBaudRate(baud)
  }

  #makeReadable(): ReadableStream<Uint8Array> {
    let cancelled = false
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (!cancelled) {
          const chunk = await this.#port.read(this.#readWaitMs)
          if (chunk.length > 0) {
            controller.enqueue(chunk)
            return
          }
        }
        controller.close()
      },
      cancel: () => {
        cancelled = true
        if (this.#readable !== null) {
          this.#readable = null
        }
      }
    })
  }

  #makeWritable(): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write: async (chunk) => this.#port.write(chunk),
      close: () => {
        this.#writable = null
      }
    })
  }
}
