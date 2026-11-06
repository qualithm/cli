import { socketClient } from "../core/client.ts"
import { createAuthority, listAuthorities, revokeAuthority } from "./authorities.ts"
import { automationTools } from "./automations.ts"
import { billingTools } from "./billing.ts"
import { boardTools } from "./boards.ts"
import {
  createCredential,
  issueCert,
  listCredentials,
  revokeCredential,
  rotateCredential
} from "./credentials.ts"
import { dashboardTools } from "./dashboards.ts"
import { deviceCommandTools } from "./device-commands.ts"
import { createDevice, deleteDevice, getDevice, listDevices, updateDevice } from "./devices.ts"
import { createEnrollment, listEnrollments, revokeEnrollment } from "./enrollments.ts"
import { memberTools } from "./members.ts"
import { observabilityTools } from "./observability.ts"
import { createScope, deleteScope, getScope, listScopes, updateScope } from "./scopes.ts"
import { teamTools } from "./teams.ts"
import { listApiTokens, revokeApiToken } from "./tokens.ts"
import type { Tool } from "./tool.ts"
import { workspaceTools } from "./workspace.ts"

/**
 * Every tool, in the order `qualithm mcp` lists them. Each must be added here, or to its group's
 * list, to be served.
 */
export const TOOLS: readonly Tool[] = [
  listAuthorities,
  createAuthority,
  revokeAuthority,
  listCredentials,
  createCredential,
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
  listScopes,
  getScope,
  createScope,
  updateScope,
  deleteScope,
  listApiTokens,
  revokeApiToken,
  ...teamTools,
  ...memberTools,
  ...dashboardTools,
  ...deviceCommandTools,
  ...observabilityTools,
  ...workspaceTools,
  ...automationTools,
  ...billingTools,
  ...boardTools(socketClient())
]
