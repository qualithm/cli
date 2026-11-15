import { AuditApi, EventsApi, TelemetryApi, UsageApi } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, pageInput, type Tool } from "./tool.ts"

/** How long `stream_events` reads when no timeout is given. */
const DEFAULT_STREAM_TIMEOUT_MS = 5000

/** One server-sent event from the team's live stream. */
type StreamedEvent = { type: string; data: unknown }

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * Builds a parser that takes one server-sent-event line at a time and returns an event when a
 * blank line completes one.
 *
 * @returns the line parser
 */
function eventParser(): (line: string) => StreamedEvent | undefined {
  let type: string | undefined
  let data: string | undefined
  return (line) => {
    if (line.startsWith("event:")) {
      type = line.slice("event:".length).trim()
    } else if (line.startsWith("data:")) {
      data = line.slice("data:".length).trim()
    } else if (line === "" && (type !== undefined || data !== undefined)) {
      const event = { type: type ?? "", data: data === undefined ? null : parseData(data) }
      type = undefined
      data = undefined
      return event
    }
    return undefined
  }
}

/**
 * Reads server-sent events from a stream until `limit` events have arrived, the stream ends, or
 * the read is aborted; an abort ends the read with the events collected so far.
 *
 * @param body - the response body
 * @param limit - the most events to read
 * @returns the events, in arrival order
 */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<StreamedEvent[]> {
  const events: StreamedEvent[] = []
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parse = eventParser()
  let buffered = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return events
      }
      const lines = (buffered + decoder.decode(value, { stream: true })).split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        const event = parse(line.endsWith("\r") ? line.slice(0, -1) : line)
        if (event !== undefined && events.push(event) >= limit) {
          return events
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return events
    }
    throw error
  }
}

/** Reads bucketed telemetry for one device metric. */
export const getTelemetry = defineTool({
  name: "get_telemetry",
  description: "Read bucketed telemetry points for a device metric over a time range.",
  mutating: false,
  operations: ["listTelemetry"],
  input: {
    deviceId: z.string().min(1).describe("id of the device to read telemetry for"),
    metric: z.string().min(1).describe("metric name to read"),
    from: z.iso.datetime({ offset: true }).describe("range start, RFC 3339, inclusive"),
    to: z.iso.datetime({ offset: true }).describe("range end, RFC 3339, exclusive"),
    bucket: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("bucket width in seconds; 0 uses the server default"),
    agg: z
      .string()
      .min(1)
      .optional()
      .describe("bucket aggregate: avg, min, max, sum, count; default avg"),
    fillLocf: z
      .boolean()
      .optional()
      .describe("carry the last observation forward across empty buckets")
  },
  run: async (session, input) => {
    const { deviceId, metric, from, to, bucket, agg, fillLocf } = input
    const teamId = await session.teamId()
    const { data } = await session.client.api(TelemetryApi).listTelemetry({
      teamId,
      deviceId,
      metric,
      from: new Date(from),
      to: new Date(to),
      ...(bucket === undefined || bucket === 0 ? {} : { bucket: String(bucket) }),
      ...(agg === undefined ? {} : { agg }),
      ...(fillLocf === true ? { fill: "locf" } : {})
    })
    return data
  }
})

/** Reads a bounded batch from the team's live event stream. */
export const streamEvents = defineTool({
  name: "stream_events",
  description:
    "Read a bounded batch from the team's live event stream; returns after limit events or the timeout.",
  mutating: false,
  operations: ["streamEvents"],
  input: {
    limit: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("maximum number of events to read; 0 reads a single event"),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("give up after this many milliseconds; 0 uses a 5s default")
  },
  run: async (session, input) => {
    const limit = input.limit === undefined || input.limit === 0 ? 1 : input.limit
    const timeoutMs =
      input.timeoutMs === undefined || input.timeoutMs === 0
        ? DEFAULT_STREAM_TIMEOUT_MS
        : input.timeoutMs
    const teamId = await session.teamId()
    // Aborting closes the stream once the read ends, whether by limit or by timeout. A plain timer,
    // not AbortSignal.any with AbortSignal.timeout: Node 20 can garbage-collect that timeout signal
    // before it fires, and the read never ends.
    const done = new AbortController()
    const { signal } = done
    const timer = setTimeout(() => {
      done.abort()
    }, timeoutMs)
    try {
      const { raw } = await session.client
        .api(EventsApi)
        .streamEventsRaw({ teamId }, async ({ init }) => {
          await Promise.resolve()
          return { headers: { ...init.headers, Accept: "text/event-stream" }, signal }
        })
      return raw.body === null ? [] : await readEvents(raw.body, limit)
    } finally {
      clearTimeout(timer)
      done.abort()
    }
  }
})

/** Reads the team's usage against its plan limits. */
export const getUsage = defineTool({
  name: "get_usage",
  description: "Read the team's current usage against its plan limits.",
  mutating: false,
  operations: ["getUsage"],
  input: {},
  run: async (session) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(UsageApi).getUsage({ teamId })
    return data
  }
})

/** Lists the team's audit-trail events. */
export const getAuditLog = defineTool({
  name: "get_audit_log",
  description: "List audit-trail events for the token's team.",
  mutating: false,
  operations: ["listAuditEvents"],
  input: { ...pageInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(AuditApi).listAuditEvents({ teamId, ...input })
    return data
  }
})

/** Observability tools: telemetry, events, usage and the audit log. */
export const observabilityTools: readonly Tool[] = [
  getTelemetry,
  streamEvents,
  getUsage,
  getAuditLog
]
