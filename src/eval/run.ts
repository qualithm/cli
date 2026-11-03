import type { Friction, Report, Step } from "./report.ts"

/** Calls one MCP tool and returns its envelope's data. */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>

/** What claiming a device returns: enough to connect it. */
export type ClaimedDevice = { deviceId: string }

/** The device side of the eval, as a builder's device would do it. */
export type DeviceDriver = {
  /** Exchanges a claim code for a device credential. */
  claim: (code: string, name: string) => Promise<ClaimedDevice>
  /** Connects the claimed device and publishes one telemetry reading. */
  publishTelemetry: (metric: string, value: number, tsMs: number) => Promise<void>
}

/** Eval settings; every field has a production default. */
export type EvalConfig = {
  /** The zone for a new scope when the team has none; empty asks list_zones for an open one. */
  zone?: string
  /** How long to wait for the published reading to read back. */
  verifyTimeoutMs?: number
  /** How long to wait between read-back attempts. */
  pollIntervalMs?: number
  /** The clock; tests replace it. */
  now?: () => number
  /** Waits; tests replace it. */
  sleep?: (ms: number) => Promise<void>
}

const METRIC = "agent_eval"

type Page = { items?: { id?: string }[] }
type Zones = { zones?: { id?: string; open?: boolean }[] }
type EnrollmentCode = { enrollment?: { id?: string }; code?: string }
type Point = { value?: number | null }

function reason(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error)
}

/** A step's failure, carrying what an agent would read. */
class StepError extends Error {
  override readonly name = "StepError"
}

/**
 * Runs the agent path end to end: find or create a scope, create an enrollment, claim a device,
 * publish a reading, read it back, then delete what it made. Never throws: each failure is a
 * failed step in the report.
 *
 * @param tools - calls the MCP server's tools
 * @param device - claims and connects the device
 * @param config - zone, timeouts and the clock
 * @returns the report
 */
export async function runEval(
  tools: ToolCaller,
  device: DeviceDriver,
  config: EvalConfig = {}
): Promise<Report> {
  const now = config.now ?? Date.now
  const sleep =
    config.sleep ?? (async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const verifyTimeoutMs = config.verifyTimeoutMs ?? 60_000
  const pollIntervalMs = config.pollIntervalMs ?? 3_000
  const steps: Step[] = []
  const friction: Friction[] = []
  const startedAt = new Date(now()).toISOString()

  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const start = now()
    try {
      const detail = await fn()
      steps.push({ name, ok: true, durationMs: now() - start, detail })
      return true
    } catch (error) {
      steps.push({ name, ok: false, durationMs: now() - start, detail: reason(error) })
      return false
    }
  }
  const cleanup = async (tool: string, args: Record<string, unknown>): Promise<void> => {
    try {
      await tools(tool, args)
    } catch (error) {
      friction.push({ step: "cleanup", missing: `${tool} failed: ${reason(error)}` })
    }
  }

  const finish = (): Report => ({ ok: steps.every((s) => s.ok), startedAt, steps, friction })

  // Steps fill these in; an object, so the checks after each step see what its closure set.
  const state = { scopeId: "", needsScope: false, code: "", enrollmentId: "", deviceId: "" }
  const listed = await step("list_scopes", async () => {
    const page = (await tools("list_scopes", {})) as Page
    const first = page.items?.[0]?.id
    if (first === undefined) {
      state.needsScope = true
      return "no scopes yet"
    }
    state.scopeId = first
    return `scope ${first}`
  })
  if (!listed) {
    return finish()
  }

  if (state.needsScope) {
    let zone = config.zone ?? ""
    if (zone === "") {
      const found = await step("list_zones", async () => {
        const zones = (await tools("list_zones", {})) as Zones
        const open = zones.zones?.find((z) => z.open === true)?.id
        if (open === undefined) {
          throw new StepError("no open zone")
        }
        zone = open
        return `zone ${zone}`
      })
      if (!found) {
        return finish()
      }
    }
    const created = await step("create_scope", async () => {
      const scope = (await tools("create_scope", { name: "agent-eval", zone })) as { id?: string }
      state.scopeId = scope.id ?? ""
      return `scope ${state.scopeId}`
    })
    if (!created) {
      return finish()
    }
  }

  const enrolled = await step("create_enrollment", async () => {
    const out = (await tools("create_enrollment", {
      scopeId: state.scopeId,
      label: "agent-eval",
      expiresInMinutes: 15
    })) as EnrollmentCode
    if (out.code === undefined || out.code === "") {
      throw new StepError("create_enrollment returned no claim code")
    }
    state.code = out.code
    state.enrollmentId = out.enrollment?.id ?? ""
    return `enrollment ${state.enrollmentId}`
  })
  if (!enrolled) {
    return finish()
  }

  const claimed = await step("claim", async () => {
    const claimed = await device.claim(state.code, "agent-eval")
    state.deviceId = claimed.deviceId
    return `device ${claimed.deviceId}`
  })
  if (!claimed) {
    await cleanup("revoke_enrollment", { enrollmentId: state.enrollmentId })
    return finish()
  }

  const value = (now() % 1_000_000) / 100
  const publishedAt = now()
  const published = await step("connect_publish", async () => {
    await device.publishTelemetry(METRIC, value, publishedAt)
    return `published ${METRIC}=${String(value)}`
  })
  if (published) {
    await step("verify_telemetry", async () => {
      const deadline = now() + verifyTimeoutMs
      for (;;) {
        let lastError: unknown
        try {
          const telemetry = (await tools("get_telemetry", {
            deviceId: state.deviceId,
            metric: METRIC,
            from: new Date(publishedAt - 60_000).toISOString(),
            to: new Date(now() + 60_000).toISOString(),
            bucket: 60
          })) as { items?: Point[] }
          if ((telemetry.items ?? []).some((p) => p.value === value)) {
            return `read back ${METRIC}=${String(value)}`
          }
        } catch (error) {
          lastError = error
        }
        if (now() >= deadline) {
          if (lastError !== undefined) {
            throw new StepError(`get_telemetry kept failing: ${reason(lastError)}`)
          }
          throw new StepError(
            `no telemetry point with ${METRIC}=${String(value)} within ${String(verifyTimeoutMs)}ms`
          )
        }
        await sleep(pollIntervalMs)
      }
    })
  }
  await cleanup("delete_device", { deviceId: state.deviceId })
  return finish()
}
