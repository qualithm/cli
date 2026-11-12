import { createHash, randomBytes } from "node:crypto"

import type { CliIo } from "../../../cli.ts"
import type { FetchAPI } from "../../../platform.ts"
import { memoryStore } from "../fake-platform.ts"

export const API = "https://api.example.com"
export const ID = "https://id.example.com"

const TEAM = {
  id: "team_1",
  accountId: "acc_1",
  name: "Acme",
  slug: "acme",
  memberRole: "manager",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
}

type Grant = { revoked: boolean; scope: string }
type Code = { challenge: string; redirectUri: string; scope: string; used: boolean }

/** How the fake person answers in the browser. */
export type Consent = "approve" | "deny" | "wrong-state" | "wrong-iss" | "silent" | { role: string }

/** An in-process authorization server and API, plus the browser that talks to it. */
export type FakeAuth = {
  fetch: FetchAPI
  /** Plays the person: checks the authorize URL, then calls the loopback redirect. */
  openBrowser: (url: string) => Promise<boolean>
  /** Every authorize URL the browser was sent to. */
  opened: URL[]
  /** Every request to the API, as `METHOD /path`. */
  requests: string[]
  /** Form bodies sent to the token and revocation endpoints. */
  forms: URLSearchParams[]
  /** Tokens the API saw in `Authorization`. */
  bearers: string[]
  grants: Map<string, Grant>
  /** Refresh tokens by grant; the last is current. */
  refreshTokens: Map<string, string>
  /** Expires every access token issued so far. */
  expireAccess: () => void
  /** Revokes every grant, as the app would. */
  revokeAll: () => void
  consent: Consent
  /** The metadata the server publishes. */
  metadata: Record<string, unknown>
}

const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })

/**
 * A fake authorization server, as platform and id serve it.
 *
 * @returns the fake
 */
