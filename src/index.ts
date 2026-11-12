/**
 * The Qualithm CLI and MCP server, for embedding: run a command, or build the MCP server.
 *
 * @packageDocumentation
 */

export type {
  AgentHost,
  AgentId,
  AgentReport,
  AgentsResult,
  AgentStatus,
  ExecResult,
  ServerEntry
} from "./agents/connect.ts"
export type { CliIo } from "./cli.ts"
export { COMMANDS, run, USAGE } from "./cli.ts"
export type {
  Command,
  OptionSpec,
  ParsedArgs,
  RefusedCommand,
  ToolCommand
} from "./commands/command.ts"
export type { ErrorCode, PlannedAction, Result } from "./envelope.ts"
export {
  CliError,
  codeForStatus,
  DryRunError,
  EXIT_CODES,
  exitCode,
  failure,
  success
} from "./envelope.ts"
export type { SessionFactory } from "./mcp.ts"
export { buildMcpServer, callTool, toCallToolResult } from "./mcp.ts"
export type { FetchAPI, SessionConfig } from "./platform.ts"
export { Session, sessionFetch } from "./platform.ts"
export { TOOLS } from "./tools/index.ts"
export type { Tool } from "./tools/tool.ts"
export { VERSION } from "./version.ts"
