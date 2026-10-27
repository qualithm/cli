import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { type FetchAPI, Session } from "../../platform.ts"
import {
  automationTools,
  createAutomation,
  createAutomationTriggerSecret,
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  listAutomationTemplates,
  runAutomation,
  triggerAutomation,
  updateAutomation
} from "../../tools/automations.ts"
import type { Tool } from "../../tools/tool.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const PAYLOAD = {
  trigger: { type: "schedule", config: { cron: "0 * * * *" } },
  chain: [{ kind: "action", type: "notify", config: { channel: "email" } }]
}

const AUTOMATION = {
  id: "auto_1",
  teamId: "team_1",
  spaceId: null,
  spaceName: null,
  name: "hourly",
  enabled: true,
  payload: PAYLOAD,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
}

const RUN = {
  id: "run_1",
  automationId: "auto_1",
  triggerType: "manual",
  status: "queued",
  steps: [],
  lastError: null,
  triggeredAt: "2026-10-01T00:00:00.000Z",
  executedAt: null
}

const TEMPLATE = {
  id: "tpl_1",
  version: 1,
  name: "alert",
  description: "alert on a threshold",
  trigger: "telemetry",
  slots: []
}

const page = (items: unknown[]): { data: Record<string, unknown> } => ({
  data: { items, current: 1, last: 1, total: items.length, limit: 20 }
})

const ROUTES = {
  ...DEFAULT_ROUTES,
  "GET /v1/teams/team_1/automations": { status: 200, body: page([AUTOMATION]) },
  "POST /v1/teams/team_1/automations": { status: 201, body: { data: AUTOMATION } },
  "GET /v1/teams/team_1/automations/auto_1": { status: 200, body: { data: AUTOMATION } },
  "PATCH /v1/teams/team_1/automations/auto_1": { status: 200, body: { data: AUTOMATION } },
  "DELETE /v1/teams/team_1/automations/auto_1": { status: 204 },
  "POST /v1/teams/team_1/automations/auto_1/runs": { status: 202, body: { data: { id: "run_1" } } },
  "GET /v1/teams/team_1/automations/auto_1/runs": { status: 200, body: page([RUN]) },
  "GET /v1/teams/team_1/devices/dev_1/automation-templates": {
    status: 200,
    body: { data: [TEMPLATE] }
  },
  "POST /v1/automations/trigger": { status: 202, body: { data: { runId: "run_2" } } },
  "POST /v1/teams/team_1/automations/auto_1/trigger-secret": {
    status: 201,
    body: { data: { url: "https://api.qualithm.com/v1/automations/trigger", secret: "qma_s" } }
  }
}

type Call = {
  result: Awaited<ReturnType<typeof callTool>>
  requests: ReturnType<typeof fakePlatform>["requests"]
  auth: (string | null)[]
}

async function call(tool: Tool, input: unknown): Promise<Call> {
  const platform = fakePlatform(ROUTES)
  const auth: (string | null)[] = []
  const fetch: FetchAPI = async (url, init) => {
    auth.push(new Headers(init?.headers).get("Authorization"))
    return platform.fetch(url, init)
  }
  const result = await callTool(
    tool,
    (dryRun) => new Session({ token: "qmt_x", fetch, dryRun }),
    input
  )
  return { result, requests: platform.requests, auth }
}

function planned(result: Call["result"], method: string, path: string): void {
  expect(result).toMatchObject({ ok: true, dryRun: true, action: { method, path } })
}

