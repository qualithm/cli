import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import {
  createTeam,
  deleteTeam,
  getTeam,
  getTeamDeviceState,
  listTeams,
  teamTools,
  updateTeam
} from "../../tools/teams.ts"
import type { Tool } from "../../tools/tool.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const TEAM = {
  id: "team_2",
  name: "lab",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  memberId: "mem_1",
  memberRole: "owner",
  permissions: []
}

const STATE = {
  deviceId: "dev_1",
  scopeId: "spc_1",
  online: true,
  lastSeenAt: "2026-10-20T10:00:00.000Z",
  metrics: {}
}

const routes = {
  ...DEFAULT_ROUTES,
  "POST /v1/teams": { status: 201, body: { data: TEAM } },
  "GET /v1/teams/team_1": { status: 200, body: { data: { ...TEAM, id: "team_1" } } },
  "GET /v1/teams/team_2": { status: 200, body: { data: TEAM } },
  "PATCH /v1/teams/team_2": { status: 204 },
  "DELETE /v1/teams/team_2": { status: 204 },
  "GET /v1/teams/team_2/device-states": { status: 200, body: { data: { items: [STATE] } } }
}

async function call(
  tool: Tool,
  input: unknown
): Promise<{
  result: Awaited<ReturnType<typeof callTool>>
  requests: { method: string; path: string; body?: unknown }[]
}> {
  const { fetch, requests } = fakePlatform(routes)
  const result = await callTool(
    tool,
    (dryRun) => new Session({ token: "qmt_x", fetch, dryRun }),
    input
  )
  return { result, requests }
}

describe("team tools", () => {
  it("registers in Go order", () => {
    expect(teamTools.map((t) => t.name)).toEqual([
      "list_teams",
      "create_team",
      "get_team",
      "update_team",
      "delete_team",
      "get_team_device_state"
    ])
  })

  it("lists teams with paging", async () => {
    const { result, requests } = await call(listTeams, { page: 1, limit: 5 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "team_1" }] } })
    expect(requests).toMatchObject([{ method: "GET", path: "/v1/teams" }])
  })

  it("creates a team", async () => {
    const { result, requests } = await call(createTeam, {})
    expect(result).toMatchObject({ ok: true, data: { id: "team_2", memberRole: "owner" } })
    expect(requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/teams" })
  })

  it("plans a team on a dry run", async () => {
    const { result, requests } = await call(createTeam, { dryRun: true })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      action: { method: "POST", path: "/v1/teams" }
    })
    expect(requests).toEqual([])
  })

  it("fetches the session's team without an id", async () => {
    const { result, requests } = await call(getTeam, {})
    expect(result).toMatchObject({ ok: true, data: { id: "team_1" } })
    expect(requests.map((r) => r.path)).toEqual(["/v1/teams", "/v1/teams/team_1"])
  })

  it("fetches a named team", async () => {
    const { result, requests } = await call(getTeam, { teamId: "team_2" })
    expect(result).toMatchObject({ ok: true, data: { id: "team_2" } })
    expect(requests.map((r) => r.path)).toEqual(["/v1/teams/team_2"])
  })

  it("renames a team", async () => {
    const { result, requests } = await call(updateTeam, { teamId: "team_2", name: "new" })
    expect(result).toEqual({ ok: true })
    expect(requests).toMatchObject([
      { method: "PATCH", path: "/v1/teams/team_2", body: { name: "new" } }
    ])
  })

  it("plans a rename on a dry run", async () => {
    const { result, requests } = await call(updateTeam, {
      teamId: "team_2",
      name: "new",
      dryRun: true
    })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      action: { method: "PATCH", path: "/v1/teams/team_2", body: { name: "new" } }
    })
    expect(requests).toEqual([])
  })

  it("deletes a team", async () => {
    const { result, requests } = await call(deleteTeam, { teamId: "team_2" })
    expect(result).toEqual({ ok: true })
    expect(requests).toMatchObject([{ method: "DELETE", path: "/v1/teams/team_2" }])
  })

  it("plans a delete on a dry run", async () => {
    const { result, requests } = await call(deleteTeam, { teamId: "team_2", dryRun: true })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      action: { method: "DELETE", path: "/v1/teams/team_2" }
    })
    expect(requests).toEqual([])
  })

  it("reads a team's device state", async () => {
    const { result, requests } = await call(getTeamDeviceState, { teamId: "team_2" })
    expect(result).toMatchObject({
      ok: true,
      data: { items: [{ deviceId: "dev_1", online: true }] }
    })
    expect(requests).toMatchObject([{ method: "GET", path: "/v1/teams/team_2/device-states" }])
  })

  it.each([
    [updateTeam, { teamId: "team_2" }],
    [deleteTeam, {}],
    [getTeam, { teamId: "" }]
  ] as const)("rejects invalid input to %#", async (tool, input) => {
    const { result, requests } = await call(tool, input)
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(requests).toEqual([])
  })
})
