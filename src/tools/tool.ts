import { z } from "zod"

import type { Session } from "../platform.ts"

/** The input every mutating tool takes, so an agent can plan a change before making it. */
export const dryRunInput = {
  dryRun: z.boolean().optional().describe("plan the mutation without applying it")
}

/** The paging input every list tool takes. */
export const pageInput = {
  page: z.number().int().positive().optional().describe("1-based page number"),
  limit: z.number().int().min(1).max(100).optional().describe("items per page, at most 100")
}

/**
 * One platform operation, shared by the MCP tool and the CLI command that expose it, so the two
 * surfaces never diverge.
 */
export type Tool<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  /** The MCP tool name, in `snake_case`. */
  name: string
  /** What the tool does, for the agent choosing it. */
  description: string
  /** Whether it changes state; a mutating tool's input carries `dryRun`. */
  mutating: boolean
  /** True for a tool that acts on this computer, such as a plugged-in board, not the platform. */
  local?: boolean
  /** The input fields. */
  input: Shape
  /**
   * Performs the operation.
   *
   * @param session - the platform connection, already in dry-run mode when asked
   * @param input - the validated input
   * @returns the API's payload, or `undefined` for an operation with none
   */
  run: (session: Session, input: z.infer<z.ZodObject<Shape>>) => Promise<unknown>
}

/**
 * Declares a tool, checking its handler against its input, and widens it so every tool fits one
 * list. `callTool` parses input with the tool's own schema before `run` sees it.
 *
 * @param tool - the tool
 * @returns the same tool
 */
export function defineTool<Shape extends z.ZodRawShape>(tool: Tool<Shape>): Tool {
  return tool as unknown as Tool
}
