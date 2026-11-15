import {
  AccountApi,
  CapabilitiesApi,
  ListCapabilitiesTypeEnum,
  RolesApi,
  SessionsApi,
  ZonesApi
} from "@qualithm/platform"
import { z } from "zod"

import { defineTool, pageInput, type Tool } from "./tool.ts"

const capabilityTypes = Object.values(ListCapabilitiesTypeEnum) as [
  ListCapabilitiesTypeEnum,
  ...ListCapabilitiesTypeEnum[]
]

/** Reads the caller's account. */
export const getAccount = defineTool({
  name: "get_account",
  description: "Read the caller's account.",
  mutating: false,
  operations: ["getAccount"],
  input: {},
  run: async (session) => {
    const { data } = await session.client.api(AccountApi).getAccount()
    return data
  }
})

/** Lists device capabilities across the team. */
export const listCapabilities = defineTool({
  name: "list_capabilities",
  description:
    "List device capabilities across the team, optionally filtered by type, tag, or key.",
  mutating: false,
  operations: ["listCapabilities"],
  input: {
    ...pageInput,
    type: z
      .enum(capabilityTypes)
      .optional()
      .describe("filter by capability type: onoff, range, enum, trigger, or sensor"),
    tag: z.string().min(1).optional().describe("filter by capability tag"),
    key: z.string().min(1).optional().describe("filter by capability key")
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(CapabilitiesApi)
      .listCapabilities({ teamId, ...input })
    return data
  }
})

/** Lists the caller's team role assignments. */
export const listRoles = defineTool({
  name: "list_roles",
  description: "List the caller's team role assignments.",
  mutating: false,
  operations: ["listRoles"],
  input: { ...pageInput },
  run: async (session, input) => {
    const { data } = await session.client.api(RolesApi).listRoles(input)
    return data
  }
})

/** Lists the caller's authenticated sessions. */
export const listSessions = defineTool({
  name: "list_sessions",
  description: "List the caller's authenticated sessions.",
  mutating: false,
  operations: ["listSessions"],
  input: {
    ...pageInput,
    thisDeviceOnly: z.boolean().optional().describe("list only the session the token belongs to")
  },
  run: async (session, input) => {
    const { thisDeviceOnly, ...page } = input
    const { data } = await session.client
      .api(SessionsApi)
      .listSessions({ ...page, ...(thisDeviceOnly === true ? { thisDevice: "true" } : {}) })
    return data
  }
})

/** Fetches one session. */
export const getSession = defineTool({
  name: "get_session",
  description: "Fetch a single session by id.",
  mutating: false,
  operations: ["getSession"],
  input: { sessionId: z.string().min(1).describe("id of the session to fetch") },
  run: async (session, input) => {
    const { data } = await session.client
      .api(SessionsApi)
      .getSession({ sessionId: input.sessionId })
    return data
  }
})

/** Reads the caller's notification preferences. */
export const getCommunicationPreferences = defineTool({
  name: "get_communication_preferences",
  description: "Read the caller's email/push notification preferences.",
  mutating: false,
  operations: ["getCommunicationPreferences"],
  input: {},
  run: async (session) => {
    const { data } = await session.client.api(AccountApi).getCommunicationPreferences()
    return data
  }
})

/** Lists the environment's device zones. */
export const listZones = defineTool({
  name: "list_zones",
  description:
    "List the environment's device zones, open zones first. Only an open zone accepts create_scope.",
  mutating: false,
  operations: ["listZones"],
  input: {},
  run: async (session) => {
    const { data } = await session.client.api(ZonesApi).listZones()
    return data
  }
})

/** Workspace tools: account, sessions, roles, capabilities and zones. */
export const workspaceTools: readonly Tool[] = [
  getAccount,
  listCapabilities,
  listRoles,
  listSessions,
  getSession,
  getCommunicationPreferences,
  listZones
]
