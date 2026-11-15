import {
  type AgentHost,
  type AgentsResult,
  connectAgents,
  defaultAgentHost,
  disconnectAgents
} from "../agents/connect.ts"
import { CliError } from "../envelope.ts"
import { defineTool, dryRunInput, type Tool } from "./tool.ts"

/**
 * Fails the call when any agent failed, keeping every agent's report in the envelope's `data`.
 *
 * @throws {CliError} with code `error` naming each agent that failed
 */
function settle(result: AgentsResult): AgentsResult {
  const failed = result.agents.filter((a) => a.status === "failed" && a.via === undefined)
  if (failed.length > 0) {
    const message = failed.map((a) => a.error ?? `${a.name.toLowerCase()} failed`).join("; ")
    throw new CliError(message, "error", result)
  }
  return result
}

/**
 * The tools that connect this computer's agents to the qualithm MCP server and disconnect them.
 *
 * @param host - the machine the agents live on; this one by default, read when a tool runs
 * @returns `connect_agents` and `disconnect_agents`
 */
export function agentTools(host: () => AgentHost = defaultAgentHost): Tool[] {
  return [
    defineTool({
      name: "connect_agents",
      description:
        "Register qualithm mcp with every agent installed on this computer: Claude desktop, Claude Code, the Codex app and the Codex CLI. Idempotent; reports each agent as not_installed, already_connected or connected. No token is written to any config",
      mutating: true,
      operations: [],
      local: true,
      input: { ...dryRunInput },
      run: async (_session, input) =>
        settle(await connectAgents(host(), { dryRun: input.dryRun === true }))
    }),
    defineTool({
      name: "disconnect_agents",
      description:
        "Remove qualithm mcp from every agent installed on this computer. Reports each agent as not_installed, not_connected or removed",
      mutating: true,
      operations: [],
      local: true,
      input: { ...dryRunInput },
      run: async (_session, input) =>
        settle(await disconnectAgents(host(), { dryRun: input.dryRun === true }))
    })
  ]
}
