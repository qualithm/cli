import { DevicesApi, TeamsApi } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, dryRunInput, pageInput, type Tool } from "./tool.ts"

/** Lists the teams the token's member belongs to. */
export const listTeams = defineTool({
  name: "list_teams",
  description: "List the teams the token's member belongs to.",
  mutating: false,
  operations: ["listTeams"],
  input: { ...pageInput },
  run: async (session, input) => {
    const { data } = await session.client.api(TeamsApi).listTeams(input)
    return data
  }
})

/** Creates a team with the caller as owner. */
export const createTeam = defineTool({
  name: "create_team",
  description:
    "Create a team with the caller as owner. The platform assigns the initial name; rename it with update_team.",
  mutating: true,
  operations: ["createTeam"],
  input: { ...dryRunInput },
  run: async (session) => {
    const { data } = await session.client.api(TeamsApi).createTeam()
    return data
  }
})

/** Fetches a team with the caller's role and permissions in it. */
export const getTeam = defineTool({
  name: "get_team",
  description:
    "Fetch a team with your role and the permissions you hold in it, so you can check before acting. Without an id, it's the team this server acts on.",
  mutating: false,
  operations: ["getTeam"],
  input: {
    teamId: z
      .string()
      .min(1)
      .optional()
      .describe("id of the team to fetch; empty means the team this server acts on")
  },
  run: async (session, input) => {
    const teamId = input.teamId ?? (await session.teamId())
    const { data } = await session.client.api(TeamsApi).getTeam({ teamId })
    return data
  }
})

/** Renames a team. */
export const updateTeam = defineTool({
  name: "update_team",
  description: "Rename a team.",
  mutating: true,
  operations: ["updateTeam"],
  input: {
    teamId: z.string().min(1).describe("id of the team to rename"),
    name: z.string().min(1).describe("new team name"),
    ...dryRunInput
  },
  run: async (session, input) => {
    await session.client
      .api(TeamsApi)
      .updateTeam({ teamId: input.teamId, updateTeamRequest: { name: input.name } })
    return undefined
  }
})

/** Deletes a team. */
export const deleteTeam = defineTool({
  name: "delete_team",
  description: "Delete a team by id.",
  mutating: true,
  operations: ["deleteTeam"],
  input: {
    teamId: z.string().min(1).describe("id of the team to delete"),
    ...dryRunInput
  },
  run: async (session, input) => {
    await session.client.api(TeamsApi).deleteTeam({ teamId: input.teamId })
    return undefined
  }
})

/** Reads the latest state of every device in a team. */
export const getTeamDeviceState = defineTool({
  name: "get_team_device_state",
  description:
    "Read whether each device in a team is online, when it was last seen, and its latest metrics. Without an id, it's the team this server acts on.",
  mutating: false,
  operations: ["listTeamDeviceStates"],
  input: {
    teamId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "id of the team to read device state for; empty means the team this server acts on"
      ),
    ...pageInput
  },
  run: async (session, input) => {
    const { teamId, ...page } = input
    const { data } = await session.client
      .api(DevicesApi)
      .listTeamDeviceStates({ teamId: teamId ?? (await session.teamId()), ...page })
    return data
  }
})

/** Team tools: create, inspect, update and delete teams. */
export const teamTools: readonly Tool[] = [
  listTeams,
  createTeam,
  getTeam,
  updateTeam,
  deleteTeam,
  getTeamDeviceState
]
