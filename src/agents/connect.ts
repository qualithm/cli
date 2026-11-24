import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

/** The name every agent knows the qualithm MCP server by. */
export const SERVER_NAME = "qualithm"

/** The agents `qualithm agents connect` registers with, in the order it reports them. */
export type AgentId =
  | "claude-desktop"
  | "claude-code"
  | "codex-app"
  | "codex-cli"
  | "vscode"
  | "cursor"

/** How an agent starts the qualithm MCP server. */
export type ServerEntry = {
  command: string
  args: string[]
  /** The names of any environment variables the entry sets; values are never reported. */
  env?: string[]
}

/** What happened, or would happen, to one agent. */
export type AgentStatus =
  | "not_installed"
  | "already_connected"
  | "connected"
  | "would_connect"
  | "not_connected"
  | "removed"
  | "would_remove"
  | "failed"

/** One agent's line in the result. */
export type AgentReport = {
  agent: AgentId
  /** The agent's name, for a person. */
  name: string
  status: AgentStatus
  /** The file that holds the agent's MCP servers. */
  config?: string
  /** The `qualithm` entry before the change; `null` when there was none. */
  before?: ServerEntry | null
  /** The `qualithm` entry after the change; `null` once removed. */
  after?: ServerEntry | null
  /** The agent CLI invocations run, or that would run on a dry run. */
  commands?: string[][]
  /** Set when another agent's registration covers this one, as the Codex CLI covers the app. */
  via?: AgentId
  /** What failed, when `status` is `failed`. */
  error?: string
}

/** What `connect` and `disconnect` return. */
export type AgentsResult = {
  /** The entry each agent gets, named `qualithm`. */
  server: { name: string; command: string; args: string[] }
  agents: AgentReport[]
}

/** What an agent CLI printed and how it exited. */
export type ExecResult = { code: number; stdout: string; stderr: string }

/** The machine the agents live on; tests pass a temporary home and fake executables. */
export type AgentHost = {
  platform: NodeJS.Platform
  /** The home directory the agents' configs live under. */
  home: string
  /** Environment variables: `PATH`, `APPDATA`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`. */
  env: Readonly<Record<string, string | undefined>>
  /** Folders searched for macOS app bundles. */
  applications: readonly string[]
  /** How the agents start the qualithm MCP server. */
  server: { command: string; args: string[] }
  /** Runs an agent CLI. */
  exec: (file: string, args: readonly string[]) => Promise<ExecResult>
}

/**
 * The command that starts this qualithm binary's MCP server, by absolute path so an agent needs
 * no `PATH`. A script run by Node or Bun names the runtime too, since a desktop app's `PATH` may
 * not reach it.
 *
 * @param execPath - the running executable, `process.execPath`
 * @param script - the script it runs, `process.argv[1]`
 * @returns the command and arguments
 */
export function qualithmServer(
  execPath: string,
  script: string | undefined
): { command: string; args: string[] } {
  const runtime = /^(node|bun)(\.exe)?$/i.test(basename(execPath))
  return runtime && script !== undefined && script !== ""
    ? { command: execPath, args: [resolve(script), "mcp"] }
    : { command: execPath, args: ["mcp"] }
}

/**
 * Runs a program and collects what it printed, never throwing: a spawn failure exits 1.
 *
 * @param platform - the OS, since Windows runs `.cmd` shims through a shell
 * @returns the runner
 */
export function execRunner(platform: NodeJS.Platform): AgentHost["exec"] {
  return async (file, args) =>
    new Promise((done) => {
      execFile(
        file,
        [...args],
        { timeout: 60_000, windowsHide: true, shell: platform === "win32" },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1
          done({ code, stdout, stderr: stderr === "" ? (error?.message ?? "") : stderr })
        }
      )
    })
}

/**
 * This machine, as the running qualithm binary sees it.
 *
 * @returns the host
 */
