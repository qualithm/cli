import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { type FetchAPI, Session } from "../../platform.ts"
import {
  getAuditLog,
  getTelemetry,
  getUsage,
  observabilityTools,
  streamEvents
} from "../../tools/observability.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const ROUTES = {
  ...DEFAULT_ROUTES,
  "GET /v1/teams/team_1/devices/dev_1/telemetry": {
    status: 200,
    body: { data: { items: [{ ts: 1000, value: 2.5 }] } }
  },
  "GET /v1/teams/team_1/usage": {
    status: 200,
    body: { data: { deviceTotal: 3, deviceMax: 10, spaceTotal: 2 } }
  },
  "GET /v1/teams/team_1/audit-events": {
    status: 200,
    body: {
      data: { items: [{ id: "aud_1", action: "device.create" }], current: 1, last: 1, total: 1 }
    }
  }
}

const EVENTS_PATH = "/v1/teams/team_1/events"

/** Answers the event stream with `events`, everything else from the route table. */
type EventsReply = (init: RequestInit | undefined) => Response | Promise<Response>

function platform(events?: EventsReply): {
  newSession: (dryRun: boolean) => Session
  urls: URL[]
  inits: (RequestInit | undefined)[]
} {
  const fake = fakePlatform(ROUTES)
  const urls: URL[] = []
  const inits: (RequestInit | undefined)[] = []
  const fetch: FetchAPI = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    urls.push(url)
    inits.push(init)
    return events !== undefined && url.pathname === EVENTS_PATH
      ? events(init)
      : fake.fetch(input, init)
  }
  return { newSession: (dryRun) => new Session({ token: "qmt_x", fetch, dryRun }), urls, inits }
}

/** A stream that sends `chunks`, then stays open until the request is aborted. */
function openStream(chunks: string[], signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      signal?.addEventListener("abort", () => {
        controller.error(signal.reason)
      })
    }
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

describe("observability tools", () => {
  it("registers in Go order", () => {
    expect(observabilityTools.map((t) => t.name)).toEqual([
      "get_telemetry",
      "stream_events",
      "get_usage",
      "get_audit_log"
    ])
  })
})

describe("get_telemetry", () => {
  const range = { deviceId: "dev_1", metric: "temp", from: "2026-10-01T00:00:00Z" }

  it("reads bucketed points with every option", async () => {
    const { newSession, urls } = platform()
    const result = await callTool(getTelemetry, newSession, {
      ...range,
      to: "2026-10-01T01:00:00+01:00",
      bucket: 60,
      agg: "max",
      fillLocf: true
    })
    expect(result).toEqual({ ok: true, data: { items: [{ ts: 1000, value: 2.5 }] } })
    const url = urls.at(-1)
    expect(url?.pathname).toBe("/v1/teams/team_1/devices/dev_1/telemetry")
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      metric: "temp",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      bucket: "60",
      agg: "max",
      fill: "locf"
    })
  })

  it("leaves the server defaults to the server", async () => {
    const { newSession, urls } = platform()
    await callTool(getTelemetry, newSession, { ...range, to: "2026-10-01T01:00:00Z", bucket: 0 })
    expect([...(urls.at(-1)?.searchParams.keys() ?? [])].sort()).toEqual(["from", "metric", "to"])
  })

  it("rejects a time that isn't RFC 3339", async () => {
    const { newSession, urls } = platform()
    const result = await callTool(getTelemetry, newSession, { ...range, to: "yesterday" })
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(result.message).toMatch(/^to: /)
    expect(urls).toEqual([])
  })
})

describe("stream_events", () => {
  it("returns after the first event by default", async () => {
    const { newSession, inits } = platform((init) =>
      openStream(
        [
          'event: device.connected\ndata: {"deviceId":"dev_1"}\n\n',
          "event: device.disconnected\n\n"
        ],
        init?.signal
      )
    )
    const result = await callTool(streamEvents, newSession, {})
    expect(result).toEqual({
      ok: true,
      data: [{ type: "device.connected", data: { deviceId: "dev_1" } }]
    })
    expect(new Headers(inits.at(-1)?.headers).get("Accept")).toBe("text/event-stream")
    expect(new Headers(inits.at(-1)?.headers).get("Authorization")).toBe("Bearer qmt_x")
  })

  it("reads up to limit events split across chunks", async () => {
    const { newSession } = platform((init) =>
      openStream(
        ["event: a\r\nda", "ta: not json\r\n\r\n: comment\n\ndata: 2\n\n", "event: c\n\n"],
        init?.signal
      )
    )
    const result = await callTool(streamEvents, newSession, { limit: 2, timeoutMs: 1000 })
    expect(result.data).toEqual([
      { type: "a", data: "not json" },
      { type: "", data: 2 }
    ])
  })

  it("returns what arrived when the timeout ends the read", async () => {
    const { newSession } = platform((init) => openStream(["event: a\n\n"], init?.signal))
    const result = await callTool(streamEvents, newSession, { limit: 5, timeoutMs: 20 })
    expect(result).toEqual({ ok: true, data: [{ type: "a", data: null }] })
  })

  it("returns what arrived when the stream ends", async () => {
    const { newSession } = platform(() => new Response("event: a\n\nevent: b", { status: 200 }))
    const result = await callTool(streamEvents, newSession, { limit: 5 })
    expect(result.data).toEqual([{ type: "a", data: null }])
  })

  it("returns no events for an empty body", async () => {
    const { newSession } = platform(() => new Response(null, { status: 200 }))
    expect(await callTool(streamEvents, newSession, {})).toEqual({ ok: true, data: [] })
  })

  it("fails when the stream breaks", async () => {
    const { newSession } = platform(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection reset"))
        }
      })
      return new Response(body, { status: 200 })
    })
    expect(await callTool(streamEvents, newSession, {})).toEqual({
      ok: false,
      code: "error",
      message: "connection reset"
    })
  })

  it("fails when the timeout passes before the stream opens", async () => {
    const { newSession } = platform(
      async (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error)
          })
        })
    )
    const result = await callTool(streamEvents, newSession, { timeoutMs: 10 })
    expect(result).toMatchObject({ ok: false, code: "error" })
  })

  it("reports a refused stream with the API's code", async () => {
    const { newSession } = platform(
      () =>
        new Response(JSON.stringify({ message: "forbidden", code: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        })
    )
    expect(await callTool(streamEvents, newSession, {})).toMatchObject({
      ok: false,
      code: "auth",
      message: "forbidden"
    })
  })

  it("rejects a negative timeout", async () => {
    const { newSession } = platform()
    expect(await callTool(streamEvents, newSession, { timeoutMs: -1 })).toMatchObject({
      ok: false,
      code: "usage"
    })
  })
})

describe("get_usage", () => {
  it("reads the team's usage", async () => {
    const { newSession, urls } = platform()
    expect(await callTool(getUsage, newSession, {})).toEqual({
      ok: true,
      data: { deviceTotal: 3, deviceMax: 10, spaceTotal: 2 }
    })
    expect(urls.at(-1)?.pathname).toBe("/v1/teams/team_1/usage")
  })
})

describe("get_audit_log", () => {
  it("lists the team's audit events", async () => {
    const { newSession, urls } = platform()
    const result = await callTool(getAuditLog, newSession, { cursor: "cur_2", limit: 10 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "aud_1" }] } })
    expect(urls.at(-1)?.pathname).toBe("/v1/teams/team_1/audit-events")
    expect(urls.at(-1)?.search).toBe("?limit=10&cursor=cur_2")
  })
})
