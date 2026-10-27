import { parseArgs, type ParseArgsOptionsConfig } from "node:util"

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { applyCommands } from "./commands/apply.ts"
import { authorityCommands } from "./commands/authorities.ts"
import type { Command, ToolCommand } from "./commands/command.ts"
import { credentialCommands } from "./commands/credentials.ts"
import { deviceCommands } from "./commands/devices.ts"
import { enrollmentCommands } from "./commands/enrollments.ts"
import { spaceCommands } from "./commands/spaces.ts"
import { tokenCommands } from "./commands/tokens.ts"
import { type CoreIo, runCore } from "./core/command.ts"
import { CliError, EXIT_CODES, exitCode, failure, type Result } from "./envelope.ts"
import { buildMcpServer, callTool, type SessionFactory } from "./mcp.ts"
import { type FetchAPI, Session, type SessionConfig } from "./platform.ts"
import { VERSION } from "./version.ts"

/** Where the CLI reads its settings and writes its output; tests pass their own. */
export type CliIo = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Environment variables; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  /** The `fetch` platform calls go through; defaults to the global one. */
  fetch?: FetchAPI
  /** Serves `qualithm mcp`; defaults to stdio. */
  serveMcp?: (server: ReturnType<typeof buildMcpServer>) => Promise<void>
  /** What `qualithm core run` reaches for; defaults to the real machine. */
  core?: Omit<CoreIo, "stdout" | "stderr">
}

/** Every command, in the order help lists them. */
export const COMMANDS: readonly Command[] = [
  ...authorityCommands,
  ...credentialCommands,
  ...deviceCommands,
  ...enrollmentCommands,
  ...spaceCommands,
  ...tokenCommands,
  ...applyCommands
]

const RESOURCE_ALIASES: Readonly<Record<string, string>> = {
  authorities: "authority",
  credentials: "credential",
  devices: "device",
  enrollments: "enrollment",
  spaces: "space",
  tokens: "token",
  "api-token": "token"
}

const COMMON_OPTIONS = {
  url: { type: "string" },
  token: { type: "string" },
  team: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" }
} as const satisfies ParseArgsOptionsConfig

export const USAGE = `qualithm: the Qualithm CLI and MCP server.

Usage:
  qualithm <resource> <verb> [flags]
  qualithm apply <manifest.yaml> [flags]
  qualithm mcp                          serve every tool over stdio, for an agent
  qualithm core run | status | stop     the local device core (started for you when needed)

Flags, accepted by every verb before or after its arguments:
  --url string     API base URL (env QUALITHM_API_URL)
  --token string   member API token (env QUALITHM_API_TOKEN)
  --team string    team to act on; defaults to the token's team (env QUALITHM_TEAM)
  --json           print one JSON envelope line instead of a table
  --dry-run        report the planned change without applying it

Resources and verbs:
  authority  list | create | revoke <id>
  credential list | mint | cert | rotate | revoke
  device     list | get <id> | create | update <id> | delete <id>
  enrollment list | create | revoke <id>
  space      list | get <id> | create | update <id> | delete <id>
  token      list | revoke <id>
  apply      <manifest.yaml>            idempotent device-as-code reconcile
  version                               print the CLI version

Examples:
  qualithm enrollment create --space spc_123 --label lab-floor-2
  qualithm device list --json
  qualithm credential mint --device dev_123 --json
  qualithm credential revoke --device dev_123 --credential cred_123 --dry-run
  qualithm authority create --name fleet --kind byo --cert-file ca.pem --dry-run
  qualithm apply fleet.yaml --dry-run

Exit codes:
  0 ok (incl. dry-run)  1 error  2 usage  3 auth  4 not-found  5 conflict
  6 rate-limited        7 api    8 unavailable
`

function findCommand(resource: string, verb: string): Command | undefined {
  const name = RESOURCE_ALIASES[resource] ?? resource
  return COMMANDS.find(
    (command) =>
      command.path[0] === name &&
      command.path.length === 2 &&
      (command.path[1] === verb || (command.aliases?.includes(verb) ?? false))
  )
}

function sessionConfig(
  io: CliIo,
  values: Readonly<Record<string, string | boolean | undefined>>,
  userAgent: string
): SessionConfig {
  const env = io.env ?? process.env
  const pick = (flag: string, name: string): string | undefined => {
    const value = values[flag]
    return typeof value === "string" ? value : env[name] === "" ? undefined : env[name]
  }
  const token = pick("token", "QUALITHM_API_TOKEN")
  const baseUrl = pick("url", "QUALITHM_API_URL")
  const team = pick("team", "QUALITHM_TEAM")
  return {
    userAgent,
    ...(token === undefined ? {} : { token }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(team === undefined ? {} : { team }),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch })
  }
}