export function defaultAgentHost(): AgentHost {
  const home = homedir()
  return {
    platform: process.platform,
    home,
    env: process.env,
    applications: ["/Applications", join(home, "Applications")],
    server: qualithmServer(process.execPath, process.argv[1]),
    exec: execRunner(process.platform)
  }
}

const NAMES: Readonly<Record<AgentId, string>> = {
  "claude-desktop": "Claude desktop",
  "claude-code": "Claude Code",
  "codex-app": "Codex app",
  "codex-cli": "Codex CLI",
  vscode: "VS Code",
  cursor: "Cursor"
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Finds an executable on the host's `PATH`. */
function which(host: AgentHost, name: string): string | undefined {
  const win = host.platform === "win32"
  const exts = win ? (host.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (host.env.PATH ?? "").split(win ? ";" : ":")) {
    for (const ext of exts) {
      const path = join(dir, name + ext.toLowerCase())
      if (dir !== "" && isFile(path)) {
        return path
      }
    }
  }
  return undefined
}

function appInstalled(host: AgentHost, bundle: string): boolean {
  return (
    host.platform === "darwin" && host.applications.some((dir) => existsSync(join(dir, bundle)))
  )
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

function sameEntry(entry: ServerEntry | null, server: AgentsResult["server"]): boolean {
  return (
    entry !== null &&
    entry.command === server.command &&
    entry.args.length === server.args.length &&
    entry.args.every((arg, i) => arg === server.args[i]) &&
    (entry.env === undefined || entry.env.length === 0)
  )
}

/** Reads an MCP server entry from JSON config, reporting env names only. */
function jsonEntry(value: unknown): ServerEntry {
  if (typeof value !== "object" || value === null) {
    return { command: "", args: [] }
  }
  const { command, args, env } = value as { command?: unknown; args?: unknown; env?: unknown }
  const names = typeof env === "object" && env !== null ? Object.keys(env) : []
  return {
    command: typeof command === "string" ? command : "",
    args: Array.isArray(args) ? args.map(String) : [],
    ...(names.length === 0 ? {} : { env: names })
  }
}

type Change = { before: ServerEntry | null; after: ServerEntry | null }

/** The status for a change, or for none. */
function settled(
  target: ServerEntry | null,
  before: ServerEntry | null,
  dryRun: boolean
): AgentStatus {
  if (target === null) {
    return before === null ? "not_connected" : dryRun ? "would_remove" : "removed"
  }
  return dryRun ? "would_connect" : "connected"
}

// Claude desktop, VS Code and Cursor: a JSON file of MCP servers, edited in place.

type JsonAgent = {
  agent: "claude-desktop" | "vscode" | "cursor"
  /** The folder whose presence means the agent is installed. */
  dir: (host: AgentHost) => string
  /** The file that holds the agent's MCP servers. */
  config: (host: AgentHost) => string
  /** The key the servers sit under. */
  key: "mcpServers" | "servers"
  /** Fields the agent wants on each entry besides `command` and `args`. */
  extra: Readonly<Record<string, string>>
  /** A macOS app bundle that also means the agent is installed. */
  bundle: string
  /** A launcher on `PATH` that also means the agent is installed. */
  bin?: string
}

/** The per-user settings folder an Electron app keeps under its name. */
function appSupportDir(host: AgentHost, name: string): string {
  if (host.platform === "darwin") {
    return join(host.home, "Library", "Application Support", name)
  }
  if (host.platform === "win32") {
    return join(host.env.APPDATA ?? join(host.home, "AppData", "Roaming"), name)
  }
  return join(host.env.XDG_CONFIG_HOME ?? join(host.home, ".config"), name)
}

const CLAUDE_DESKTOP: JsonAgent = {
  agent: "claude-desktop",
  dir: (host) => appSupportDir(host, "Claude"),
  config: (host) => join(appSupportDir(host, "Claude"), "claude_desktop_config.json"),
  key: "mcpServers",
  extra: {},
  bundle: "Claude.app"
}

const VSCODE: JsonAgent = {
  agent: "vscode",
  dir: (host) => join(appSupportDir(host, "Code"), "User"),
  config: (host) => join(appSupportDir(host, "Code"), "User", "mcp.json"),
  key: "servers",
  extra: { type: "stdio" },
  bundle: "Visual Studio Code.app",
  bin: "code"
}

const CURSOR: JsonAgent = {
  agent: "cursor",
  dir: (host) => join(host.home, ".cursor"),
  config: (host) => join(host.home, ".cursor", "mcp.json"),
  key: "mcpServers",
  extra: {},
  bundle: "Cursor.app",
  bin: "cursor"
}

function jsonInstalled(host: AgentHost, spec: JsonAgent): boolean {
  return (
    existsSync(spec.dir(host)) ||
    appInstalled(host, spec.bundle) ||
    (spec.bin !== undefined && which(host, spec.bin) !== undefined)
  )
}

/** The agent's config as an object, `{}` when there is none, or undefined when it can't be read. */
function readJsonConfig(
  config: string,
  key: JsonAgent["key"]
): Record<string, unknown> | undefined {
  if (!existsSync(config)) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(config, "utf8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const servers = (parsed as Record<string, unknown>)[key]
  return servers === undefined || (typeof servers === "object" && servers !== null)
    ? (parsed as Record<string, unknown>)
    : undefined
}

function jsonAgent(
  host: AgentHost,
  spec: JsonAgent,
  target: ServerEntry | null,
  server: AgentsResult["server"],
  dryRun: boolean
): AgentReport {
  const config = spec.config(host)
  const base = { agent: spec.agent, name: NAMES[spec.agent] }
  if (!jsonInstalled(host, spec)) {
    return { ...base, status: "not_installed" }
  }
  const doc = readJsonConfig(config, spec.key)
  if (doc === undefined) {
    return {
      ...base,
      status: "failed",
      config,
      error: `${NAMES[spec.agent].toLowerCase()} config ${config} isn't valid JSON, so it was left alone: fix or remove it, then run this again`
    }
  }
  const servers = (doc[spec.key] as Record<string, unknown> | undefined) ?? {}
  const before = SERVER_NAME in servers ? jsonEntry(servers[SERVER_NAME]) : null
  if (target !== null && sameEntry(before, server)) {
    return { ...base, status: "already_connected", config, before, after: before }
  }
  if (target === null && before === null) {
    return { ...base, status: "not_connected", config, before: null, after: null }
  }
  if (!dryRun) {
    const others = Object.fromEntries(Object.entries(servers).filter(([k]) => k !== SERVER_NAME))
    const entries =
      target === null
        ? others
        : {
            ...others,
            [SERVER_NAME]: { ...spec.extra, command: target.command, args: target.args }
          }
    writeAtomic(config, `${JSON.stringify({ ...doc, [spec.key]: entries }, null, 2)}\n`)
  }
  return { ...base, status: settled(target, before, dryRun), config, before, after: target }
}

// Claude Code and the Codex CLI: registered through their own CLIs.

type CliAgent = {
  agent: "claude-code" | "codex-cli"
  bin: string
  config: (host: AgentHost) => string
  read: (config: string) => ServerEntry | null
  add: (target: ServerEntry) => string[]
  remove: string[]
}

function claudeCodeEntry(config: string): ServerEntry | null {
  try {
    const doc = JSON.parse(readFileSync(config, "utf8")) as { mcpServers?: Record<string, unknown> }
    const value = doc.mcpServers?.[SERVER_NAME]
    return value === undefined ? null : jsonEntry(value)
  } catch {
    return null
  }
}

const CLAUDE_CODE: CliAgent = {
  agent: "claude-code",
  bin: "claude",
  config: (host) => join(host.env.CLAUDE_CONFIG_DIR ?? host.home, ".claude.json"),
  read: claudeCodeEntry,
  add: (t) => ["mcp", "add", "--scope", "user", SERVER_NAME, "--", t.command, ...t.args],
  remove: ["mcp", "remove", "--scope", "user", SERVER_NAME]
}

function codexHome(host: AgentHost): string {
  return host.env.CODEX_HOME ?? join(host.home, ".codex")
}

const CODEX_CLI: CliAgent = {
  agent: "codex-cli",
  bin: "codex",
  config: (host) => join(codexHome(host), "config.toml"),
  read: (config) => (existsSync(config) ? tomlEntry(readFileSync(config, "utf8")) : null),
  add: (t) => ["mcp", "add", SERVER_NAME, "--", t.command, ...t.args],
  remove: ["mcp", "remove", SERVER_NAME]
}

async function cliAgent(
  host: AgentHost,
  spec: CliAgent,
  target: ServerEntry | null,
  server: AgentsResult["server"],
  dryRun: boolean
): Promise<AgentReport> {
  const base = { agent: spec.agent, name: NAMES[spec.agent] }
  const bin = which(host, spec.bin)
  if (bin === undefined) {
    return { ...base, status: "not_installed" }
  }
  const config = spec.config(host)
  const before = spec.read(config)
  if (target !== null && sameEntry(before, server)) {
    return { ...base, status: "already_connected", config, before, after: before }
  }
  if (target === null && before === null) {
    return { ...base, status: "not_connected", config, before: null, after: null }
  }
  const runs = [
    ...(before === null ? [] : [spec.remove]),
    ...(target === null ? [] : [spec.add(target)])
  ]
  const commands = runs.map((args) => [spec.bin, ...args])
  const change: Change = { before, after: target }
  if (!dryRun) {
    for (const args of runs) {
      const { code, stderr, stdout } = await host.exec(bin, args)
      if (code !== 0) {
        const said = (stderr.trim() || stdout.trim()).split("\n")[0] ?? ""
        return {
          ...base,
          status: "failed",
          config,
          ...change,
          after: before,
          commands,
          error: `${spec.bin} ${args.slice(0, 2).join(" ")} exited ${String(code)}${said === "" ? "" : `: ${said}`}`
        }
      }
    }
  }
  return { ...base, status: settled(target, before, dryRun), config, ...change, commands }
}

// The Codex app without the CLI: a minimal edit of config.toml's [mcp_servers.qualithm] table.

const HEADER = /^\s*\[/
const OUR_TABLE =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:qualithm|"qualithm"|'qualithm')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/

function tomlString(text: string): string | undefined {
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(text)
  if (basic !== null) {
    try {
      return JSON.parse(`"${basic[1] ?? ""}"`) as string
    } catch {
      return undefined
    }
  }
  return /^'([^']*)'/.exec(text)?.[1]
}

/** A one-line TOML array of strings, or undefined for any other value. */
function tomlArray(text: string): string[] | undefined {
  const list = /^\[(.*)\]\s*(?:#.*)?$/.exec(text)
  return list === null
    ? undefined
    : [...(list[1] ?? "").matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map((m) => tomlString(m[0]) ?? "")
}

/**
 * Reads the `[mcp_servers.qualithm]` table from Codex's config.toml. An entry it can't read
 * comes back with an empty command, so a connect rewrites it.
 */
function tomlEntry(text: string): ServerEntry | null {
  let found = false
  let inTable = false
  let command: string | undefined
  let args: string[] | undefined
  const env: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (HEADER.test(line)) {
      inTable = OUR_TABLE.test(line)
      found ||= inTable
      if (inTable && /\.\s*env\s*\]/.test(line)) {
        env.push("env")
      }
      continue
    }
    if (!inTable) {
      continue
    }
    const [, key, value = ""] = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line) ?? []
    if (key === "command") {
      command = tomlString(value)
    } else if (key === "args") {
      args = tomlArray(value)
    } else if (key === "env") {
      env.push("env")
    }
  }
  if (!found) {
    return null
  }
  return { command: command ?? "", args: args ?? [], ...(env.length === 0 ? {} : { env }) }
}

