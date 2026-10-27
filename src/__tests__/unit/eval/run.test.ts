import { describe, expect, it } from "vitest"

import { renderReport } from "../../../eval/report.ts"
import { type DeviceDriver, runEval, type ToolCaller } from "../../../eval/run.ts"

type Calls = { name: string; args: Record<string, unknown> }[]

const NOW = 1_700_000_123_456
const VALUE = (NOW % 1_000_000) / 100

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = NOW
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
      await Promise.resolve()
    }
  }
}

function tools(
  replies: Record<string, unknown>,
  calls: Calls = []
): { call: ToolCaller; calls: Calls } {
  const call: ToolCaller = async (name, args) => {
    calls.push({ name, args })
    await Promise.resolve()
    const reply = replies[name]
    if (reply instanceof Error) {
      throw reply
    }
    return typeof reply === "function" ? (reply as () => unknown)() : reply
  }
  return { call, calls }
}

const HAPPY: Record<string, unknown> = {
  list_spaces: { items: [{ id: "spc_1" }] },
  create_enrollment: { enrollment: { id: "enr_1" }, code: "QM-1" },
  get_telemetry: { items: [{ ts: NOW, value: VALUE }] },
  delete_device: undefined,
  revoke_enrollment: undefined
}

function device(overrides: Partial<DeviceDriver> = {}): DeviceDriver & { published: unknown[] } {
  const published: unknown[] = []
  return {
    claim: async () => Promise.resolve({ deviceId: "dev_1" }),
    publishTelemetry: async (metric, value, ts) => {
      published.push({ metric, value, ts })
      await Promise.resolve()
    },
    ...overrides,
    published
  }
}