describe("automation tools", () => {
  it("registers in order", () => {
    expect(automationTools.map((tool) => tool.name)).toEqual([
      "list_automations",
      "create_automation",
      "get_automation",
      "update_automation",
      "delete_automation",
      "run_automation",
      "list_automation_runs",
      "list_automation_templates",
      "trigger_automation",
      "create_automation_trigger_secret"
    ])
  })

  it("lists automations, paged and not", async () => {
    const { result } = await call(listAutomations, { page: 1, limit: 10 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "auto_1" }] } })
    expect((await call(listAutomations, {})).result.ok).toBe(true)
  })

  it("creates an automation from a payload", async () => {
    const input = { name: "hourly", spaceId: "spc_1", payload: PAYLOAD }
    const { result, requests } = await call(createAutomation, input)
    expect(result).toMatchObject({ ok: true, data: { id: "auto_1" } })
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/teams/team_1/automations",
      body: { name: "hourly", spaceId: "spc_1", payload: PAYLOAD }
    })
  })

  it("creates an automation from a template", async () => {
    const input = { name: "alert", template: "tpl_1", params: { threshold: 30 } }
    const { requests } = await call(createAutomation, input)
    expect(requests.at(-1)?.body).toEqual({
      name: "alert",
      template: "tpl_1",
      params: { threshold: 30 }
    })
  })

  it("refuses both a payload and a template", async () => {
    const input = { name: "x", payload: PAYLOAD, template: "tpl_1" }
    const { result, requests } = await call(createAutomation, input)
    expect(result).toMatchObject({
      ok: false,
      code: "usage",
      message: "payload and template are mutually exclusive"
    })
    expect(requests).toEqual([])
  })

  it("refuses neither a payload nor a template", async () => {
    const { result } = await call(createAutomation, { name: "x" })
    expect(result).toMatchObject({
      ok: false,
      code: "usage",
      message: "one of payload or template is required"
    })
  })

  it("rejects a payload without a chain", async () => {
    const input = { name: "x", payload: { trigger: PAYLOAD.trigger } }
    expect((await call(createAutomation, input)).result).toMatchObject({ code: "usage" })
  })

  it("plans a create on a dry run", async () => {
    const input = { name: "hourly", payload: PAYLOAD, dryRun: true }
    const { result, requests } = await call(createAutomation, input)
    planned(result, "POST", "/v1/teams/team_1/automations")
    expect(requests.some((r) => r.method === "POST")).toBe(false)
  })

  it("fetches an automation", async () => {
    const { result } = await call(getAutomation, { automationId: "auto_1" })
    expect(result).toMatchObject({ ok: true, data: { id: "auto_1", enabled: true } })
  })

  it("updates only the fields given", async () => {
    const input = {
      automationId: "auto_1",
      name: "daily",
      enabled: false,
      spaceId: "spc_1",
      payload: PAYLOAD
    }
    const { result, requests } = await call(updateAutomation, input)
    expect(result).toMatchObject({ ok: true, data: { id: "auto_1" } })
    expect(requests.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/v1/teams/team_1/automations/auto_1",
      body: { name: "daily", enabled: false, spaceId: "spc_1", payload: PAYLOAD }
    })
    const retemplate = { automationId: "auto_1", template: "tpl_1", params: { threshold: 1 } }
    const { requests: again } = await call(updateAutomation, retemplate)
    expect(again.at(-1)?.body).toEqual({ template: "tpl_1", params: { threshold: 1 } })
  })

  it("refuses an update with both a payload and a template", async () => {
    const input = { automationId: "auto_1", payload: PAYLOAD, template: "tpl_1" }
    expect((await call(updateAutomation, input)).result).toMatchObject({ code: "usage" })
  })

  it("plans an update on a dry run", async () => {
    const input = { automationId: "auto_1", enabled: true, dryRun: true }
    planned(
      (await call(updateAutomation, input)).result,
      "PATCH",
      "/v1/teams/team_1/automations/auto_1"
    )
  })

  it("deletes an automation, and plans it on a dry run", async () => {
    const { result } = await call(deleteAutomation, { automationId: "auto_1" })
    expect(result).toEqual({ ok: true })
    const dry = await call(deleteAutomation, { automationId: "auto_1", dryRun: true })
    planned(dry.result, "DELETE", "/v1/teams/team_1/automations/auto_1")
    expect(dry.requests.some((r) => r.method === "DELETE")).toBe(false)
  })

  it("queues a manual run, and plans it on a dry run", async () => {
    const { result } = await call(runAutomation, { automationId: "auto_1" })
    expect(result).toMatchObject({ ok: true, data: { id: "run_1" } })
    const dry = await call(runAutomation, { automationId: "auto_1", dryRun: true })
    planned(dry.result, "POST", "/v1/teams/team_1/automations/auto_1/runs")
  })

  it("lists an automation's runs", async () => {
    const { result } = await call(listAutomationRuns, { automationId: "auto_1", page: 1, limit: 5 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "run_1", status: "queued" }] } })
    expect((await call(listAutomationRuns, { automationId: "auto_1" })).result.ok).toBe(true)
  })

  it("rejects a runs list without an automation", async () => {
    expect((await call(listAutomationRuns, {})).result).toMatchObject({ code: "usage" })
  })

  it("lists a device's templates", async () => {
    const { result, requests } = await call(listAutomationTemplates, { deviceId: "dev_1" })
    expect(result).toMatchObject({ ok: true, data: [{ id: "tpl_1" }] })
    expect(requests.at(-1)?.path).toBe("/v1/teams/team_1/devices/dev_1/automation-templates")
  })

  it("fires a trigger with its secret, not the API token", async () => {
    const input = { secret: "qma_s", context: { reading: 31 } }
    const { result, requests, auth } = await call(triggerAutomation, input)
    expect(result).toMatchObject({ ok: true, data: { runId: "run_2" } })
    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1/automations/trigger",
        body: { reading: 31 }
      })
    ])
    expect(auth).toEqual(["Bearer qma_s"])
  })

  it("fires a trigger with no body when the context is empty", async () => {
    const { requests } = await call(triggerAutomation, { secret: "qma_s", context: {} })
    expect(requests.at(-1)).not.toHaveProperty("body")
    const { requests: none } = await call(triggerAutomation, { secret: "qma_s" })
    expect(none.at(-1)).not.toHaveProperty("body")
  })

  it("plans a trigger on a dry run", async () => {
    const dry = await call(triggerAutomation, { secret: "qma_s", dryRun: true })
    planned(dry.result, "POST", "/v1/automations/trigger")
    expect(dry.requests).toEqual([])
  })

  it("rejects a trigger without a secret", async () => {
    expect((await call(triggerAutomation, { secret: "" })).result).toMatchObject({ code: "usage" })
  })

  it("issues a trigger secret, and plans it on a dry run", async () => {
    const { result } = await call(createAutomationTriggerSecret, { automationId: "auto_1" })
    expect(result).toMatchObject({ ok: true, data: { secret: "qma_s" } })
    const dry = await call(createAutomationTriggerSecret, { automationId: "auto_1", dryRun: true })
    planned(dry.result, "POST", "/v1/teams/team_1/automations/auto_1/trigger-secret")
  })
})
