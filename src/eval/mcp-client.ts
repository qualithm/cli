import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import type { ToolCaller } from "./run.ts"

/** A tool call the server refused or failed, as an agent would read it. */
export class EvalToolError extends Error {
  override readonly name = "EvalToolError"
}

/** The parts of a tool result the eval reads. */
export type ToolResult = {
  isError?: boolean
  structuredContent?: unknown
}

type Envelope = { ok?: boolean; code?: string; message?: string; data?: unknown }

/**
 * Unpacks one tool result: the envelope's data, or an error carrying its stable code.
 *
 * @param name - the tool, for the error
 * @param result - the tool result
 * @returns the envelope's data
 * @throws {EvalToolError} when the tool failed or returned no envelope
 */
export function decodeToolResult(name: string, result: ToolResult): unknown {
  const envelope = (result.structuredContent ?? {}) as Envelope
  if (result.isError === true || envelope.ok !== true) {
    if (envelope.code === undefined) {
      throw new EvalToolError(`${name}: tool reported failure without an envelope code`)
    }
    throw new EvalToolError(`${name}: ${envelope.code}: ${envelope.message ?? ""}`)
  }
  return envelope.data
}

/** A connected MCP client: call tools, then close. */
export type McpConnection = { call: ToolCaller; close: () => Promise<void> }

/**
 * Starts `qualithm mcp` and connects to it over stdio, the transport an agent uses. The token and
 * API URL reach the server through its environment.
 *
 * @param command - the program to run, e.g. `node`
 * @param args - its arguments, ending in `mcp`
 * @param env - the server's environment
 * @returns the connection
 */
export async function connectServer(
  command: string,
  args: string[],
  env: Record<string, string>
): Promise<McpConnection> {
  const client = new Client({ name: "agent-eval", version: "1" })
  await client.connect(new StdioClientTransport({ command, args, env, stderr: "inherit" }))
  return {
    call: async (name, toolArgs) =>
      decodeToolResult(name, (await client.callTool({ name, arguments: toolArgs })) as ToolResult),
    close: async () => client.close()
  }
}
