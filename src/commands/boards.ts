import { parseArgs } from "node:util"

import type { FlashResult } from "../board/flash.ts"
import type { Board } from "../board/pico.ts"
import type { DeployResult } from "../core/boards.ts"
import { type CoreClient, socketClient } from "../core/client.ts"
import { MAX_LIMIT } from "../core/protocol.ts"
import type { LogPage } from "../core/taps.ts"
import { VIRTUAL_PREFIX } from "../core/virtual.ts"
import { CliError, EXIT_CODES, exitCode, failure, type Result } from "../envelope.ts"
import { callTool, type SessionFactory } from "../mcp.ts"
import { dash, table } from "../table.ts"
import { boardTools, type ConsoleReply, tail } from "../tools/boards.ts"
import { type Ask, type Provisioned, terminalWifi, type WifiLookup } from "../tools/provision.ts"
import { terminalAsk } from "./ask.ts"
import { intOption, stringOption } from "./command.ts"

/** Where `qualithm board` writes and what it talks to; tests pass their own. */
export type BoardIo = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** The device core; the user's own, started when needed, by default. */
  client?: CoreClient
  /** Keys typed into `board console`; the terminal by default. */
  stdin?: AsyncIterable<Uint8Array | string>
  /** Ends `board logs --follow` and `board console`; Ctrl-C by default. */
  signal?: AbortSignal
  /**
   * Builds the platform session a deploy claims a new board with, from the parsed flags.
   * Without it, a deploy that needs the platform fails.
   */
  newSession?: (values: PlatformFlags) => SessionFactory
  /** Asks the person for Wi-Fi details; the terminal when there is one, else nobody. */
  ask?: Ask
  /** Where Wi-Fi networks and passphrases come from; the OS by default. */
  wifiLookup?: WifiLookup
}

/** The platform flags a deploy takes. */
export type PlatformFlags = { url?: string; token?: string; team?: string }

export const BOARD_USAGE = `Usage:
  qualithm deploy [dir] [--serial S]        put a MicroPython project folder on a board and restart it
  qualithm deploy [dir] --virtual           run it on this computer as a virtual device instead
  qualithm board list                       the boards plugged into this computer
  qualithm board flash [--serial S]         put MicroPython on a board, blank or running
  qualithm board reset [--serial S]         restart a running board
  qualithm board logs [--serial S] [-f]     print what a board has printed; -f keeps following
  qualithm board console [--serial S]       type into a board's prompt; Ctrl-] leaves
  qualithm board console --input TEXT       type TEXT and print what the board answers

Flags:
  --serial string  the board's serial number, needed when more than one is plugged in;
                   virtual:<folder> for a virtual device
  --virtual        deploy to a virtual device on this computer, not a board
  --json           print one JSON envelope line
  --dry-run        name the board a flash, reset or console input would act on
`

/** Ctrl-], the key that leaves the console, as telnet and screen use it. */
const LEAVE = 0x1d

const OPTIONS = {
  serial: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  follow: { type: "boolean", short: "f" },
  after: { type: "string" },
  input: { type: "string" },
  wait: { type: "string" },
  space: { type: "string" },
  wifi: { type: "string" },
  url: { type: "string" },
  token: { type: "string" },
  team: { type: "string" },
  virtual: { type: "boolean" },
  help: { type: "boolean", short: "h" }
} as const

type Values = {
  serial?: string
  json?: boolean
  "dry-run"?: boolean
  follow?: boolean
  after?: string
  input?: string
  wait?: string
  space?: string
  wifi?: string
  url?: string
  token?: string
  team?: string
  virtual?: boolean
  help?: boolean
}

function where(board: { port: string; serialNumber?: string }): string {
  return board.serialNumber === undefined ? board.port : `${board.serialNumber} on ${board.port}`
}

function boardsTable(boards: Board[]): string {
  if (boards.length === 0) {
    return "no boards plugged in\n"
  }
  return table([
    ["STATE", "SERIAL", "WHERE"],
    ...boards.map((b) =>
      b.state === "micropython"
        ? ["micropython", dash(b.serialNumber), b.port]
        : ["bootsel", "-", b.drive]
    )
  ])
}

