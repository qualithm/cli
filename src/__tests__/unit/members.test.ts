import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import {
  acceptInvite,
  addTeamMember,
  createTeamInvite,
  getTeamMember,
  listTeamInvites,
  listTeamMembers,
  lookupInvite,
  memberTools,
  removeTeamMember,
  resendTeamInvite,
  revokeTeamInvite,
  updateTeamMember
} from "../../tools/members.ts"
import type { Tool } from "../../tools/tool.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const stamps = { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }

const MEMBER = {
  id: "mem_1",
  accountId: "acc_1",
  teamId: "team_2",
  role: "viewer",
  accountEmail: "a@example.com",
  accountName: "A",
  teamName: "lab",
  ...stamps
}

const MEMBERSHIP = {
  id: "mem_1",
  accountId: "acc_1",
  teamId: "team_2",
  role: "viewer",
  status: "active",
  ...stamps
}

const INVITE = {
  id: "ivt_1",
  teamId: "team_2",
  teamName: "lab",
  email: "a@example.com",
  role: "manager",
  invitedBy: "acc_9",
  inviterName: "B",
  expiresAt: "2026-10-08T00:00:00.000Z",
  ...stamps
}

const page = (items: unknown[]): { data: Record<string, unknown> } => ({
  data: { items, current: 1, last: 1, total: items.length, limit: 20 }
})

const base = "/v1/teams/team_2"

const routes = {
  ...DEFAULT_ROUTES,
  [`GET ${base}/members`]: { status: 200, body: page([MEMBER]) },
  [`POST ${base}/members`]: { status: 201, body: { data: MEMBERSHIP } },
  [`GET ${base}/members/mem_1`]: { status: 200, body: { data: MEMBER } },
  [`PATCH ${base}/members/mem_1`]: { status: 204 },
  [`DELETE ${base}/members/mem_1`]: { status: 204 },
  [`GET ${base}/invites`]: { status: 200, body: page([INVITE]) },
  [`POST ${base}/invites`]: {
    status: 200,
    body: {
      data: {
        items: [
          { email: "a@example.com", result: "sent", invite: INVITE },
          { email: "c@example.com", result: "already_member", invite: null }
        ]
      }
    }
  },
  [`POST ${base}/invites/ivt_1/resend`]: { status: 200, body: { data: INVITE } },
  [`DELETE ${base}/invites/ivt_1`]: { status: 204 },
  ["POST /v1/invites/lookup"]: {
    status: 200,
    body: { data: { invite: INVITE, forCaller: true } }
  },
  ["POST /v1/invites/accept"]: { status: 201, body: { data: MEMBERSHIP } }
}

type Called = {
  result: Awaited<ReturnType<typeof callTool>>
  requests: { method: string; path: string; body?: unknown }[]
}

async function call(tool: Tool, input: unknown): Promise<Called> {
  const { fetch, requests } = fakePlatform(routes)
  const result = await callTool(
    tool,
    (dryRun) => new Session({ token: "qmt_x", fetch, dryRun }),
    input
  )
  return { result, requests }
}

