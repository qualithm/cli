import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import { CliError, failure, type Result, success } from "./envelope.ts"
import type { Session } from "./platform.ts"
import { TOOLS } from "./tools/index.ts"
import type { Tool } from "./tools/tool.ts"

/** Builds the platform session one call runs on. */
export type SessionFactory = (dryRun: boolean) => Session

/** What a local tool gets in place of a session; touching it is a bug in the tool. */
const NO_SESSION = new Proxy(
  {},
  {
    get: () => {
      throw new CliError("a local tool reached for the platform session", "error")
    }
  }
) as Session

/**
 * Runs one tool: validates its input, opens a session (in dry-run mode when asked) unless the
 * tool is local, and returns the envelope. Never throws.
 *
 * @param tool - the tool
 * @param newSession - builds the session
 * @param args - the raw input
 * @returns the envelope
 */
export async function callTool(
  tool: Tool,
  newSession: SessionFactory,
  args: unknown
): Promise<Result> {
  const parsed = z.object(tool.input).safeParse(args ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue?.path.join(".") ?? ""
    const detail = (issue?.message ?? "invalid input").toLowerCase()
    return failure(new CliError(field === "" ? detail : `${field}: ${detail}`))
  }
  const input = parsed.data as Record<string, unknown>
  const dryRun = tool.mutating && input.dryRun === true
  try {
    const session = tool.local === true ? NO_SESSION : newSession(dryRun)
    const data = await tool.run(session, input)
    // A tool that plans several changes reports them as data; mark the envelope a dry run too.
    return dryRun ? { ...success(data), dryRun: true } : success(data)
  } catch (error) {
    return failure(error)
  }
}

/**
 * The MCP result for an envelope: the envelope as structured content and as text, flagged as an
 * error when it failed.
 *
 * @param result - the envelope
 * @returns the tool result
 */
export function toCallToolResult(result: Result): CallToolResult {
  const text = result.ok
    ? JSON.stringify(result)
    : `${result.code ?? "error"}: ${result.message ?? "request failed"}`
  return {
    content: [{ type: "text", text }],
    structuredContent: result,
    ...(result.ok ? {} : { isError: true })
  }
}

/**
 * Builds the MCP server with every tool registered.
 *
 * @param newSession - builds the session each call runs on
 * @param version - the server's version
 * @param tools - the tools to serve; defaults to all of them
 * @returns the server, not yet connected
 */
export function buildMcpServer(
  newSession: SessionFactory,
  version: string,
  tools: readonly Tool[] = TOOLS
): McpServer {
  const server = new McpServer(
    { name: "qualithm", title: "Qualithm", version },
    { capabilities: { tools: { listChanged: false } } }
  )
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: unknown) => toCallToolResult(await callTool(tool, newSession, args))
    )
  }
  return server
}
