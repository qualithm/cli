import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import { getBillingSummary, listInvoices, previewTierChange } from "../../tools/billing.ts"
import type { Tool } from "../../tools/tool.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const at = "2026-01-01T00:00:00.000Z"
const money = { amount: 1900, currency: "usd" }

const ROUTES = {
  ...DEFAULT_ROUTES,
  "GET /v1/teams/team_1/billing/summary": {
    status: 200,
    body: { data: { tier: "plus", month: "2026-01", limitGrace: null, monthlyTotal: money } }
  },
  "GET /v1/teams/team_1/invoices": {
    status: 200,
    body: {
      data: {
        current: 1,
        last: 1,
        items: [
          {
            id: "inv_1",
            teamId: "team_1",
            status: "paid",
            total: money,
            stripeInvoiceId: "in_1",
            createdAt: at,
            updatedAt: at
          }
        ]
      }
    }
  },
  "POST /v1/teams/team_1/billing/tier/preview": {
    status: 200,
    body: { data: { from: "plus", to: "pro", amountDue: money, nextPaymentAttempt: null } }
  }
}

async function call(
  tool: Tool,
  input: unknown
): Promise<{
  result: Awaited<ReturnType<typeof callTool>>
  requests: ReturnType<typeof fakePlatform>["requests"]
  urls: URL[]
}> {
  const { fetch, requests } = fakePlatform(ROUTES)
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
  return { result, requests, urls }
}

describe("get_billing_summary", () => {
  it("reads the team's billing summary", async () => {
    const { result } = await call(getBillingSummary, {})
    expect(result).toMatchObject({ ok: true, data: { tier: "plus", monthlyTotal: money } })
  })
})

describe("list_invoices", () => {
  it("lists the team's invoices with their Stripe ids", async () => {
    const { result, urls } = await call(listInvoices, { cursor: "cur_1", limit: 10 })
    expect(result).toMatchObject({
      ok: true,
      data: { items: [{ id: "inv_1", stripeInvoiceId: "in_1", total: money }] }
    })
    expect(urls.at(-1)?.search).toBe("?limit=10&cursor=cur_1")
  })
})

describe("preview_tier_change", () => {
  it("prices a tier change", async () => {
    const { result, requests } = await call(previewTierChange, { tier: "pro" })
    expect(result).toMatchObject({ ok: true, data: { from: "plus", to: "pro", amountDue: money } })
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/teams/team_1/billing/tier/preview",
      body: { tier: "pro" }
    })
  })

  it("rejects a tier that isn't a paid tier", async () => {
    const { result, requests } = await call(previewTierChange, { tier: "free" })
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(requests).toEqual([])
  })
})
