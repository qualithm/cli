import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import type { Tool } from "../../tools/tool.ts"
import {
  getAccount,
  getCommunicationPreferences,
  getSession,
  listCapabilities,
  listRoles,
  listSessions,
  listZones
} from "../../tools/workspace.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const at = "2026-01-01T00:00:00.000Z"
const page = (items: unknown[]): unknown => ({ data: { current: 1, last: 1, items } })
const SESSION = {
  id: "ses_1",
  accountId: "acc_1",
  userAgent: "ua",
  ipAddress: "127.0.0.1",
  mfaVerified: false,
  thisDevice: true,
  createdAt: at,
  lastUsedAt: at,
  expiresAt: at,
  revokedAt: null
}

const ROUTES = {
  ...DEFAULT_ROUTES,
  "GET /v1/account": {
    status: 200,
    body: { data: { id: "acc_1", email: "a@b.c", name: "A", createdAt: at, updatedAt: at } }
  },
  "GET /v1/teams/team_1/capabilities": {
    status: 200,
    body: page([{ id: "cap_1", key: "power", type: "onoff" }])
  },
  "GET /v1/account/memberships": { status: 200, body: page([{ teamId: "team_1" }]) },
  "GET /v1/account/sessions": { status: 200, body: page([SESSION]) },
  "GET /v1/account/sessions/ses_1": { status: 200, body: { data: SESSION } },
  "GET /v1/account/communication-preferences": {
    status: 200,
    body: {
      data: {
        blogArticles: true,
        educationResources: false,
        events: false,
        productNewsPromotions: false
      }
    }
  },
  "GET /v1/zones": {
    status: 200,
    body: { data: { api: "https://api.example", zones: [{ id: "eu" }] } }
  }
}

async function call(
  tool: Tool,
  input: unknown
): Promise<{ result: Awaited<ReturnType<typeof callTool>>; urls: URL[] }> {
  const { fetch } = fakePlatform(ROUTES)
  const urls: URL[] = []
  const recording: typeof fetch = async (req, init) => {
    urls.push(new URL(req instanceof Request ? req.url : req.toString()))
    return fetch(req, init)
  }
  const result = await callTool(
    tool,
    (dryRun) => new Session({ token: "qmt_x", fetch: recording, dryRun }),
    input
  )
  return { result, urls }
}

describe("get_account", () => {
  it("reads the account", async () => {
    const { result } = await call(getAccount, {})
    expect(result).toMatchObject({ ok: true, data: { id: "acc_1", email: "a@b.c" } })
  })
})

describe("list_capabilities", () => {
  it("lists the team's capabilities with filters", async () => {
    const { result, urls } = await call(listCapabilities, {
      page: 2,
      limit: 5,
      type: "onoff",
      tag: "light",
      key: "power"
    })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "cap_1" }] } })
    const url = urls.at(-1)
    expect(url?.pathname).toBe("/v1/teams/team_1/capabilities")
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      page: "2",
      limit: "5",
      type: "onoff",
      tag: "light",
      key: "power"
    })
  })

  it("rejects an unknown type as a usage error", async () => {
    const { result, urls } = await call(listCapabilities, { type: "dimmer" })
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(urls).toEqual([])
  })
})

describe("list_roles", () => {
  it("lists the caller's role assignments", async () => {
    const { result, urls } = await call(listRoles, { limit: 3 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ teamId: "team_1" }] } })
    expect(urls.at(-1)?.search).toBe("?limit=3")
  })
})

describe("list_sessions", () => {
  it("lists only this device's session when asked", async () => {
    const { result, urls } = await call(listSessions, { thisDeviceOnly: true })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "ses_1" }] } })
    expect(urls.at(-1)?.searchParams.get("this_device")).toBe("true")
  })

  it("lists every session by default", async () => {
    const { urls } = await call(listSessions, { thisDeviceOnly: false })
    expect(urls.at(-1)?.search).toBe("")
  })
})

describe("get_session", () => {
  it("fetches a session by id", async () => {
    const { result } = await call(getSession, { sessionId: "ses_1" })
    expect(result).toMatchObject({ ok: true, data: { id: "ses_1", thisDevice: true } })
  })

  it("requires a session id", async () => {
    const { result } = await call(getSession, { sessionId: "" })
    expect(result).toMatchObject({ ok: false, code: "usage" })
  })
})

describe("get_communication_preferences", () => {
  it("reads the preferences", async () => {
    const { result } = await call(getCommunicationPreferences, {})
    expect(result).toMatchObject({ ok: true, data: { blogArticles: true } })
  })
})

describe("list_zones", () => {
  it("lists the zones", async () => {
    const { result } = await call(listZones, {})
    expect(result).toMatchObject({ ok: true, data: { zones: [{ id: "eu" }] } })
  })
})