function deployed(result: DeployResult & { provisioned?: Provisioned }, dryRun: boolean): string {
  const lines: string[] = []
  const would = dryRun ? "would " : ""
  const virtual = result.board.serialNumber?.startsWith(VIRTUAL_PREFIX) === true
  if (result.provisioned !== undefined) {
    const { spaceId, wifiNetwork } = result.provisioned
    lines.push(
      wifiNetwork === undefined
        ? `${would}set the virtual device to claim itself into space ${spaceId}`
        : `${would}set the board to claim itself into space ${spaceId} on Wi-Fi ${wifiNetwork}`
    )
  }
  if (result.flashed !== undefined) {
    lines.push(`${would}flash MicroPython ${result.flashed} first`)
  }
  for (const path of result.written) {
    lines.push(`${would}write  ${path}`)
  }
  for (const path of result.removed) {
    lines.push(`${would}remove ${path}`)
  }
  const changes = result.written.length + result.removed.length
  const summary = dryRun
    ? `dry-run: ${String(changes)} change(s), ${String(result.unchanged)} file(s) already match`
    : `deployed to ${where(result.board)}: ${String(result.written.length)} written, ${String(result.removed.length)} removed, ${String(result.unchanged)} unchanged; restarted`
  const follow =
    virtual && !dryRun
      ? [`follow its output: qualithm board logs --serial ${result.board.serialNumber ?? ""} -f`]
      : []
  return `${[...lines, summary, ...follow].join("\n")}\n`
}

function human(verb: string, data: unknown, dryRun: boolean): string {
  if (verb === "list") {
    return boardsTable(data as Board[])
  }
  if (dryRun && verb !== "deploy") {
    const { board } = data as { board: Board }
    const at = board.state === "micropython" ? where(board) : `BOOTSEL drive ${board.drive}`
    return `dry-run: would ${verb} ${at}\n`
  }
  if (verb === "deploy") {
    return deployed(data as DeployResult, dryRun)
  }
  if (verb === "flash") {
    const result = data as FlashResult
    return `flashed MicroPython ${result.version} onto ${where(result)}\n`
  }
  if (verb === "reset") {
    return `reset ${where(data as { port: string })}, running again\n`
  }
  if (verb === "logs") {
    return (data as LogPage).chunks.map((c) => c.text).join("")
  }
  return (data as ConsoleReply).output
}

function print(io: BoardIo, json: boolean, result: Result, text: () => string): number {
  if (json) {
    io.stdout(`${JSON.stringify(result)}\n`)
  } else if (!result.ok) {
    io.stderr(`qualithm: ${result.message ?? "board request failed"}\n`)
  } else {
    io.stdout(text())
  }
  return exitCode(result)
}

function inputFor(
  verb: string,
  values: Values,
  positionals: readonly string[]
): Record<string, unknown> {
  const serial = stringOption(values, "serial")
  const input: Record<string, unknown> = serial === undefined ? {} : { serialNumber: serial }
  if (verb === "deploy") {
    input.dir = positionals[1] ?? "."
    const space = stringOption(values, "space")
    const wifi = stringOption(values, "wifi")
    if (space !== undefined) {
      input.spaceId = space
    }
    if (wifi !== undefined) {
      input.wifiNetwork = wifi
    }
    if (values.virtual === true) {
      input.virtual = true
    }
  }
  if (verb === "flash" || verb === "reset" || verb === "console" || verb === "deploy") {
    input.dryRun = values["dry-run"] === true
  }
  if (verb === "logs") {
    const after = intOption(values, "after")
    if (after !== undefined) {
      input.after = after
    }
  }
  if (verb === "console") {
    input.input = values.input
    const wait = intOption(values, "wait")
    if (wait !== undefined) {
      input.waitMs = wait
    }
  }
  return input
}

const TOOL_NAMES: Readonly<Record<string, string | undefined>> = {
  deploy: "deploy_project",
  list: "list_boards",
  flash: "flash_board",
  reset: "reset_board",
  logs: "board_logs",
  console: "board_console"
}

function defaultSignal(): AbortSignal {
  const controller = new AbortController()
  process.once("SIGINT", () => {
    controller.abort()
  })
  return controller.signal
}

/** Codes a follower rides out: the board restarting, being flashed, or briefly unplugged. */
const TRANSIENT = new Set(["not_found", "unavailable", "conflict"])

