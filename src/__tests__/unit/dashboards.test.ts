import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import {
  createDashboard,
  dashboardTools,
  deleteDashboard,
  getDashboard,
  listDashboards,
  updateDashboard
} from "../../tools/dashboards.ts"
import type { Tool } from "../../tools/tool.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const WIDGET = {
  id: "w_1",
  type: "value",
  layout: { x: 0, y: 0, w: 2, h: 2 },
  source: { deviceId: "dev_1", metric: "temp" }
}

const DASHBOARD = {
  id: "dash_1",
  teamId: "team_1",
  scopeId: null,
  name: "lab",
  payload: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
}

const ROUTES = {
  ...DEFAULT_ROUTES,
  "GET /v1/teams/team_1/dashboards": {
    status: 200,
    body: { data: { items: [DASHBOARD], current: 1, last: 1, total: 1, limit: 20 } }
  },
  "POST /v1/teams/team_1/dashboards": { status: 201, body: { data: DASHBOARD } },
  "GET /v1/teams/team_1/dashboards/dash_1": { status: 200, body: { data: DASHBOARD } },
  "PATCH /v1/teams/team_1/dashboards/dash_1": { status: 200, body: { data: DASHBOARD } },
  "DELETE /v1/teams/team_1/dashboards/dash_1": { status: 204 }
}

async function call(
  tool: Tool,
  input: unknown
): Promise<{
  result: Awaited<ReturnType<typeof callTool>>
  requests: ReturnType<typeof fakePlatform>["requests"]
}> {
  const { fetch, requests } = fakePlatform(ROUTES)
  const result = await callTool(
    tool,
    (dryRun) => new Session({ token: "qmt_x", fetch, dryRun }),
    input
  )
  return { result, requests }
}

describe("dashboard tools", () => {
  it("registers in order", () => {
    expect(dashboardTools.map((tool) => tool.name)).toEqual([
      "list_dashboards",
      "create_dashboard",
      "get_dashboard",
      "update_dashboard",
      "delete_dashboard"
    ])
  })

  it("lists a page of dashboards", async () => {
    const { result, requests } = await call(listDashboards, { page: 2, limit: 5 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "dash_1" }] } })
    expect(requests.at(-1)).toMatchObject({ method: "GET", path: "/v1/teams/team_1/dashboards" })
  })

  it("lists with the server's default paging", async () => {
    const { result } = await call(listDashboards, {})
    expect(result.ok).toBe(true)
  })

  it("creates a scoped dashboard with widgets", async () => {
    const input = { name: "lab", scopeId: "spc_1", payload: [WIDGET] }
    const { result, requests } = await call(createDashboard, input)
    expect(result).toMatchObject({ ok: true, data: { id: "dash_1" } })
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/teams/team_1/dashboards",
      body: { name: "lab", scopeId: "spc_1", payload: [WIDGET] }
    })
  })

  it("creates a blank team-wide dashboard", async () => {
    const { requests } = await call(createDashboard, { name: "lab" })
    expect(requests.at(-1)?.body).toEqual({ name: "lab" })
  })

  it("plans a create on a dry run", async () => {
    const { result, requests } = await call(createDashboard, { name: "lab", dryRun: true })
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      action: { method: "POST", path: "/v1/teams/team_1/dashboards", body: { name: "lab" } }
    })
    expect(requests.some((r) => r.method === "POST")).toBe(false)
  })

  it("rejects a create with no name", async () => {
    const { result } = await call(createDashboard, { name: "" })
    expect(result).toMatchObject({ ok: false, code: "usage" })
  })

  it("rejects a payload that isn't a widget array", async () => {
    const { result } = await call(createDashboard, { name: "lab", payload: { id: "w_1" } })
    expect(result).toMatchObject({ ok: false, code: "usage" })
  })

  it("fetches a dashboard", async () => {
    const { result } = await call(getDashboard, { dashboardId: "dash_1" })
    expect(result).toMatchObject({ ok: true, data: { id: "dash_1", name: "lab" } })
  })

  it("updates only the fields given", async () => {
    const input = { dashboardId: "dash_1", name: "new", scopeId: "spc_1", payload: [WIDGET] }
    const { result, requests } = await call(updateDashboard, input)
    expect(result).toMatchObject({ ok: true, data: { id: "dash_1" } })
    expect(requests.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/v1/teams/team_1/dashboards/dash_1",
      body: { name: "new", scopeId: "spc_1", payload: [WIDGET] }
    })
    const { requests: bare } = await call(updateDashboard, { dashboardId: "dash_1" })
    expect(bare.at(-1)?.body).toEqual({})
  })

  it("plans an update on a dry run", async () => {
    const { result, requests } = await call(updateDashboard, {
      dashboardId: "dash_1",
      name: "new",
      dryRun: true
    })
    expect(result).toMatchObject({
      dryRun: true,
      action: { method: "PATCH", path: "/v1/teams/team_1/dashboards/dash_1" }
    })
    expect(requests.some((r) => r.method === "PATCH")).toBe(false)
  })

  it("deletes a dashboard", async () => {
    const { result, requests } = await call(deleteDashboard, { dashboardId: "dash_1" })
    expect(result).toEqual({ ok: true })
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/teams/team_1/dashboards/dash_1"
    })
  })

  it("plans a delete on a dry run", async () => {
    const { result, requests } = await call(deleteDashboard, {
      dashboardId: "dash_1",
      dryRun: true
    })
    expect(result).toMatchObject({
      dryRun: true,
      action: { method: "DELETE", path: "/v1/teams/team_1/dashboards/dash_1" }
    })
    expect(requests.some((r) => r.method === "DELETE")).toBe(false)
  })
})
