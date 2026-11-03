import type { CliIo } from "../../cli.ts"
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
/** An authority as the API returns it. */
export const AUTHORITY = {
  id: "ca_1",
  teamId: "team_1",
  name: "fleet",
  kind: "platform",
  certificatePem: null,
  fingerprint: "ab:cd",
  status: "active",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
}

/** An enrollment as the API returns it. */
export const ENROLLMENT = {
  id: "enr_1",
  teamId: "team_1",
  scopeId: "spc_1",
  label: "",
  status: "pending",
  claimedDeviceId: null,
  claimedAt: null,
  expiresAt: "2026-10-02T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
}

/** A device credential as the API returns it. */
export const CREDENTIAL = {
  id: "cred_2",
  deviceId: "dev_1",
  authorityId: null,
  kind: "token",
  certFingerprint: null,
  certSubject: null,
  label: "",
  status: "active",
  expiresAt: null,
  lastUsedAt: null,
  rotatedFrom: "cred_1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
}

const CERT_CREDENTIAL = {
  ...CREDENTIAL,
  id: "cred_3",
  kind: "certificate",
  rotatedFrom: null,
  certFingerprint: "aa:bb"
}

const BROKER = { host: "gw.qualithm.com", port: 8883 }

/** A device as the API returns it. */
export const DEVICE = {
  id: "dev_1",
  scopeId: "spc_1",
  teamId: "team_1",
  name: "sensor",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  parkedAt: null
}

/** A scope as the API returns it. */
export const SCOPE = {
  id: "spc_1",
  teamId: "team_1",
  parentId: null,
  name: "lab",
  zone: "de-fra-a",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deviceTotal: 1
}

export const DEFAULT_ROUTES: Readonly<Record<string, Reply>> = {
  "GET /v1/teams/team_1/devices": { status: 200, body: page([DEVICE]) },
  "POST /v1/teams/team_1/devices": { status: 201, body: { data: DEVICE } },
  "GET /v1/teams/team_1/devices/dev_1": { status: 200, body: { data: DEVICE } },
  "PATCH /v1/teams/team_1/devices/dev_1": { status: 204 },
  "DELETE /v1/teams/team_1/devices/dev_1": { status: 204 },
  "GET /v1/teams/team_1/scopes": { status: 200, body: page([SCOPE]) },
  "POST /v1/teams/team_1/scopes": { status: 201, body: { data: SCOPE } },
  "GET /v1/teams/team_1/scopes/spc_1": { status: 200, body: { data: SCOPE } },
  "PATCH /v1/teams/team_1/scopes/spc_1": { status: 204 },
  "DELETE /v1/teams/team_1/scopes/spc_1": { status: 204 },
  "GET /v1/teams/team_1/scopes/spc_1/devices": { status: 200, body: page([DEVICE]) },
  "GET /v1/teams/team_1/devices/dev_1/credentials": {
    status: 200,
    body: { data: { items: [CREDENTIAL], current: 1, last: 1, total: 1, limit: 20 } }
  },
  "POST /v1/teams/team_1/devices/dev_1/credentials": {
    status: 201,
    body: { data: { credential: CREDENTIAL, secret: "qmd_secret" } }
  },
  "POST /v1/teams/team_1/devices/dev_1/credentials/cert": {
    status: 201,
    body: {
      data: {
        credential: CERT_CREDENTIAL,
        certificatePem: "CERT\n",
        caCertificatePem: "CA\n",
        broker: BROKER
      }
    }
  },
  "POST /v1/teams/team_1/devices/dev_1/credentials/cred_1/rotate": {
    status: 201,
    body: { data: { credential: CREDENTIAL, secret: "qmd_new" } }
  },
  "DELETE /v1/teams/team_1/devices/dev_1/credentials/cred_1": { status: 204 },
  "GET /v1/teams": { status: 200, body: page([team("team_1")]) },
  "GET /v1/teams/team_1/authorities": { status: 200, body: page([AUTHORITY]) },
  "POST /v1/teams/team_1/authorities": { status: 201, body: { data: AUTHORITY } },
  "DELETE /v1/teams/team_1/authorities/ca_1": { status: 204 },
  "GET /v1/teams/team_1/enrollments": { status: 200, body: page([ENROLLMENT]) },
  "POST /v1/teams/team_1/enrollments": {
    status: 201,
    body: { data: { enrollment: ENROLLMENT, code: "QM-1234" } }
  },
  "DELETE /v1/teams/team_1/enrollments/enr_1": { status: 204 },
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

/** A CLI run's io, with its output captured. */
export type Captured = {
  io: CliIo
  out: () => string
  err: () => string
  requests: Recorded[]
}

/**
 * Captures a CLI run against the fake platform, with a token set.
 *
 * @param extra - io fields to override
 * @param routes - the fake platform's routes
 * @returns the io, its captured output and the requests it sent
 */
export function capture(
  extra: Partial<CliIo> = {},
  routes: Readonly<Record<string, Reply>> = DEFAULT_ROUTES
): Captured {
  let out = ""
  let err = ""
  const { fetch, requests } = fakePlatform(routes)
  return {
    io: {
      stdout: (text) => {
        out += text
      },
      stderr: (text) => {
        err += text
      },
      env: { QUALITHM_API_TOKEN: "qmt_x" },
      fetch,
      ...extra
    },
    out: () => out,
    err: () => err,
    requests
  }
}
