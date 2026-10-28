import { CliError } from "../envelope.ts"
import type { BoardOps } from "./boards.ts"
import {
  API_VERSION,
  BadRequestError,
  type CoreErrorCode,
  type CoreRequest,
  type CoreResponse,
  type Hello,
  MAX_LIMIT,
  parseRequest
} from "./protocol.ts"

/**
 * Answers socket requests. Verbs that open a board run one at a time, so a flash never
 * interleaves with a reset.
 */
export class Core {
  readonly #ops: BoardOps
  readonly #version: string
  readonly #onShutdown: () => void
  #queue: Promise<unknown> = Promise.resolve()

  /**
   * @param ops - what the core does with boards
   * @param version - this `qualithm`'s version, reported by `hello`
   * @param onShutdown - called once the `shutdown` reply is on its way
   */
  constructor(ops: BoardOps, version: string, onShutdown: () => void) {
    this.#ops = ops
    this.#version = version
    this.#onShutdown = onShutdown
  }

  /**
   * Answers one request line. Never throws: every failure becomes an error reply.
   *
   * @param line - the request, without its newline
   * @returns the reply
   */
  async handle(line: string): Promise<CoreResponse> {
    let request: CoreRequest
    try {
      request = parseRequest(line)
    } catch (error) {
      return fail("usage", error instanceof BadRequestError ? error.message : String(error))
    }
    // `shutdown` works across versions, so a client can always replace an older core.
    if (request.api !== API_VERSION && request.verb !== "shutdown") {
      return fail(
        "api_mismatch",
        `the core speaks api ${String(API_VERSION)}, the request api ${String(request.api)}`
      )
    }
    try {
      return { api: API_VERSION, ok: true, data: await this.#dispatch(request) }
    } catch (error) {
      if (error instanceof CliError) {
        return fail(error.code, error.message)
      }
      return fail("error", error instanceof Error ? error.message : String(error))
    }
  }

  async #dispatch(request: CoreRequest): Promise<unknown> {
    const ops = this.#ops
    switch (request.verb) {
      case "hello":
        return { version: this.#version, pid: process.pid } satisfies Hello
      case "shutdown":
        setTimeout(this.#onShutdown, 0)
        return undefined
      case "list":
        return ops.list()
      case "flash":
        return this.#serial(async () => ops.flash(request.serialNumber))
      case "reset":
        return this.#serial(async () => ops.reset(request.serialNumber))
      case "run":
        return this.#serial(async () => ops.run(request.serialNumber, request.code))
      case "deploy": {
        const files = request.files.map((f) => ({
          path: f.path,
          bytes: new Uint8Array(Buffer.from(f.data, "base64"))
        }))
        const { setup } = request
        return this.#serial(async () =>
          ops.deploy(request.serialNumber, files, request.dryRun === true, setup)
        )
      }
      case "probe":
        return this.#serial(async () => ops.probe(request.serialNumber))
      // Reading and typing skip the queue: a long read must not hold up a flash.
      case "logs":
        return ops.logs(
          request.serialNumber,
          request.after ?? 0,
          request.wait_ms ?? 0,
          request.limit ?? MAX_LIMIT
        )
      case "write":
        return ops.write(request.serialNumber, request.data)
    }
  }

  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }
}

function fail(code: CoreErrorCode, message: string): CoreResponse {
  return { api: API_VERSION, ok: false, error: { code, message } }
}