/** Codex's config.toml with the qualithm table replaced, or dropped when `target` is null. */
function withTomlEntry(text: string, target: ServerEntry | null): string {
  const kept: string[] = []
  let inTable = false
  for (const line of text.split(/\r?\n/)) {
    if (HEADER.test(line)) {
      inTable = OUR_TABLE.test(line)
    }
    if (!inTable) {
      kept.push(line)
    }
  }
  let out = kept.join("\n").replace(/\n+$/, "")
  if (target !== null) {
    const args = target.args.map((arg) => JSON.stringify(arg)).join(", ")
    const table = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(target.command)}\nargs = [${args}]`
    out = out === "" ? table : `${out}\n\n${table}`
  }
  return out === "" ? "" : `${out}\n`
}

function codexApp(
  host: AgentHost,
  cli: AgentReport,
  target: ServerEntry | null,
  server: AgentsResult["server"],
  dryRun: boolean
): AgentReport {
  const base = { agent: "codex-app" as const, name: NAMES["codex-app"] }
  if (!appInstalled(host, "Codex.app")) {
    return { ...base, status: "not_installed" }
  }
  if (cli.status !== "not_installed") {
    const { status, config, before, after, error } = cli
    return {
      ...base,
      status,
      config,
      before,
      after,
      via: "codex-cli",
      ...(error === undefined ? {} : { error })
    }
  }
  const config = join(codexHome(host), "config.toml")
  const text = existsSync(config) ? readFileSync(config, "utf8") : ""
  const before = tomlEntry(text)
  if (target !== null && sameEntry(before, server)) {
    return { ...base, status: "already_connected", config, before, after: before }
  }
  if (target === null && before === null) {
    return { ...base, status: "not_connected", config, before: null, after: null }
  }
  if (!dryRun) {
    writeAtomic(config, withTomlEntry(text, target))
  }
  return { ...base, status: settled(target, before, dryRun), config, before, after: target }
}

/** Runs one agent's step, so a file it can't read or write fails that agent alone. */
async function guard(
  agent: AgentId,
  step: () => AgentReport | Promise<AgentReport>
): Promise<AgentReport> {
  try {
    return await step()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      agent,
      name: NAMES[agent],
      status: "failed",
      error: `${NAMES[agent].toLowerCase()}: ${reason}`
    }
  }
}

async function apply(host: AgentHost, connect: boolean, dryRun: boolean): Promise<AgentsResult> {
  const server = { name: SERVER_NAME, ...host.server }
  const target = connect ? { command: server.command, args: [...server.args] } : null
  const desktop = await guard("claude-desktop", () =>
    jsonAgent(host, CLAUDE_DESKTOP, target, server, dryRun)
  )
  const code = await guard("claude-code", async () =>
    cliAgent(host, CLAUDE_CODE, target, server, dryRun)
  )
  const codex = await guard("codex-cli", async () =>
    cliAgent(host, CODEX_CLI, target, server, dryRun)
  )
  const app = await guard("codex-app", () => codexApp(host, codex, target, server, dryRun))
  const vscode = await guard("vscode", () => jsonAgent(host, VSCODE, target, server, dryRun))
  const cursor = await guard("cursor", () => jsonAgent(host, CURSOR, target, server, dryRun))
  return { server, agents: [desktop, code, app, codex, vscode, cursor] }
}

/**
 * Registers the qualithm MCP server with every supported agent installed on the host. Running it
 * again changes nothing; an entry that starts a different qualithm is updated.
 *
 * @param host - the machine
 * @param options - `dryRun` reports the changes without making them
 * @returns one report per agent; a failed agent never stops the others
 */
export async function connectAgents(
  host: AgentHost,
  options: { dryRun: boolean }
): Promise<AgentsResult> {
  return apply(host, true, options.dryRun)
}

/**
 * Removes the qualithm MCP server from every supported agent installed on the host.
 *
 * @param host - the machine
 * @param options - `dryRun` reports the changes without making them
 * @returns one report per agent; a failed agent never stops the others
 */
export async function disconnectAgents(
  host: AgentHost,
  options: { dryRun: boolean }
): Promise<AgentsResult> {
  return apply(host, false, options.dryRun)
}