export function fakeAuth(): FakeAuth {
  const codes = new Map<string, Code>()
  const access = new Map<string, { grant: string; expired: boolean }>()
  const refreshes = new Map<string, { grant: string; used: boolean }>()
  const grants = new Map<string, Grant>()
  const refreshTokens = new Map<string, string>()
  const fake: FakeAuth = {
    opened: [],
    requests: [],
    forms: [],
    bearers: [],
    grants,
    refreshTokens,
    consent: "approve",
    metadata: {
      issuer: API,
      authorization_endpoint: `${ID}/authorize`,
      token_endpoint: `${API}/oauth/token`,
      revocation_endpoint: `${API}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"]
    },
    expireAccess: () => {
      for (const entry of access.values()) {
        entry.expired = true
      }
    },
    revokeAll: () => {
      for (const grant of grants.values()) {
        grant.revoked = true
      }
    },
    fetch: async () => Promise.resolve(json(500)),
    openBrowser: async () => Promise.resolve(false)
  }

  const issue = (grant: string): Record<string, unknown> => {
    const accessToken = `qmat_${randomBytes(8).toString("hex")}`
    const refreshToken = `qmrt_${randomBytes(8).toString("hex")}`
    access.set(accessToken, { grant, expired: false })
    refreshes.set(refreshToken, { grant, used: false })
    refreshTokens.set(grant, refreshToken)
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: grants.get(grant)?.scope
    }
  }

  const token = (form: URLSearchParams): Response => {
    const invalid = json(400, { error: "invalid_grant" })
    if (form.get("client_id") !== "https://qualithm.com/oauth/cli.json") {
      return invalid
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "")
      const verifier = form.get("code_verifier") ?? ""
      const challenge = createHash("sha256").update(verifier).digest("base64url")
      if (
        code === undefined ||
        code.used ||
        code.challenge !== challenge ||
        code.redirectUri !== form.get("redirect_uri")
      ) {
        return invalid
      }
      code.used = true
      const grant = `grant_${String(grants.size + 1)}`
      grants.set(grant, { revoked: false, scope: code.scope })
      return json(200, issue(grant))
    }
    if (form.get("grant_type") === "refresh_token") {
      const presented = refreshes.get(form.get("refresh_token") ?? "")
      const grant = presented === undefined ? undefined : grants.get(presented.grant)
      if (presented === undefined || grant === undefined || grant.revoked) {
        return invalid
      }
      if (presented.used) {
        grant.revoked = true
        return invalid
      }
      presented.used = true
      return json(200, issue(presented.grant))
    }
    return invalid
  }

  fake.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = (init?.method ?? "GET").toUpperCase()
    fake.requests.push(`${method} ${url.pathname}`)
    await Promise.resolve()
    if (url.origin !== API) {
      return json(404)
    }
    if (method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, fake.metadata)
    }
    if (method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "")
      fake.forms.push(form)
      return token(form)
    }
    if (method === "POST" && url.pathname === "/oauth/revoke") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "")
      fake.forms.push(form)
      const found = refreshes.get(form.get("token") ?? "") ?? access.get(form.get("token") ?? "")
      const grant = found === undefined ? undefined : grants.get(found.grant)
      if (grant !== undefined) {
        grant.revoked = true
      }
      return json(200)
    }
    const bearer = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? ""
    fake.bearers.push(bearer)
    const held = access.get(bearer)
    const ok =
      bearer === "qmt_env" ||
      (held !== undefined && !held.expired && grants.get(held.grant)?.revoked === false)
    if (!ok) {
      return json(401, { message: "unauthorized", code: "unauthorized" })
    }
    if (method === "GET" && url.pathname === "/v1/teams") {
      return json(200, {
        data: { items: [TEAM], current: 1, last: 1, total: 1, limit: 2, nextCursor: null }
      })
    }
    if (method === "GET" && url.pathname === "/v1/teams/team_1/api-tokens") {
      return json(200, {
        data: { items: [], current: 1, last: 1, total: 0, limit: 20, nextCursor: null }
      })
    }
    return json(404, { message: "not found", code: "not_found" })
  }

  fake.openBrowser = async (raw) => {
    const url = new URL(raw)
    fake.opened.push(url)
    const params = url.searchParams
    const redirect = new URL(params.get("redirect_uri") ?? "")
    const state = params.get("state") ?? ""
    const { consent } = fake
    if (consent === "silent") {
      return true
    }
    if (consent === "deny") {
      redirect.searchParams.set("error", "access_denied")
    } else {
      const code = randomBytes(8).toString("hex")
      codes.set(code, {
        challenge: params.get("code_challenge") ?? "",
        redirectUri: redirect.toString(),
        scope: typeof consent === "object" ? consent.role : (params.get("scope") ?? "manager"),
        used: false
      })
      redirect.searchParams.set("code", code)
    }
    redirect.searchParams.set("state", consent === "wrong-state" ? "forged" : state)
    redirect.searchParams.set("iss", consent === "wrong-iss" ? "https://evil.example.com" : API)
    await fetch(redirect)
    return true
  }
  return fake
}

/** A CLI run's io against the fake authorization server, with output captured. */
export function authCapture(
  fake: FakeAuth,
  extra: Partial<CliIo> = {}
): {
  io: CliIo
  out: () => string
  err: () => string
  store: ReturnType<typeof memoryStore>
  clock: { now: number }
} {
  let out = ""
  let err = ""
  const store = memoryStore()
  const clock = { now: Date.parse("2026-11-12T10:00:00.000Z") }
  return {
    io: {
      stdout: (text) => {
        out += text
      },
      stderr: (text) => {
        err += text
      },
      env: { QUALITHM_API_URL: API },
      fetch: fake.fetch,
      credentials: store,
      login: {
        openBrowser: fake.openBrowser,
        now: () => clock.now,
        lock: async (task) => task()
      },
      ...extra
    },
    out: () => out,
    err: () => err,
    store,
    clock
  }
}
