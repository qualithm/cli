import { resolve } from "node:path"

import { z } from "zod"

import { MICROPYTHON_PICO_2_W } from "../board/firmware.ts"
import { pickBoard } from "../board/flash.ts"
import type { Board } from "../board/pico.ts"
import { collectProject, type Setup } from "../board/sync.ts"
import { type DeployResult, pickRunning, type ProbeResult } from "../core/boards.ts"
import type { CoreClient } from "../core/client.ts"
import { MAX_LIMIT, MAX_WAIT_MS } from "../core/protocol.ts"
import type { LogPage } from "../core/taps.ts"
import { virtualSerial } from "../core/virtual.ts"
import { CliError } from "../envelope.ts"
import {
  keychainWifi,
  makeSetup,
  pickNetwork,
  pickScope,
  type Provisioned,
  type WifiLookup,
  type WifiResolver
} from "./provision.ts"
import { defineTool, dryRunInput, type Tool } from "./tool.ts"

const serialNumber = {
  serialNumber: z
    .string()
    .min(1)
    .optional()
    .describe("the board's USB serial number, needed when more than one board is plugged in")
}

/** How the board tools find what a new board needs. */
export type BoardToolOptions = {
  /** Finds the Wi-Fi details; the keychain alone by default, so an agent never sees them. */
  wifi?: WifiResolver
  /** What the default resolver and a dry run reach for. */
  lookup?: WifiLookup
}

/** Says why a deploy reached for the platform, keeping a CLI error's own code. */
function claimNeedsPlatform(error: unknown): unknown {
  if (error instanceof CliError) {
    return error
  }
  const reason = error instanceof Error ? error.message : String(error)
  return new CliError(
    `the board isn't claimed yet, and claiming it needs the platform: ${reason}`,
    "auth"
  )
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
 * @param options - how a deploy finds Wi-Fi details; the keychain alone by default
 * @returns the tools
 */
export function boardTools(client: CoreClient, options: BoardToolOptions = {}): Tool[] {
  const resolveWifi = options.wifi ?? keychainWifi(options.lookup)

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
      name: "deploy_project",
      description:
        "Put a MicroPython project folder on a plugged-in Pico 2 W and restart it so main.py runs. Installs the Qualithm Device SDK beside it, writes only files that changed since the last deploy, flashes MicroPython first on a blank board, and never touches the device's credential. With `virtual`, runs the project on this computer as a virtual device instead: no board, the host's network, and a device on the platform like any other; read its output with board_logs and serialNumber `virtual:<folder name>`.",
      mutating: true,
      local: true,
      input: {
        dir: z.string().min(1).describe("the project folder on this computer"),
        ...serialNumber,
        scopeId: z
          .string()
          .min(1)
          .optional()
          .describe("the scope a new board joins; needed only when the team has several"),
        wifiNetwork: z
          .string()
          .min(1)
          .optional()
          .describe(
            "the Wi-Fi network a new board joins; defaults to this computer's likeliest. The passphrase is read from this computer's keychain, never passed here"
          ),
        virtual: z
          .boolean()
          .optional()
          .describe(
            "run the project on this computer as a virtual device rather than on a board; it counts as a device"
          ),
        ...dryRunInput
      },
      run: async (session, input) => {
        const dir = resolve(input.dir)
        const files = await collectProject(dir)
        const virtual = input.virtual === true
        if (virtual && (input.serialNumber !== undefined || input.wifiNetwork !== undefined)) {
          throw new CliError(
            "a virtual device takes no serial number or Wi-Fi: it is named after its folder and uses this computer's network",
            "usage"
          )
        }
        const serial = virtual ? virtualSerial(dir) : input.serialNumber
        const target = serial === undefined ? {} : { serialNumber: serial }
        const dryRun = input.dryRun === true
        const state = (await client.send({ verb: "probe", ...target })) as ProbeResult
        let setup: Setup | undefined
        let provisioned: Provisioned | undefined
        if (!state.credential && virtual) {
          const scopeId = await pickScope(session, input.scopeId).catch((error: unknown) => {
            throw claimNeedsPlatform(error)
          })
          provisioned = { scopeId }
          if (!dryRun) {
            setup = await makeSetup(session, scopeId, undefined)
          }
        } else if (!state.credential) {
          // A board with no credential gets a fresh code each deploy, so an expired one never strands it.
          const scopeId = await pickScope(session, input.scopeId).catch((error: unknown) => {
            throw claimNeedsPlatform(error)
          })
          const keep = input.wifiNetwork === undefined ? state.wifiNetwork : undefined
          if (dryRun) {
            const network = keep ?? (await pickNetwork(input.wifiNetwork, options.lookup))
            provisioned = { scopeId, wifiNetwork: network }
          } else {
            const wifi = keep === undefined ? await resolveWifi(input.wifiNetwork) : undefined
            setup = await makeSetup(session, scopeId, wifi)
            provisioned = { scopeId, wifiNetwork: wifi?.ssid ?? keep ?? "" }
          }
        }
        const result = (await client.send({
          verb: "deploy",
          ...target,
          files: files.map((f) => ({
            path: f.path,
            data: Buffer.from(f.bytes).toString("base64")
          })),
          dryRun,
          ...(setup === undefined ? {} : { setup })
        })) as DeployResult
        return provisioned === undefined ? result : { ...result, provisioned }
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
