import { listApiTokens, revokeApiToken } from "./tokens.ts"
import type { Tool } from "./tool.ts"

/** Every tool, in the order `qualithm mcp` lists them. Each must be added here to be served. */
export const TOOLS: readonly Tool[] = [listApiTokens, revokeApiToken]
