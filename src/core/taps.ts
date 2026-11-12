import type { Board } from "../board/pico.ts"
import type { SerialPort } from "../board/serial.ts"
import { CliError } from "../envelope.ts"

/** A piece of a board's output, numbered in the order it arrived. */
export type LogChunk = { seq: number; at_ms: number; text: string }

/** A run of a board's output after a given sequence number. */
export type LogPage = {
  board: { port: string; serialNumber?: string }
  chunks: LogChunk[]
  /** Pass as `after` to read on from here. */
  next: number
  /** Whether more chunks were waiting than `limit` allowed. */
  more: boolean
}

/** What taps reach for. */
export type TapDeps = {
  list: () => Promise<Board[]>
  /** Opens a board's port, ready to read. */
  open: (board: Extract<Board, { state: "micropython" | "esp32" }>) => Promise<SerialPort>
  /** Picks the running board a verb acts on. */
  pick: (
    boards: Board[],
    serialNumber?: string
  ) => Extract<Board, { state: "micropython" | "esp32" }>
  /** How long one read waits for bytes before checking whether to stop. */
  read_wait_ms: number
  /** How many chunks a board's buffer keeps; older ones are dropped. */
  max_chunks: number
  poll_ms: number
  sleep: (ms: number) => Promise<void>
}

type Running = Extract<Board, { state: "micropython" | "esp32" }>

type Tap = {
  port: SerialPort
  stopping: boolean
  reading: Promise<void>
}

type Buffer = { board: Running; chunks: LogChunk[]; seq: number; tap?: Tap }

const key = (board: Running): string => board.serialNumber?.toLowerCase() ?? board.port

/**
 * Holds boards' serial ports open between verbs, so their output is buffered while no one is
 * reading. A verb that needs a port for itself, such as a flash, takes it with `hold`.
 */
export class Taps {
  readonly #deps: TapDeps
  readonly #buffers = new Map<string, Buffer>()
  #held = 0

  constructor(deps: TapDeps) {
    this.#deps = deps
  }

  /**
   * Runs `work` with every tap closed, so it can open ports itself. Taps reopen on the next read
   * or write.
   *
   * @param work - what needs the ports
   * @returns what `work` returns
   */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.#held++
    try {
      await this.#closeAll()
      return await work()
    } finally {
      this.#held--
    }
  }

  /**
   * Reads a board's output after `after`, waiting up to `waitMs` for some to arrive.
   *
   * @param serialNumber - which board, when more than one is running
   * @param after - the last sequence number already read; 0 reads everything kept
   * @param waitMs - how long to wait when nothing new has arrived
   * @param limit - the most chunks to return
   * @returns the page
   * @throws {CliError} when no running board matches
   */
  async logs(
    serialNumber: string | undefined,
    after: number,
    waitMs: number,
    limit: number
  ): Promise<LogPage> {
    const buffer = await this.#attach(serialNumber, false)
    const deadline = Date.now() + waitMs
    while (buffer.seq <= after && Date.now() < deadline) {
      await this.#deps.sleep(this.#deps.poll_ms)
    }
    const fresh = buffer.chunks.filter((c) => c.seq > after)
    const chunks = fresh.slice(0, limit)
    const last = chunks.at(-1)?.seq ?? Math.max(after, buffer.seq)
    return { board: boardRef(buffer), chunks, next: last, more: fresh.length > chunks.length }
  }

  /**
   * Sends text to a board's console, as typing it would.
   *
   * @param serialNumber - which board, when more than one is running
   * @param data - the text
   * @returns the board written to
   * @throws {CliError} when no running board matches, or the board is busy
   */
  async write(serialNumber: string | undefined, data: string): Promise<LogPage["board"]> {
    const buffer = await this.#attach(serialNumber, true)
    // A tap that ended between attaching and writing means the board just went away.
    if (buffer.tap === undefined) {
      throw new CliError("the board went away: plug it back in and try again", "unavailable")
    }
    await buffer.tap.port.write(new TextEncoder().encode(data))
    return boardRef(buffer)
  }

  /** Closes every tap. */
  async close(): Promise<void> {
    await this.#closeAll()
  }

  /**
   * Finds a board's buffer and opens its tap when none is open. While a verb holds the ports,
   * a reader gets what is buffered and a writer is refused.
   */
  async #attach(serialNumber: string | undefined, writing: boolean): Promise<Buffer> {
    const board = this.#deps.pick(await this.#deps.list(), serialNumber)
    const id = key(board)
    let buffer = this.#buffers.get(id)
    if (buffer === undefined) {
      buffer = { board, chunks: [], seq: 0 }
      this.#buffers.set(id, buffer)
    }
    buffer.board = board
    if (buffer.tap !== undefined) {
      return buffer
    }
    if (this.#held > 0) {
      if (writing) {
        throw busy()
      }
      return buffer
    }
    const port = await this.#deps.open(board)
    buffer.tap = this.#read(buffer, port)
    return buffer
  }

  #read(buffer: Buffer, port: SerialPort): Tap {
    const decoder = new TextDecoder()
    const tap: Tap = { port, stopping: false, reading: Promise.resolve() }
    tap.reading = (async () => {
      try {
        while (!tap.stopping) {
          const bytes = await port.read(this.#deps.read_wait_ms)
          const text = decoder.decode(bytes, { stream: true })
          if (text !== "") {
            buffer.seq++
            buffer.chunks.push({ seq: buffer.seq, at_ms: Date.now(), text })
            if (buffer.chunks.length > this.#deps.max_chunks) {
              buffer.chunks.shift()
            }
          }
        }
      } catch {
        // The board went away (unplugged or restarting); the next read reattaches.
      } finally {
        if (buffer.tap === tap) {
          buffer.tap = undefined
        }
        await port.close()
      }
    })()
    return tap
  }

  async #closeAll(): Promise<void> {
    const taps = [...this.#buffers.values()].flatMap((b) => (b.tap === undefined ? [] : [b.tap]))
    for (const tap of taps) {
      tap.stopping = true
    }
    await Promise.all(taps.map(async (t) => t.reading))
  }
}

function boardRef(buffer: Buffer): LogPage["board"] {
  const { board } = buffer
  return {
    port: board.port,
    ...(board.serialNumber === undefined ? {} : { serialNumber: board.serialNumber })
  }
}

function busy(): CliError {
  return new CliError("the board is busy with a flash, reset or run: try again", "conflict")
}
