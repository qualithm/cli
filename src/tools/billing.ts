import { BillingApi, PreviewTierChangeRequestTierEnum } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, pageInput, type Tool } from "./tool.ts"

const tiers = Object.values(PreviewTierChangeRequestTierEnum) as [
  PreviewTierChangeRequestTierEnum,
  ...PreviewTierChangeRequestTierEnum[]
]

/** Reads the team's billing state for the current month. */
export const getBillingSummary = defineTool({
  name: "get_billing_summary",
  description:
    "Read the team's billing state for the current month: tier, limits, usage per dimension, and add-ons.",
  mutating: false,
  operations: ["getBillingSummary"],
  input: {},
  run: async (session) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(BillingApi).getBillingSummary({ teamId })
    return data
  }
})

/** Lists the team's invoices. */
export const listInvoices = defineTool({
  name: "list_invoices",
  description: "List the team's invoices.",
  mutating: false,
  operations: ["listInvoices"],
  input: { ...pageInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(BillingApi).listInvoices({ teamId, ...input })
    return data
  }
})

/**
 * Prices a tier change without applying it. Read-only despite the POST, so it takes no `dryRun`:
 * money-moving billing operations stay human-only.
 */
export const previewTierChange = defineTool({
  name: "preview_tier_change",
  description: "Price a move to a paid tier without applying it. Read-only.",
  mutating: false,
  operations: ["previewTierChange"],
  input: { tier: z.enum(tiers).describe("target paid tier to price") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(BillingApi)
      .previewTierChange({ teamId, previewTierChangeRequest: { tier: input.tier } })
    return data
  }
})

/** Billing tools. */
export const billingTools: readonly Tool[] = [getBillingSummary, listInvoices, previewTierChange]
