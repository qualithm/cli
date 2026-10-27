import { SpacesApi, ZoneId } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, dryRunInput, pageInput } from "./tool.ts"

const zone = z.enum(Object.values(ZoneId) as [ZoneId, ...ZoneId[]])

/** Lists the team's spaces, optionally only one zone's. */
export const listSpaces = defineTool({
  name: "list_spaces",
  description: "List the team's spaces, optionally only those in one device zone.",
  mutating: false,
  input: {
    zone: zone.optional().describe("only the spaces in this device zone"),
    ...pageInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(SpacesApi).listSpaces({ teamId, ...input })
    return data
  }
})

/** Fetches one space. */
export const getSpace = defineTool({
  name: "get_space",
  description: "Fetch a single space by id.",
  mutating: false,
  input: { spaceId: z.string().min(1).describe("id of the space to fetch") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(SpacesApi)
      .getSpace({ teamId, spaceId: input.spaceId })
    return data
  }
})

/** Creates a space in a device zone. */
export const createSpace = defineTool({
  name: "create_space",
  description: "Create a space in a device zone.",
  mutating: true,
  input: { zone: zone.describe("device zone to create the space in"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(SpacesApi)
      .createSpace({ teamId, createSpaceRequest: { zone: input.zone } })
    return data
  }
})

/** Renames a space. */
export const updateSpace = defineTool({
  name: "update_space",
  description: "Rename a space.",
  mutating: true,
  input: {
    spaceId: z.string().min(1).describe("id of the space to rename"),
    name: z.string().min(1).describe("new space name"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client.api(SpacesApi).updateSpace({
      teamId,
      spaceId: input.spaceId,
      updateSpaceRequest: { name: input.name }
    })
    return undefined
  }
})

/** Deletes a space and the devices in it. */
export const deleteSpace = defineTool({
  name: "delete_space",
  description: "Delete a space by id, cascading to its devices.",
  mutating: true,
  input: { spaceId: z.string().min(1).describe("id of the space to delete"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client.api(SpacesApi).deleteSpace({ teamId, spaceId: input.spaceId })
    return undefined
  }
})
