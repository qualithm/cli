import type { FetchAPI } from "../../platform.ts"

/** One request the fake platform received. */
export type Recorded = { method: string; path: string; userAgent: string | null; body?: unknown }

/** A route's reply: a status and a JSON body. */
export type Reply = { status: number; body?: unknown }

const team = (id: string): Record<string, unknown> => ({
  id,
  accountId: "acc_1",
  name: id,
  slug: id,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
})

/** A token as the API returns it. */
export const TOKEN = {
  id: "tok_1",
  accountId: "acc_1",
  teamId: "team_1",
  name: "ci",
  status: "active",
  role: null,
  expiresAt: null,
  lastUsedAt: "2026-10-20T10:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
}

const page = (items: unknown[]): Record<string, unknown> => ({
  data: { items, current: 1, last: 1, total: items.length, limit: 20 }
})

/** The default routes: one team, one token. */
export const DEFAULT_ROUTES: Readonly<Record<string, Reply>> = {
  "GET /v1/teams": { status: 200, body: page([team("team_1")]) },
  "GET /v1/teams/team_1/api-tokens": { status: 200, body: page([TOKEN]) },
  "DELETE /v1/teams/team_1/api-tokens/tok_1": { status: 204 }
}

/**
 * A `fetch` that answers from a route table and records every request.
 *
 * @param routes - replies by `METHOD /path`; unknown routes get a 404 envelope
 * @returns the `fetch` and the requests it saw
 */
export function fakePlatform(routes: Readonly<Record<string, Reply>> = DEFAULT_ROUTES): {
  fetch: FetchAPI
  requests: Recorded[]
} {
  const requests: Recorded[] = []
  const fetch: FetchAPI = async (input, init) => {
    await Promise.resolve()
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = new Headers(init?.headers)
    requests.push({
      method,
      path: url.pathname,
      userAgent: headers.get("User-Agent"),
      ...(typeof init?.body === "string" && init.body !== ""
        ? { body: JSON.parse(init.body) as unknown }
        : {})
    })
    const reply = routes[`${method} ${url.pathname}`] ?? {
      status: 404,
      body: { message: "not found", code: "not_found" }
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" }
    })
  }
  return { fetch, requests }
}
