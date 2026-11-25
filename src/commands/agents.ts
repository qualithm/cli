import { parseArgs } from "node:util"

import type {
  AgentHost,
  AgentReport,
  AgentsResult,
  AgentStatus,
  ServerEntry
} from "../agents/connect.ts"
import { CliError, EXIT_CODES, exitCode, type Result } from "../envelope.ts"
import { callTool } from "../mcp.ts"
import { table } from "../table.ts"
import { agentTools } from "../tools/agents.ts"

/** Where `qualithm agents` writes and which machine it acts on; tests pass their own. */
export type AgentsIo = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** The machine the agents live on; this one by default. */
  host?: AgentHost
}

export const AGENTS_USAGE = `Usage:
  qualithm agents connect      register qualithm mcp with every agent on this computer
  qualithm agents disconnect   remove it again

Connects Claude desktop, Claude Code, the Codex app, the Codex CLI, VS Code (Copilot) and Cursor,
where installed. Running connect again changes nothing. No token is written to any config.

Flags:
  --json      print one JSON envelope line
  --dry-run   show the config changes without making them
`

const OPTIONS = {
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" }
} as const

const TOOL_NAMES: Readonly<Record<string, string | undefined>> = {
  connect: "connect_agents",
  disconnect: "disconnect_agents"
}

const CHANGES: ReadonlySet<AgentStatus> = new Set([
  "connected",
  "would_connect",
  "removed",
  "would_remove"
])

function entry(value: ServerEntry | null | undefined): string {
  return value === null || value === undefined ? "none" : [value.command, ...value.args].join(" ")
}

function changeLines(agent: AgentReport): string[] {
  if (agent.via !== undefined || !CHANGES.has(agent.status)) {
    return []
  }
  const lines = (agent.commands ?? []).map((command) => `  run   ${command.join(" ")}`)
  if (lines.length === 0 && agent.config !== undefined) {
    lines.push(`  edit  ${agent.config}`)
  }
  const { before } = agent
  if (before !== null && before !== undefined) {
    const env = before.env === undefined ? "" : ` (env ${before.env.join(", ")})`
    lines.push(`  was   ${entry(before)}${env}`)
  }
  if (agent.after !== null && agent.after !== undefined) {
    lines.push(`  now   ${entry(agent.after)}`)
  }
  return lines
}

function human(result: AgentsResult): string {
  const rows = result.agents.map((a) => [
    a.name,
    a.status.replaceAll("_", " "),
    a.via === undefined ? "" : "through the Codex CLI"
  ])
  const lines = table([["AGENT", "STATUS", ""], ...rows]).replace(/ +\n/g, "\n")
  const changes = result.agents.flatMap((a) => {
    const detail = changeLines(a)
    return detail.length === 0 ? [] : [`${a.name}:`, ...detail]
  })
  const changed = result.agents.some((a) => a.status === "connected" || a.status === "removed")
  const restart = changed ? ["restart a running agent to load the change"] : []
  const none = result.agents.every((a) => a.status === "not_installed")
    ? ["no supported agent found on this computer: install one, then run this again"]
    : []
  return `${[lines.trimEnd(), ...changes, ...none, ...restart].join("\n")}\n`
}

function print(io: AgentsIo, json: boolean, result: Result): number {
  if (json) {
    io.stdout(`${JSON.stringify(result)}\n`)
    return exitCode(result)
  }
  if (result.data !== undefined) {
    io.stdout(human(result.data as AgentsResult))
  }
  if (!result.ok) {
    io.stderr(`qualithm: ${result.message ?? "agents request failed"}\n`)
  }
  return exitCode(result)
}

/**
 * The session factory for the agent tools, which never reach the platform.
 *
 * @throws {CliError} always
 */
export function noPlatform(): never {
  throw new CliError("connecting agents never reaches the platform", "error")
}

/**
 * Runs `qualithm agents <verb>`. Never throws: every failure becomes an exit code and a message.
 *
 * @param args - the arguments after `agents`
 * @param io - where output goes and which machine to act on
 * @returns the exit code
 */
export async function runAgents(args: readonly string[], io: AgentsIo): Promise<number> {
  let values: { json?: boolean; "dry-run"?: boolean; help?: boolean }
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
    io.stdout(AGENTS_USAGE)
    return EXIT_CODES.ok
  }
  const { host } = io
  const name = verb === undefined ? undefined : TOOL_NAMES[verb]
  const tool = agentTools(host === undefined ? undefined : () => host).find((t) => t.name === name)
  if (verb === undefined || tool === undefined || positionals.length > 1) {
    const what =
      verb === undefined
        ? "agents needs a verb"
        : `unknown command "agents ${positionals.join(" ")}"`
    io.stderr(`qualithm: ${what}\n\n${AGENTS_USAGE}`)
    return EXIT_CODES.usage
  }
  const result = await callTool(tool, noPlatform, { dryRun: values["dry-run"] === true })
  return print(io, values.json === true, result)
}
