import { DashboardsApi } from "@qualithm/platform"
import { z } from "zod"

import { dashboardWidgets } from "./definition.ts"
import { defineTool, dryRunInput, pageInput, type Tool } from "./tool.ts"

const dashboardId = (what: string): z.ZodString =>
  z.string().min(1).describe(`id of the dashboard ${what}`)

// The SDK's models check each widget's fields; the platform validates their values.
const widgets = (
  description: string
): z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>> =>
  z.array(z.record(z.string(), z.unknown())).optional().describe(description)

/** Lists the team's dashboards. */
export const listDashboards = defineTool({
  name: "list_dashboards",
  description: "List dashboards for the token's team.",
  mutating: false,
  input: { ...pageInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(DashboardsApi).listDashboards({
      teamId,
      ...(input.page === undefined ? {} : { page: input.page }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    })
    return data
  }
})

/** Creates a dashboard, team-wide or bound to one scope. */
export const createDashboard = defineTool({
  name: "create_dashboard",
  description: "Create a dashboard, team-wide or bound to one scope.",
  mutating: true,
  input: {
    name: z.string().min(1).describe("dashboard name"),
    scopeId: z
      .string()
      .min(1)
      .optional()
      .describe("id of the scope to bind the dashboard to; omit for team-wide"),
    payload: widgets("ordered widget array; omit for an empty dashboard"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const payload = input.payload === undefined ? undefined : dashboardWidgets(input.payload)
    const teamId = await session.teamId()
    const { data } = await session.client.api(DashboardsApi).createDashboard({
      teamId,
      createDashboardRequest: {
        name: input.name,
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
        ...(payload === undefined ? {} : { payload })
      }
    })
    return data
  }
})

/** Fetches one dashboard with its widgets. */
export const getDashboard = defineTool({
  name: "get_dashboard",
  description: "Fetch a single dashboard by id, including its widgets.",
  mutating: false,
  input: { dashboardId: dashboardId("to fetch") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(DashboardsApi)
      .getDashboard({ teamId, dashboardId: input.dashboardId })
    return data
  }
})

/** Updates a dashboard's name, scope or widgets; unset fields stay unchanged. */
export const updateDashboard = defineTool({
  name: "update_dashboard",
  description: "Update a dashboard's name, scope, or widget layout.",
  mutating: true,
  input: {
    dashboardId: dashboardId("to update"),
    name: z.string().min(1).optional().describe("new dashboard name"),
    scopeId: z.string().min(1).optional().describe("new scope id to bind the dashboard to"),
    payload: widgets("new ordered widget array"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const payload = input.payload === undefined ? undefined : dashboardWidgets(input.payload)
    const teamId = await session.teamId()
    const { data } = await session.client.api(DashboardsApi).updateDashboard({
      teamId,
      dashboardId: input.dashboardId,
      updateDashboardRequest: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
        ...(payload === undefined ? {} : { payload })
      }
    })
    return data
  }
})

/** Deletes one dashboard. */
export const deleteDashboard = defineTool({
  name: "delete_dashboard",
  description: "Delete a dashboard by id.",
  mutating: true,
  input: { dashboardId: dashboardId("to delete"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client
      .api(DashboardsApi)
      .deleteDashboard({ teamId, dashboardId: input.dashboardId })
    return undefined
  }
})

/** Dashboard tools. */
export const dashboardTools: readonly Tool[] = [
  listDashboards,
  createDashboard,
  getDashboard,
  updateDashboard,
  deleteDashboard
]