describe("runEval", () => {
  it("passes the whole path and cleans up the device", async () => {
    const t = tools(HAPPY)
    const d = device()
    const report = await runEval(t.call, d, clock())
    expect(report.ok).toBe(true)
    expect(report.steps.map((s) => s.name)).toEqual([
      "list_spaces",
      "create_enrollment",
      "claim",
      "connect_publish",
      "verify_telemetry"
    ])
    expect(report.friction).toEqual([])
    expect(d.published).toEqual([{ metric: "agent_eval", value: VALUE, ts: NOW }])
    expect(t.calls.find((c) => c.name === "create_enrollment")?.args).toEqual({
      spaceId: "spc_1",
      label: "agent-eval",
      expiresInMinutes: 15
    })
    expect(t.calls.find((c) => c.name === "get_telemetry")?.args).toMatchObject({
      deviceId: "dev_1",
      metric: "agent_eval",
      from: new Date(NOW - 60_000).toISOString(),
      bucket: 60
    })
    expect(t.calls.at(-1)).toEqual({ name: "delete_device", args: { deviceId: "dev_1" } })
  })

  it("creates a space in the first open zone when the team has none", async () => {
    const t = tools({
      ...HAPPY,
      list_spaces: { items: [] },
      list_zones: {
        zones: [
          { id: "de-fra-a", open: false },
          { id: "sg-sin-a", open: true }
        ]
      },
      create_space: { id: "spc_new" }
    })
    const report = await runEval(t.call, device(), clock())
    expect(report.ok).toBe(true)
    expect(t.calls.find((c) => c.name === "create_space")?.args).toEqual({ zone: "sg-sin-a" })
    expect(report.steps[2]).toMatchObject({ name: "create_space", detail: "space spc_new" })
  })

  it("uses the configured zone without asking", async () => {
    const t = tools({ ...HAPPY, list_spaces: {}, create_space: {} })
    const report = await runEval(t.call, device(), { ...clock(), zone: "de-fra-a" })
    expect(t.calls.some((c) => c.name === "list_zones")).toBe(false)
    expect(report.steps[1]).toMatchObject({ name: "create_space", ok: true, detail: "space " })
  })

  it.each([
    ["list_spaces", { list_spaces: new Error("list_spaces: auth: no") }],
    ["list_zones", { list_spaces: { items: [] }, list_zones: { zones: [] } }],
    [
      "create_space",
      {
        list_spaces: { items: [] },
        list_zones: { zones: [{ id: "z", open: true }] },
        create_space: new Error("boom")
      }
    ],
    ["create_enrollment", { create_enrollment: { enrollment: { id: "enr_1" } } }]
  ])("stops at a failed %s", async (name, replies) => {
    const report = await runEval(tools({ ...HAPPY, ...replies }).call, device(), clock())
    expect(report.ok).toBe(false)
    expect(report.steps.at(-1)).toMatchObject({ name, ok: false })
  })

  it("revokes the enrollment when the claim fails, logging a failed cleanup as friction", async () => {
    const t = tools({ ...HAPPY, revoke_enrollment: new Error("revoke_enrollment: api: down") })
    const d = device({ claim: async () => Promise.reject(new Error("claim code expired")) })
    const report = await runEval(t.call, d, clock())
    expect(report.steps.at(-1)).toMatchObject({
      name: "claim",
      ok: false,
      detail: "claim code expired"
    })
    expect(t.calls.at(-1)).toEqual({ name: "revoke_enrollment", args: { enrollmentId: "enr_1" } })
    expect(report.friction).toEqual([
      { step: "cleanup", missing: "revoke_enrollment failed: revoke_enrollment: api: down" }
    ])
  })

  it("deletes the device when publishing fails", async () => {
    const t = tools(HAPPY)
    const d = device({
      publishTelemetry: async () => Promise.reject(new Error("mqtt connect timed out"))
    })
    const report = await runEval(t.call, d, clock())
    expect(report.steps.at(-1)).toMatchObject({ name: "connect_publish", ok: false })
    expect(t.calls.at(-1)?.name).toBe("delete_device")
  })

  it("polls until the reading appears", async () => {
    let polls = 0
    const telemetry = (): unknown => {
      polls += 1
      return { items: polls < 3 ? [] : [{ value: VALUE }] }
    }
    const t = tools({ ...HAPPY, get_telemetry: telemetry })
    const report = await runEval(t.call, device(), { ...clock(), pollIntervalMs: 1_000 })
    expect(report.ok).toBe(true)
    expect(polls).toBe(3)
  })

  it("fails verify when the reading never appears, or reading keeps failing", async () => {
    const missing = await runEval(tools({ ...HAPPY, get_telemetry: {} }).call, device(), {
      ...clock(),
      verifyTimeoutMs: 5_000
    })
    expect(missing.steps.at(-1)).toMatchObject({
      name: "verify_telemetry",
      ok: false,
      detail: `no telemetry point with agent_eval=${String(VALUE)} within 5000ms`
    })
    const failing = await runEval(
      tools({ ...HAPPY, get_telemetry: new Error("get_telemetry: unavailable: busy") }).call,
      device(),
      { ...clock(), verifyTimeoutMs: 5_000 }
    )
    expect(failing.steps.at(-1)?.detail).toBe(
      "get_telemetry kept failing: get_telemetry: unavailable: busy"
    )
  })

  it("reports a thrown non-error by its JSON", async () => {
    const t = tools(HAPPY)
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a tool may reject with a non-Error
    t.call = async () => Promise.reject({ status: 500 })
    const report = await runEval(t.call, device(), clock())
    expect(report.steps[0]?.detail).toBe('{"status":500}')
  })

  it("defaults the clock and timeouts", async () => {
    let published = 0
    const telemetry = (): unknown => ({ items: [{ value: published }] })
    const d = device({
      publishTelemetry: async (_metric, value) => {
        published = value
        await Promise.resolve()
      }
    })
    const report = await runEval(tools({ ...HAPPY, get_telemetry: telemetry }).call, d)
    expect(report.ok).toBe(true)
  })
})

describe("renderReport", () => {
  it("renders steps and the friction log", () => {
    expect(
      renderReport({
        ok: false,
        startedAt: "2026-10-27T00:00:00.000Z",
        steps: [
          { name: "list_spaces", ok: true, durationMs: 12, detail: "space spc_1" },
          { name: "claim", ok: false, durationMs: 3, detail: "" }
        ],
        friction: [{ step: "cleanup", missing: "delete_device failed" }]
      })
    ).toBe(
      [
        "agent-eval FAIL (2026-10-27T00:00:00.000Z)",
        "",
        "Steps:",
        "- [ok] list_spaces (12ms): space spc_1",
        "- [FAIL] claim (3ms)",
        "",
        "Friction log (steps the agent had to supply information the surfaces did not provide):",
        "- cleanup: delete_device failed",
        ""
      ].join("\n")
    )
  })

  it("says none when nothing was missing", () => {
    expect(renderReport({ ok: true, startedAt: "t", steps: [], friction: [] })).toContain(
      "agent-eval PASS (t)"
    )
    expect(renderReport({ ok: true, startedAt: "t", steps: [], friction: [] })).toContain(
      "- none\n"
    )
  })
})
