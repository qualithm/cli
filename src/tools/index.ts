import { createAuthority, listAuthorities, revokeAuthority } from "./authorities.ts"
import { createEnrollment, listEnrollments, revokeEnrollment } from "./enrollments.ts"
import { listApiTokens, revokeApiToken } from "./tokens.ts"
import type { Tool } from "./tool.ts"

/** Every tool, in the order `qualithm mcp` lists them. Each must be added here to be served. */
export const TOOLS: readonly Tool[] = [
  listAuthorities,
  createAuthority,
  revokeAuthority,
  listEnrollments,
  createEnrollment,
  revokeEnrollment,
  listApiTokens,
  revokeApiToken
]