/** Prints a board's output after `after` until `stop` fires, riding out restarts. */
async function pump(
  io: BoardIo,
  client: CoreClient,
  serial: string | undefined,
  after: number,
  stop: AbortSignal
): Promise<void> {
  let next = after
  while (!stop.aborted) {
    let page: LogPage
    try {
      page = (await client.send({
        verb: "logs",
        ...(serial === undefined ? {} : { serialNumber: serial }),
        after: next,
        wait_ms: 250,
        limit: MAX_LIMIT
      })) as LogPage
    } catch (error) {
      if (!(error instanceof CliError) || !TRANSIENT.has(error.code)) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    io.stdout(page.chunks.map((c) => c.text).join(""))
    ;({ next } = page)
  }
}

async function follow(
  io: BoardIo,
  client: CoreClient,
  serial: string | undefined,
  after: number,
  signal: AbortSignal
): Promise<number> {
  await pump(io, client, serial, after, signal)
  return EXIT_CODES.ok
}

async function interactive(
  io: BoardIo,
  client: CoreClient,
  serial: string | undefined,
  stdin: AsyncIterable<Uint8Array | string>,
  signal: AbortSignal
): Promise<number> {
  const target = serial === undefined ? {} : { serialNumber: serial }
  const leave = new AbortController()
  signal.addEventListener("abort", () => {
    leave.abort()
  })
  const start = await tail(client, serial)
  io.stderr("qualithm: connected; press Enter for a prompt, Ctrl-] leaves\n")
  const reading = pump(io, client, serial, start, leave.signal)
  try {
    for await (const chunk of stdin) {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
      const end = bytes.indexOf(LEAVE)
      const typed = new TextDecoder().decode(end === -1 ? bytes : bytes.slice(0, end))
      if (typed !== "") {
        await client.send({ verb: "write", ...target, data: typed })
      }
      if (end !== -1 || leave.signal.aborted) {
        break
      }
    }
  } finally {
    leave.abort()
    await reading
  }
  io.stderr("\nqualithm: left the console\n")
  return EXIT_CODES.ok
}

/** The terminal to ask on, when the CLI has one. */
function defaultAsk(io: BoardIo): Ask | undefined {
  if (io.stdin !== undefined || !process.stdin.isTTY) {
    return undefined
  }
  return terminalAsk({ input: process.stdin, output: io.stderr })
}

function terminalInput(): AsyncIterable<Uint8Array | string> {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.once("exit", () => {
      process.stdin.setRawMode(false)
    })
  }
  return process.stdin
}

/** Runs the verbs that stream, `logs --follow` and an interactive `console`; else undefined. */
async function stream(
  verb: string,
  values: Values,
  input: Record<string, unknown>,
  io: BoardIo,
  client: CoreClient
): Promise<number | undefined> {
  const serial = stringOption(values, "serial")
  if (verb === "logs" && values.follow === true) {
    const after = (input.after as number | undefined) ?? 0
    return follow(io, client, serial, after, io.signal ?? defaultSignal())
  }
  if (verb !== "console" || values.input !== undefined || input.dryRun === true) {
    return undefined
  }
  if (values.json === true) {
    throw new CliError("an interactive console has no --json form: pass --input", "usage")
  }
  return interactive(io, client, serial, io.stdin ?? terminalInput(), io.signal ?? defaultSignal())
}

/** Runs a verb's board tool, with a terminal to ask on and a session for claiming. */
async function runTool(
  name: string,
  io: BoardIo,
  client: CoreClient,
  values: Values,
  input: Record<string, unknown>
): Promise<Result> {
  const ask = io.ask ?? defaultAsk(io)
  const lookup = io.wifiLookup ?? {}
  const tools = boardTools(client, {
    lookup,
    ...(ask === undefined ? {} : { wifi: terminalWifi(ask, lookup) })
  })
  const tool = tools.find((t) => t.name === name)
  if (tool === undefined) {
    return failure(new CliError(`no board tool ${name}`, "error"))
  }
  const flags: PlatformFlags = {
    ...(values.url === undefined ? {} : { url: values.url }),
    ...(values.token === undefined ? {} : { token: values.token }),
    ...(values.team === undefined ? {} : { team: values.team })
  }
  const newSession: SessionFactory =
    io.newSession?.(flags) ??
    (() => {
      throw new CliError("this command can't reach the platform here", "error")
    })
  return callTool(tool, newSession, input)
}

/**
 * Runs `qualithm board <verb>`. Never throws: every failure becomes an exit code and a message.
 *
 * @param args - the arguments after `board`
 * @param io - where output goes and what to talk to
 * @returns the exit code
 */
export async function runBoard(args: readonly string[], io: BoardIo): Promise<number> {
  let values: Values
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: [...args],
      options: OPTIONS,
      allowPositionals: true,
      strict: true
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`qualithm: ${message.toLowerCase()}\n`)
    return EXIT_CODES.usage
  }
  const [verb] = positionals
  if (values.help === true || verb === "help") {
    io.stdout(BOARD_USAGE)
    return EXIT_CODES.ok
  }
  const name = verb === undefined ? undefined : TOOL_NAMES[verb]
  if (verb === undefined || name === undefined) {
    const what = verb === undefined ? "board needs a verb" : `unknown command "board ${verb}"`
    io.stderr(`qualithm: ${what}\n\n${BOARD_USAGE}`)
    return EXIT_CODES.usage
  }
  const json = values.json === true
  const client = io.client ?? socketClient()
  let input: Record<string, unknown>
  try {
    input = inputFor(verb, values, positionals)
  } catch (error) {
    return print(io, json, failure(error), () => "")
  }
  try {
    const streamed = await stream(verb, values, input, io, client)
    if (streamed !== undefined) {
      return streamed
    }
  } catch (error) {
    return print(io, json, failure(error), () => "")
  }
  const result = await runTool(name, io, client, values, input)
  return print(io, json, result, () => human(verb, result.data, result.dryRun === true))
}