describe("member tools", () => {
  it("registers in Go order", () => {
    expect(memberTools.map((t) => t.name)).toEqual([
      "list_team_members",
      "add_team_member",
      "get_team_member",
      "update_team_member",
      "remove_team_member",
      "list_team_invites",
      "create_team_invite",
      "resend_team_invite",
      "revoke_team_invite",
      "lookup_invite",
      "accept_invite"
    ])
  })

  it("lists a team's members", async () => {
    const { result, requests } = await call(listTeamMembers, { teamId: "team_2", page: 2 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "mem_1", role: "viewer" }] } })
    expect(requests).toMatchObject([{ method: "GET", path: `${base}/members` }])
  })

  it("accepts an invite", async () => {
    const { result, requests } = await call(addTeamMember, { teamId: "team_2", inviteId: "ivt_1" })
    expect(result).toMatchObject({ ok: true, data: { id: "mem_1", status: "active" } })
    expect(requests).toMatchObject([
      { method: "POST", path: `${base}/members`, body: { inviteId: "ivt_1" } }
    ])
  })

  it("fetches a member", async () => {
    const { result, requests } = await call(getTeamMember, { teamId: "team_2", memberId: "mem_1" })
    expect(result).toMatchObject({ ok: true, data: { id: "mem_1" } })
    expect(requests).toMatchObject([{ method: "GET", path: `${base}/members/mem_1` }])
  })

  it("changes a member's role", async () => {
    const input = { teamId: "team_2", memberId: "mem_1", role: "manager" }
    const { result, requests } = await call(updateTeamMember, input)
    expect(result).toEqual({ ok: true })
    expect(requests).toMatchObject([
      { method: "PATCH", path: `${base}/members/mem_1`, body: { role: "manager" } }
    ])
  })

  it("removes a member", async () => {
    const { result, requests } = await call(removeTeamMember, {
      teamId: "team_2",
      memberId: "mem_1"
    })
    expect(result).toEqual({ ok: true })
    expect(requests).toMatchObject([{ method: "DELETE", path: `${base}/members/mem_1` }])
  })

  it("lists a team's invites", async () => {
    const { result, requests } = await call(listTeamInvites, { teamId: "team_2", limit: 10 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "ivt_1" }] } })
    expect(requests).toMatchObject([{ method: "GET", path: `${base}/invites` }])
  })

  it("invites email addresses", async () => {
    const input = { teamId: "team_2", emails: ["a@example.com", "c@example.com"], role: "manager" }
    const { result, requests } = await call(createTeamInvite, input)
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [
          { email: "a@example.com", result: "sent", invite: { id: "ivt_1" } },
          { email: "c@example.com", result: "already_member", invite: null }
        ]
      }
    })
    expect(requests).toMatchObject([
      {
        method: "POST",
        path: `${base}/invites`,
        body: { emails: ["a@example.com", "c@example.com"], role: "manager" }
      }
    ])
  })

  it("resends an invite", async () => {
    const { result, requests } = await call(resendTeamInvite, {
      teamId: "team_2",
      inviteId: "ivt_1"
    })
    expect(result).toMatchObject({ ok: true, data: { id: "ivt_1", email: "a@example.com" } })
    expect(requests).toMatchObject([{ method: "POST", path: `${base}/invites/ivt_1/resend` }])
  })

  it("looks up an invite link", async () => {
    const { result, requests } = await call(lookupInvite, { token: "qmi_abc" })
    expect(result).toMatchObject({ ok: true, data: { invite: { id: "ivt_1" }, forCaller: true } })
    expect(requests).toMatchObject([
      { method: "POST", path: "/v1/invites/lookup", body: { token: "qmi_abc" } }
    ])
  })

  it("accepts an invite link", async () => {
    const { result, requests } = await call(acceptInvite, { token: "qmi_abc" })
    expect(result).toMatchObject({ ok: true, data: { id: "mem_1", status: "active" } })
    expect(requests).toMatchObject([
      { method: "POST", path: "/v1/invites/accept", body: { token: "qmi_abc" } }
    ])
  })

  it("revokes an invite", async () => {
    const { result, requests } = await call(revokeTeamInvite, {
      teamId: "team_2",
      inviteId: "ivt_1"
    })
    expect(result).toEqual({ ok: true })
    expect(requests).toMatchObject([{ method: "DELETE", path: `${base}/invites/ivt_1` }])
  })

  it.each([
    [addTeamMember, { inviteId: "ivt_1" }, "POST", `${base}/members`, { inviteId: "ivt_1" }],
    [
      updateTeamMember,
      { memberId: "mem_1", role: "owner" },
      "PATCH",
      `${base}/members/mem_1`,
      { role: "owner" }
    ],
    [removeTeamMember, { memberId: "mem_1" }, "DELETE", `${base}/members/mem_1`, undefined],
    [
      createTeamInvite,
      { emails: ["a@example.com"], role: "viewer" },
      "POST",
      `${base}/invites`,
      { emails: ["a@example.com"], role: "viewer" }
    ],
    [resendTeamInvite, { inviteId: "ivt_1" }, "POST", `${base}/invites/ivt_1/resend`, undefined],
    [revokeTeamInvite, { inviteId: "ivt_1" }, "DELETE", `${base}/invites/ivt_1`, undefined]
  ] as const)("plans %# on a dry run", async (tool, input, method, path, body) => {
    const { result, requests } = await call(tool, { teamId: "team_2", ...input, dryRun: true })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      action: { method, path, ...(body === undefined ? {} : { body }) }
    })
    expect(requests).toEqual([])
  })

  it("plans accepting an invite link on a dry run", async () => {
    const { result, requests } = await call(acceptInvite, { token: "qmi_abc", dryRun: true })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      action: { method: "POST", path: "/v1/invites/accept", body: { token: "qmi_abc" } }
    })
    expect(requests).toEqual([])
  })

  it.each([
    [listTeamMembers, {}],
    [getTeamMember, { teamId: "team_2" }],
    [updateTeamMember, { teamId: "team_2", memberId: "mem_1", role: "guest" }],
    [createTeamInvite, { teamId: "team_2", emails: ["a@example.com"], role: "guest" }],
    [createTeamInvite, { teamId: "team_2", emails: [], role: "viewer" }],
    [acceptInvite, { token: "" }]
  ] as const)("rejects invalid input to %#", async (tool, input) => {
    const { result, requests } = await call(tool, input)
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(requests).toEqual([])
  })
})
