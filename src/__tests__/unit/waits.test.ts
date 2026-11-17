import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { run } from "../../cli.ts"
import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import { TOOLS } from "../../tools/index.ts"
import type { Tool } from "../../tools/tool.ts"
import { waitForDevice, waitForEnrollment, waitPacing } from "../../tools/waits.ts"
import {
  capture,
  DEFAULT_ROUTES,
  DEVICE,
  ENROLLMENT,
  fakePlatform,
  type Reply,
  type Route
} from "./fake-platform.ts"

const STATES = "GET /v1/teams/team_1/device-states"
const ENROLLMENTS = "GET /v1/teams/team_1/enrollments"

const states = (items: unknown[], nextCursor: string | null = null): Reply => ({
  status: 200,
  body: { data: { items, current: 1, last: 1, total: items.length, limit: 100, nextCursor } }
})

const state = (deviceId: string, online: boolean): Record<string, unknown> => ({
  deviceId,
  scopeId: "spc_1",
  online,
  lastSeenAt: "2026-10-20T10:00:00.000Z",
  metrics: {}
})

const enrollments = (items: unknown[], nextCursor: string | null = null): Reply => ({
  status: 200,
  body: { data: { items, current: 1, last: 1, total: items.length, limit: 100, nextCursor } }
})

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PENDING = { ...ENROLLMENT, expiresAt: FUTURE }
const CLAIMED = {
  ...PENDING,
  status: "claimed",
  claimedDeviceId: "dev_1",
  claimedAt: "2026-10-01T01:00:00.000Z"
}

let slept: number[]
const pacing = { ...waitPacing }

beforeEach(() => {
  slept = []
  waitPacing.intervalMs = 5
  waitPacing.sleep = async (ms) => {
    slept.push(ms)
    await Promise.resolve()
  }
})

afterEach(() => {
  Object.assign(waitPacing, pacing)
})

async function call(
  tool: Tool,
  input: unknown,
  routes: Readonly<Record<string, Route>>
): Promise<{
  result: Awaited<ReturnType<typeof callTool>>
  requests: { method: string; path: string; search: string }[]
}> {
  const { fetch, requests } = fakePlatform({ ...DEFAULT_ROUTES, ...routes })
  const result = await callTool(
    tool,
    (dryRun) => new Session({ token: "qmt_x", fetch, dryRun }),
    input
  )
  return { result, requests }
}

describe("wait tools", () => {
  it("serves both over MCP", () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain("wait_for_device")
    expect(names).toContain("wait_for_enrollment")
  })
})

describe("wait_for_device", () => {
  it("returns the state once the device is online", async () => {
    const { result } = await call(
      waitForDevice,
      { deviceId: "dev_1" },
      {
        [STATES]: [states([]), states([state("dev_1", false)]), states([state("dev_1", true)])]
      }
    )
    expect(result).toMatchObject({ ok: true, data: { deviceId: "dev_1", online: true } })
    expect(slept).toHaveLength(2)
  })

  it("follows the cursor to find the device", async () => {
    const { result, requests } = await call(
      waitForDevice,
      { deviceId: "dev_1" },
      {
        [STATES]: [states([state("dev_2", true)], "c2"), states([state("dev_1", true)])]
      }
    )
    expect(result).toMatchObject({ ok: true, data: { deviceId: "dev_1" } })
    expect(requests.filter((r) => r.path.endsWith("/device-states")).at(-1)?.search).toContain(
      "cursor=c2"
    )
    expect(slept).toEqual([])
  })

  it("fails with code timeout when the device stays offline", async () => {
    const { result } = await call(
      waitForDevice,
      { deviceId: "dev_1", timeoutSeconds: 1 },
      { [STATES]: states([state("dev_1", false)]) }
    )
    expect(result).toMatchObject({ ok: false, code: "timeout" })
    expect(result.message).toContain("device dev_1 not online")
  }, 5000)

  it("fails with not_found for an unknown device without waiting", async () => {
    const { result } = await call(waitForDevice, { deviceId: "dev_9" }, {})
    expect(result).toMatchObject({ ok: false, code: "not_found" })
    expect(slept).toEqual([])
  })
})

describe("wait_for_enrollment", () => {
  it("returns the enrollment and the device that used its code", async () => {
    const { result } = await call(
      waitForEnrollment,
      { enrollmentId: "enr_1" },
      { [ENROLLMENTS]: [enrollments([PENDING]), enrollments([CLAIMED])] }
    )
    expect(result).toMatchObject({
      ok: true,
      data: { enrollment: { id: "enr_1", status: "claimed" }, device: { id: DEVICE.id } }
    })
    expect(slept).toHaveLength(1)
  })

  it("follows the cursor to find the enrollment", async () => {
    const { result } = await call(
      waitForEnrollment,
      { enrollmentId: "enr_1" },
      {
        [ENROLLMENTS]: [enrollments([{ ...PENDING, id: "enr_0" }], "c2"), enrollments([CLAIMED])]
      }
    )
    expect(result).toMatchObject({ ok: true, data: { enrollment: { id: "enr_1" } } })
  })

  it("fails with not_found for an unknown enrollment", async () => {
    const { result } = await call(
      waitForEnrollment,
      { enrollmentId: "enr_9" },
      { [ENROLLMENTS]: enrollments([PENDING]) }
    )
    expect(result).toMatchObject({ ok: false, code: "not_found" })
  })

  it.each([
    ["revoked", { ...PENDING, status: "revoked" }],
    ["expired", { ...PENDING, expiresAt: "2026-01-01T00:00:00.000Z" }]
  ])("fails with conflict when the code is %s", async (word, item) => {
    const { result } = await call(
      waitForEnrollment,
      { enrollmentId: "enr_1" },
      { [ENROLLMENTS]: enrollments([item]) }
    )
    expect(result).toMatchObject({ ok: false, code: "conflict" })
    expect(result.message).toBe(`claim code ${word}: create a new claim code`)
  })

  it("fails with code timeout when no device uses the code", async () => {
    const { result } = await call(
      waitForEnrollment,
      { enrollmentId: "enr_1", timeoutSeconds: 1 },
      { [ENROLLMENTS]: enrollments([PENDING]) }
    )
    expect(result).toMatchObject({ ok: false, code: "timeout" })
  }, 5000)
})

describe("wait commands", () => {
  it("prints an online device and exits 0", async () => {
    const c = capture({}, { ...DEFAULT_ROUTES, [STATES]: states([state("dev_1", true)]) })
    expect(await run(["device", "wait", "dev_1", "--timeout", "5"], c.io)).toBe(0)
    expect(c.out()).toBe("device dev_1 is online, last seen 2026-10-20T10:00:00.000Z\n")
  })

  it("exits 9 on a time-out", async () => {
    const c = capture({}, { ...DEFAULT_ROUTES, [STATES]: states([]) })
    expect(await run(["device", "wait", "dev_1", "--timeout", "1", "--json"], c.io)).toBe(9)
    expect(JSON.parse(c.out())).toMatchObject({ ok: false, code: "timeout" })
  }, 5000)

  it("prints the device that claimed an enrollment", async () => {
    const c = capture({}, { ...DEFAULT_ROUTES, [ENROLLMENTS]: enrollments([CLAIMED]) })
    expect(await run(["enrollment", "wait", "enr_1"], c.io)).toBe(0)
    expect(c.out()).toBe(`device dev_1 (${DEVICE.name}) used claim code enr_1\n`)
  })

  it("needs an id", async () => {
    const c = capture()
    expect(await run(["device", "wait"], c.io)).toBe(2)
    expect(await run(["enrollment", "wait"], c.io)).toBe(2)
  })
})
