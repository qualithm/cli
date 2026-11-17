import { parseArgs, type ParseArgsOptionsConfig } from "node:util"

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { DEFAULT_BASE_URL } from "@qualithm/platform"

import type { AgentHost } from "./agents/connect.ts"
import { fileLock, LoginSource, NOT_LOGGED_IN, type RefreshLock } from "./auth/login.ts"
import { type CredentialStore, keychainStore } from "./auth/store.ts"
import { runAgents } from "./commands/agents.ts"
import { applyCommands } from "./commands/apply.ts"
import { type AuthIo, runAuth } from "./commands/auth.ts"
import { authorityCommands } from "./commands/authorities.ts"
import { automationCommands } from "./commands/automations.ts"
import { type BoardIo, runBoard } from "./commands/boards.ts"
import type { Command, ToolCommand } from "./commands/command.ts"
import { credentialCommands } from "./commands/credentials.ts"
import { deviceCommands } from "./commands/devices.ts"
import { enrollmentCommands } from "./commands/enrollments.ts"
import { scopeCommands } from "./commands/scopes.ts"
import { tokenCommands } from "./commands/tokens.ts"
import { type CoreIo, runCore } from "./core/command.ts"
import { CliError, EXIT_CODES, exitCode, failure, type Result } from "./envelope.ts"
import { buildMcpServer, callTool, type SessionFactory } from "./mcp.ts"
import { type FetchAPI, Session, type SessionConfig } from "./platform.ts"
import { nextPage } from "./table.ts"
import { TOOLS } from "./tools/index.ts"
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
  /** What `qualithm board` talks to; defaults to the user's core and terminal. @internal */
  board?: Omit<BoardIo, "stdout" | "stderr">
  /** The machine `qualithm agents` connects; defaults to this one. @internal */
  agents?: AgentHost
  /** What `qualithm core run` reaches for; defaults to the real machine. @internal */
  core?: Omit<CoreIo, "stdout" | "stderr">
  /** Where sign-ins are kept; defaults to the OS keychain. @internal */
  credentials?: CredentialStore
  /** What `qualithm login` and refreshes reach for; defaults to the real machine. @internal */
  login?: Pick<AuthIo, "openBrowser" | "timeoutMs" | "now"> & { lock?: RefreshLock }
}

/** Every command, in the order help lists them. */
export const COMMANDS: readonly Command[] = [
  ...authorityCommands,
  ...automationCommands,
  ...credentialCommands,
  ...deviceCommands,
  ...enrollmentCommands,
  ...scopeCommands,
  ...tokenCommands,
  ...applyCommands
]

const RESOURCE_ALIASES: Readonly<Record<string, string>> = {
  authorities: "authority",
  automations: "automation",
  credentials: "credential",
  devices: "device",
  enrollments: "enrollment",
  scopes: "scope",
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
  qualithm login                        sign in with your browser; the keychain keeps it
  qualithm logout | whoami              sign out, or show the team and role in use
  qualithm <resource> <verb> [flags]
  qualithm apply <manifest.yaml> [flags]
  qualithm mcp                          serve every tool over stdio, for an agent
  qualithm deploy [dir]                 put a MicroPython project on a plugged-in board
  qualithm board <verb> [flags]         a board plugged into this computer (see board --help)
  qualithm core run | status | stop     the local device core (started for you when needed)
  qualithm agents connect | disconnect  add qualithm mcp to Claude and Codex (see agents --help)

Flags, accepted by every verb before or after its arguments:
  --url string     API base URL (env QUALITHM_API_URL)
  --token string   API token, used instead of your sign-in (env QUALITHM_API_TOKEN)
  --team string    team to act on; defaults to the credential's team (env QUALITHM_TEAM)
  --json           print one JSON envelope line instead of a table
  --dry-run        report the planned change without applying it

Resources and verbs:
  authority  list | create | revoke <id>
  automation runs <id>
  credential list | create | cert | rotate | revoke
  device     list | get <id> | state | wait <id> | create | update <id> | delete <id>
  enrollment list | create | revoke <id> | wait <id>
  scope      list | get <id> | create | update <id> | delete <id>
  token      list | revoke <id>
  board      list | flash | reset | logs | console
  apply      <manifest.yaml>            idempotent device-as-code reconcile
  version                               print the CLI version

Examples:
  qualithm login
  qualithm enrollment create --scope scp_defraa_123 --label lab-floor-2
  qualithm enrollment wait enr_defraa_123 --timeout 600
  qualithm device list --json
  qualithm credential create --device dvc_defraa_123 --json
  qualithm credential revoke --device dvc_defraa_123 --credential crd_defraa_123 --dry-run
  qualithm authority create --name fleet --kind byo --cert-file ca.pem --dry-run
  qualithm apply fleet.yaml --dry-run
  qualithm board flash
  qualithm board logs --follow

Exit codes:
  0 ok (incl. dry-run)  1 error  2 usage  3 auth  4 not-found  5 conflict
  6 rate-limited        7 api    8 unavailable  9 timeout
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

type Values = Readonly<Record<string, string | boolean | undefined>>

function pick(io: CliIo, values: Values, flag: string, name: string): string | undefined {
  const env = io.env ?? process.env
  const value = values[flag]
  return typeof value === "string" ? value : env[name] === "" ? undefined : env[name]
}

/** The API origin a sign-in is kept for. */
function apiOrigin(io: CliIo, values: Values): string {
  const baseUrl = pick(io, values, "url", "QUALITHM_API_URL") ?? DEFAULT_BASE_URL
  try {
    return new URL(baseUrl).origin
  } catch {
    throw new CliError(`--url is not a URL: ${baseUrl}`)
  }
}

const stores = new WeakMap<CliIo, CredentialStore>()

function credentialStore(io: CliIo): CredentialStore {
  let store = io.credentials ?? stores.get(io)
  if (store === undefined) {
    store = keychainStore()
    stores.set(io, store)
  }
  return store
}

function loginSource(io: CliIo, values: Values): LoginSource {
  return new LoginSource({
    api: apiOrigin(io, values),
    store: credentialStore(io),
    fetch: io.fetch ?? (async (input, init) => fetch(input, init)),
    lock: io.login?.lock ?? fileLock(),
    ...(io.login?.now === undefined ? {} : { now: io.login.now })
  })
}

function sessionConfig(
  io: CliIo,
  values: Values,
  userAgent: string,
  signInOnly = false
): SessionConfig {
  // A token, from the flag or the environment, takes precedence over the stored sign-in.
  const token = signInOnly ? undefined : pick(io, values, "token", "QUALITHM_API_TOKEN")
  const baseUrl = pick(io, values, "url", "QUALITHM_API_URL")
  const team = pick(io, values, "team", "QUALITHM_TEAM")
  return {
    userAgent,
    ...(token === undefined ? { credential: loginSource(io, values) } : { token }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(team === undefined ? {} : { team }),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch })
  }
}

