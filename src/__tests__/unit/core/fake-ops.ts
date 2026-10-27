import type { FlashResult } from "../../../board/flash.ts"
import type { Board } from "../../../board/pico.ts"
import type { BoardOps, BoardRef } from "../../../core/boards.ts"
import { CliError } from "../../../envelope.ts"

/** Board operations that record what they were asked and answer from fixtures. */
export type FakeOps = BoardOps & {
  calls: string[]
  /** When set, every board verb fails with this error. */
  fail?: Error
  /** How long `flash` takes, so tests can overlap two calls. */
  flash_ms: number
}

export const BOARD: Board = { state: "micropython", port: "/dev/cu.pico", serialNumber: "abc" }
const REF: BoardRef = { port: "/dev/cu.pico", serialNumber: "abc" }

/**
 * Builds fake board operations.
 *
 * @returns the fake
 */
export function fakeOps(): FakeOps {
  const ops: FakeOps = {
    calls: [],
    flash_ms: 0,
    list: async () => Promise.resolve([BOARD]),
    flash: async (serialNumber) => {
      ops.calls.push(`flash:start:${serialNumber ?? "-"}`)
      await new Promise((resolve) => setTimeout(resolve, ops.flash_ms))
      if (ops.fail !== undefined) {
        ops.calls.push("flash:fail")
        throw ops.fail
      }
      ops.calls.push("flash:end")
      return { ...REF, version: "1.29.0", machine: "Pico" } satisfies FlashResult
    },
    reset: async (serialNumber) => {
      ops.calls.push(`reset:${serialNumber ?? "-"}`)
      if (ops.fail !== undefined) {
        throw ops.fail
      }
      return Promise.resolve(REF)
    },
    run: async (serialNumber, code) => {
      ops.calls.push(`run:${serialNumber ?? "-"}:${code}`)
      if (ops.fail !== undefined) {
        throw ops.fail
      }
      return Promise.resolve({ board: REF, output: "42\n" })
    },
    logs: async (serialNumber, after, waitMs, limit) => {
      ops.calls.push(
        `logs:${serialNumber ?? "-"}:${String(after)}:${String(waitMs)}:${String(limit)}`
      )
      return Promise.resolve({
        board: REF,
        chunks: [{ seq: after + 1, at_ms: 0, text: ">>> " }],
        next: after + 1,
        more: false
      })
    },
    write: async (serialNumber, data) => {
      ops.calls.push(`write:${serialNumber ?? "-"}:${data}`)
      return Promise.resolve(REF)
    },
    close: async () => {
      ops.calls.push("close")
      return Promise.resolve()
    }
  }
  return ops
}

export const NOT_FOUND = new CliError("no board found", "not_found")
