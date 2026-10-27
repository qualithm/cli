import { createAuthority, listAuthorities, revokeAuthority } from "./authorities.ts"
import {
  issueCert,
  listCredentials,
  mintCredential,
  revokeCredential,
  rotateCredential
} from "./credentials.ts"
import { createDevice, deleteDevice, getDevice, listDevices, updateDevice } from "./devices.ts"
import { createEnrollment, listEnrollments, revokeEnrollment } from "./enrollments.ts"
import { createSpace, deleteSpace, getSpace, listSpaces, updateSpace } from "./spaces.ts"
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
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
  listEnrollments,
  createEnrollment,
  revokeEnrollment,
  listSpaces,
  getSpace,
  createSpace,
  updateSpace,
  deleteSpace,
  listApiTokens,
  revokeApiToken
]