function authIo(io: CliIo): AuthIo {
  return {
    stdout: io.stdout,
    stderr: io.stderr,
    fetch: io.fetch ?? (async (input, init) => fetch(input, init)),
    store: credentialStore(io),
    api: (values) => apiOrigin(io, values),
    override: (values) =>
      typeof values.token === "string"
        ? "--token"
        : pick(io, values, "token", "QUALITHM_API_TOKEN") === undefined
          ? undefined
          : "QUALITHM_API_TOKEN",
    newSession: (values, signInOnly) =>
      new Session(sessionConfig(io, values, `qualithm/${VERSION}`, signInOnly)),
    ...io.login
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
  return report(io, json, result, () => {
    const text = command.human(result.data, input)
    return "cursor" in command.options ? text + nextPage(result.data) : text
  })
}

async function runMcp(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: COMMON_OPTIONS, strict: false })
  const config = sessionConfig(io, values, `qualithm-mcp/${VERSION}`)
  const newSession: SessionFactory = (dryRun) => new Session({ ...config, dryRun })
  let tools = TOOLS
  let signedIn: boolean
  try {
    signedIn =
      config.token !== undefined ||
      ((await (config.credential as LoginSource | undefined)?.present()) ?? false)
  } catch (error) {
    signedIn = false
    io.stderr(`qualithm: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  if (!signedIn) {
    // Boards need no account: serve their tools alone, so flashing works before signing up.
    tools = TOOLS.filter((tool) => tool.local === true)
    io.stderr(`qualithm: ${NOT_LOGGED_IN}; serving only the board tools\n`)
  }
  const serve = io.serveMcp ?? (async (server) => server.connect(new StdioServerTransport()))
  await serve(buildMcpServer(newSession, VERSION, tools))
  return EXIT_CODES.ok
}

function boardIo(io: CliIo): BoardIo {
  return {
    newSession: (flags) => {
      const config = sessionConfig(io, flags, `qualithm/${VERSION}`)
      return (dryRun) => new Session({ ...config, dryRun })
    },
    ...io.board,
    stdout: io.stdout,
    stderr: io.stderr
  }
}

/** Commands that parse their own arguments. */
const SUBPROGRAMS: Readonly<
  Record<string, ((args: string[], io: CliIo) => Promise<number>) | undefined>
> = {
  mcp: runMcp,
  login: async (args, io) => runAuth("login", args, authIo(io)),
  logout: async (args, io) => runAuth("logout", args, authIo(io)),
  whoami: async (args, io) => runAuth("whoami", args, authIo(io)),
  board: async (args, io) => runBoard(args, boardIo(io)),
  deploy: async (args, io) => runBoard(["deploy", ...args], boardIo(io)),
  agents: async (args, io) =>
    runAgents(args, {
      stdout: io.stdout,
      stderr: io.stderr,
      ...(io.agents === undefined ? {} : { host: io.agents })
    }),
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