function report(io: CliIo, json: boolean, result: Result, human: () => string): number {
  if (json) {
    io.stdout(`${JSON.stringify(result)}\n`)
  } else if (!result.ok) {
    io.stderr(`qualithm: ${result.message ?? "request failed"}\n`)
  } else if (result.dryRun === true && result.action !== undefined) {
    const { method, path, body } = result.action
    io.stdout(`dry-run: would ${method} ${path}\n`)
    if (body !== undefined) {
      io.stdout(`  body: ${JSON.stringify(body)}\n`)
    }
  } else {
    io.stdout(human())
  }
  return exitCode(result)
}

async function runToolCommand(command: ToolCommand, args: string[], io: CliIo): Promise<number> {
  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args,
      options: { ...COMMON_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return report(io, false, failure(new CliError(message.toLowerCase())), () => "")
  }
  const json = values.json === true
  if (values.help === true) {
    io.stdout(USAGE)
    return EXIT_CODES.ok
  }
  let input: Record<string, unknown>
  try {
    input = command.toInput({ values, positionals })
  } catch (error) {
    return report(io, json, failure(error), () => "")
  }
  if (command.tool.mutating) {
    input.dryRun = values["dry-run"] === true
  }
  const config = sessionConfig(io, values, `qualithm/${VERSION}`)
  const newSession: SessionFactory = (dryRun) => new Session({ ...config, dryRun })
  const result = await callTool(command.tool, newSession, input)
  return report(io, json, result, () => command.human(result.data, input))
}

async function runMcp(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: COMMON_OPTIONS, strict: false })
  const config = sessionConfig(io, values, `qualithm-mcp/${VERSION}`)
  const newSession: SessionFactory = (dryRun) => new Session({ ...config, dryRun })
  try {
    // Fail at start rather than on the first call when there is no token.
    newSession(false)
  } catch (error) {
    return report(io, false, failure(error), () => "")
  }
  const serve = io.serveMcp ?? (async (server) => server.connect(new StdioServerTransport()))
  await serve(buildMcpServer(newSession, VERSION))
  return EXIT_CODES.ok
}

/** Commands that parse their own arguments. */
const SUBPROGRAMS: Readonly<
  Record<string, ((args: string[], io: CliIo) => Promise<number>) | undefined>
> = {
  mcp: runMcp,
  core: async (args, io) => runCore(args, { ...io.core, stdout: io.stdout, stderr: io.stderr })
}

/**
 * Runs one CLI invocation. Never throws: every failure becomes an exit code and a message.
 *
 * @param argv - the arguments after the binary name
 * @param io - where output goes and settings come from
 * @returns the exit code
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [first, second, ...rest] = argv
  switch (first) {
    case undefined:
      io.stderr(USAGE)
      return EXIT_CODES.usage
    case "-h":
    case "--help":
    case "help":
      io.stdout(USAGE)
      return EXIT_CODES.ok
    case "version":
    case "--version":
    case "-v":
      io.stdout(`qualithm ${VERSION}\n`)
      return EXIT_CODES.ok
    default:
      break
  }
  const subprogram = SUBPROGRAMS[first]
  if (subprogram !== undefined) {
    return subprogram(argv.slice(1), io)
  }
  // A single-word command, such as `apply`, takes its arguments where a verb would be.
  const single = COMMANDS.find((c): c is ToolCommand => c.path.length === 1 && c.path[0] === first)
  if (single !== undefined) {
    return runToolCommand(single, argv.slice(1), io)
  }
  if (second === undefined || second === "-h" || second === "--help" || second === "help") {
    const known = COMMANDS.some((c) => c.path[0] === (RESOURCE_ALIASES[first] ?? first))
    if (!known) {
      io.stderr(`qualithm: unknown command "${first}"\n\n${USAGE}`)
      return EXIT_CODES.usage
    }
    ;(second === undefined ? io.stderr : io.stdout)(USAGE)
    return second === undefined ? EXIT_CODES.usage : EXIT_CODES.ok
  }
  const command = findCommand(first, second)
  if (command === undefined) {
    io.stderr(`qualithm: unknown command "${first} ${second}"\n\n${USAGE}`)
    return EXIT_CODES.usage
  }
  if ("refuse" in command) {
    io.stderr(`qualithm: ${command.refuse}\n`)
    return EXIT_CODES.usage
  }
  return runToolCommand(command, rest, io)
}
