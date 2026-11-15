import { ScopesApi, ZoneId } from "@qualithm/platform"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import { defineTool, dryRunInput, pageInput } from "./tool.ts"

const zone = z.enum(Object.values(ZoneId) as [ZoneId, ...ZoneId[]])

/** Lists the team's scopes, optionally only one zone's or one parent's children. */
export const listScopes = defineTool({
  name: "list_scopes",
  description:
    "List the team's scopes, optionally only those in one device zone or directly under one parent scope.",
  mutating: false,
  operations: ["listScopes"],
  input: {
    zone: zone.optional().describe("only the scopes in this device zone"),
    parentId: z.string().min(1).optional().describe("only the scopes directly under this scope"),
    ...pageInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(ScopesApi).listScopes({ teamId, ...input })
    return data
  }
})

/** Fetches one scope. */
export const getScope = defineTool({
  name: "get_scope",
  description: "Fetch a single scope by id.",
  mutating: false,
  operations: ["getScope"],
  input: { scopeId: z.string().min(1).describe("id of the scope to fetch") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(ScopesApi)
      .getScope({ teamId, scopeId: input.scopeId })
    return data
  }
})

/** Creates a top-level scope in a device zone, or a child scope under a parent. */
export const createScope = defineTool({
  name: "create_scope",
  description:
    "Create a scope: top-level in a device zone, or under a parent scope, which sets its zone.",
  mutating: true,
  operations: ["createScope"],
  input: {
    name: z.string().min(1).describe("scope name, up to 64 characters"),
    zone: zone.optional().describe("device zone for a top-level scope; omit with parentId"),
    parentId: z.string().min(1).optional().describe("id of the parent scope; omit with zone"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const { name, zone, parentId } = input
    if ((zone === undefined) === (parentId === undefined)) {
      throw new CliError("set zone for a top-level scope or parentId for a child scope")
    }
    const teamId = await session.teamId()
    const { data } = await session.client.api(ScopesApi).createScope({
      teamId,
      createScopeRequest: {
        name,
        ...(zone === undefined ? {} : { zone }),
        ...(parentId === undefined ? {} : { parentId })
      }
    })
    return data
  }
})

/** Renames a scope. */
export const updateScope = defineTool({
  name: "update_scope",
  description: "Rename a scope.",
  mutating: true,
  operations: ["updateScope"],
  input: {
    scopeId: z.string().min(1).describe("id of the scope to rename"),
    name: z.string().min(1).describe("new scope name"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client.api(ScopesApi).updateScope({
      teamId,
      scopeId: input.scopeId,
      updateScopeRequest: { name: input.name }
    })
    return undefined
  }
})

/** Deletes a scope. */
export const deleteScope = defineTool({
  name: "delete_scope",
  description: "Delete a scope by id.",
  mutating: true,
  operations: ["deleteScope"],
  input: { scopeId: z.string().min(1).describe("id of the scope to delete"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client.api(ScopesApi).deleteScope({ teamId, scopeId: input.scopeId })
    return undefined
  }
})
