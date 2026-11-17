import { describe, expect, it } from "vitest"

import { run } from "../../cli.ts"
import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import { listAutomationRuns } from "../../tools/automations.ts"
import { capture, DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const QUIET = {
  id: "run_1",
  automationId: "auto_1",
  triggerType: "manual",
  status: "skipped",
  steps: [],
  lastError: null,
  triggeredAt: "2026-10-01T00:00:00.000Z",
  executedAt: null
}

const FIRED = {
  ...QUIET,
  id: "run_2",
  triggerType: "event",
  status: "succeeded",
  decisions: [
    {
      key: "channel",
      label: "Channel",
      value: "push",
      source: "automation",
      docsUrl: "https://docs.qualithm.com/notifications"
    }
  ]
}

const ROUTES = {
  ...DEFAULT_ROUTES,
  "GET /v1/teams/team_1/automations/auto_1/runs": {
    status: 200,
    body: { data: { items: [QUIET, FIRED], current: 1, last: 1, total: 2, limit: 20 } }
  }
}

describe("qualithm automation runs", () => {
  it("lists runs and prints a fired alert's decisions", async () => {
    const c = capture({}, ROUTES)

    expect(await run(["automation", "runs", "auto_1"], c.io)).toBe(0)

    const out = c.out()
    expect(out).toMatch(/^ID\s+OUTCOME\s+TRIGGER\s+TRIGGERED\n/)
    expect(out).toMatch(/run_1\s+skipped\s+manual/)
    expect(out).toMatch(/run_2\s+succeeded\s+event/)
    expect(out).toContain(
      "\nDecided for run run_2\nChannel  push  https://docs.qualithm.com/notifications\n"
    )
    expect(out).not.toContain("Decided for run run_1")
  })

  it("accepts the plural resource name", async () => {
    const c = capture({}, ROUTES)

    expect(await run(["automations", "runs", "auto_1"], c.io)).toBe(0)
    expect(c.out()).toContain("run_2")
  })

  it("returns the same data as list_automation_runs with --json", async () => {
    const c = capture({}, ROUTES)
    expect(await run(["automation", "runs", "auto_1", "--json"], c.io)).toBe(0)

    const fake = fakePlatform(ROUTES)
    const tool = await callTool(
      listAutomationRuns,
      (dryRun) => new Session({ token: "qmt_x", fetch: fake.fetch, dryRun }),
      { automationId: "auto_1" }
    )
    // The envelope is the tool's result as JSON: dates become strings, unset fields drop out.
    expect(JSON.parse(c.out())).toEqual(JSON.parse(JSON.stringify(tool)))
  })

  it("asks for the automation id", async () => {
    const c = capture({}, ROUTES)

    expect(await run(["automation", "runs"], c.io)).toBe(2)
  })
})
