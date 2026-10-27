import { z } from "zod"

import { MICROPYTHON_PICO_2_W } from "../board/firmware.ts"
import { pickBoard } from "../board/flash.ts"
import type { Board } from "../board/pico.ts"
import { pickRunning } from "../core/boards.ts"
import type { CoreClient } from "../core/client.ts"
import { MAX_LIMIT, MAX_WAIT_MS } from "../core/protocol.ts"
import type { LogPage } from "../core/taps.ts"
import { defineTool, dryRunInput, type Tool } from "./tool.ts"

const serialNumber = {
  serialNumber: z
    .string()
    .min(1)
    .optional()
    .describe("the board's USB serial number, needed when more than one board is plugged in")
}

/** What a console exchange returns. */
export type ConsoleReply = {
  board: LogPage["board"]
  /** What the board printed after the input, echo included. */
  output: string
  /** Pass to `board_logs` as `after` to read on from here. */
  next: number
}

async function list(client: CoreClient): Promise<Board[]> {
  return (await client.send({ verb: "list" })) as Board[]
}

async function logs(
  client: CoreClient,
  serial: string | undefined,
  after: number,
  waitMs: number
): Promise<LogPage> {
  return (await client.send({
    verb: "logs",
    ...(serial === undefined ? {} : { serialNumber: serial }),
    after,
    wait_ms: waitMs,
    limit: MAX_LIMIT
  })) as LogPage
}

/**
 * Types `input` into a board's console and collects what it prints for `waitMs`.
 *
 * @param client - the core
 * @param serial - which board
 * @param input - the text to type; a trailing newline runs a line
 * @param waitMs - how long to collect output
 * @returns the board's output after the input
 */
export async function consoleExchange(
  client: CoreClient,
  serial: string | undefined,
  input: string,
  waitMs: number
): Promise<ConsoleReply> {
  let next = await tail(client, serial)
  let page: LogPage | undefined
  await client.send({
    verb: "write",
    ...(serial === undefined ? {} : { serialNumber: serial }),
    data: input
  })
  let output = ""
  const deadline = Date.now() + waitMs
  for (let left = waitMs; left > 0; left = deadline - Date.now()) {
    page = await logs(client, serial, next, left)
    output += page.chunks.map((c) => c.text).join("")
    ;({ next } = page)
  }
  page ??= await logs(client, serial, next, 0)
  return { board: page.board, output, next }
}

/**
 * The sequence number of a board's newest buffered output, so a reader can start from now.
 *
 * @param client - the core
 * @param serial - which board
 * @returns the number to pass as `after`
 */
export async function tail(client: CoreClient, serial: string | undefined): Promise<number> {
  let page = await logs(client, serial, 0, 0)
  while (page.more) {
    page = await logs(client, serial, page.next, 0)
  }
  return page.next
}

/**
 * The board tools over `client`: the same calls the `qualithm board` commands make.
 *
 * @param client - the device core
 * @returns the tools
 */
export function boardTools(client: CoreClient): Tool[] {
  return [
    defineTool({
      name: "list_boards",
      description:
        "List the boards plugged into this computer: Pico 2 Ws running MicroPython, and any waiting in BOOTSEL to be flashed.",
      mutating: false,
      local: true,
      input: {},
      run: async () => list(client)
    }),
    defineTool({
      name: "flash_board",
      description: `Put MicroPython ${MICROPYTHON_PICO_2_W.version} on a plugged-in Pico 2 W, blank or running, and check it came back running that release.`,
      mutating: true,
      local: true,
      input: { ...serialNumber, ...dryRunInput },
      run: async (_session, input) => {
        if (input.dryRun === true) {
          const board = pickBoard(await list(client), input.serialNumber)
          return { board, version: MICROPYTHON_PICO_2_W.version }
        }
        return client.send({
          verb: "flash",
          ...(input.serialNumber === undefined ? {} : { serialNumber: input.serialNumber })
        })
      }
    }),
    defineTool({
      name: "reset_board",
      description:
        "Restart a running board, as its reset button would, and wait until it is running again.",
      mutating: true,
      local: true,
      input: { ...serialNumber, ...dryRunInput },
      run: async (_session, input) => {
        if (input.dryRun === true) {
          const board = pickRunning(await list(client), input.serialNumber)
          return { board }
        }
        return client.send({
          verb: "reset",
          ...(input.serialNumber === undefined ? {} : { serialNumber: input.serialNumber })
        })
      }
    }),
    defineTool({
      name: "board_logs",
      description:
        "Read what a running board has printed. Pass the previous reply's `next` as `after` to read on; `waitMs` waits for new output.",
      mutating: false,
      local: true,
      input: {
        ...serialNumber,
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("read output after this sequence number; 0 reads all that is kept"),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe("how long to wait for output when none is new")
      },
      run: async (_session, input) =>
        logs(client, input.serialNumber, input.after ?? 0, input.waitMs ?? 0)
    }),
    defineTool({
      name: "board_console",
      description:
        "Type into a running board's MicroPython prompt and return what it prints. End the input with a newline to run a line.",
      mutating: true,
      local: true,
      input: {
        ...serialNumber,
        input: z.string().min(1).describe("the text to type, e.g. `print(1 + 1)\\n`"),
        waitMs: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_MS)
          .optional()
          .describe("how long to collect output; defaults to one second"),
        ...dryRunInput
      },
      run: async (_session, input) => {
        if (input.dryRun === true) {
          const board = pickRunning(await list(client), input.serialNumber)
          return { board, input: input.input }
        }
        return consoleExchange(client, input.serialNumber, input.input, input.waitMs ?? 1000)
      }
    })
  ]
}
