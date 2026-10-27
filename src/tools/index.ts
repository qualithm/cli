import { createAuthority, listAuthorities, revokeAuthority } from "./authorities.ts"
import {
  issueCert,
  listCredentials,
  mintCredential,
  revokeCredential,
  rotateCredential
} from "./credentials.ts"
import { createEnrollment, listEnrollments, revokeEnrollment } from "./enrollments.ts"
import { listApiTokens, revokeApiToken } from "./tokens.ts"
import type { Tool } from "./tool.ts"

/** Every tool, in the order `qualithm mcp` lists them. Each must be added here to be served. */
export const TOOLS: readonly Tool[] = [
  listAuthorities,
  createAuthority,
  revokeAuthority,
  listCredentials,
  mintCredential,
  issueCert,
  rotateCredential,
  revokeCredential,
  listEnrollments,
  createEnrollment,
  revokeEnrollment,
  listApiTokens,
  revokeApiToken
]
