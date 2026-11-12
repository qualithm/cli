import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { CliError } from "../envelope.ts"
import type { FetchAPI } from "../platform.ts"
import type { StoredLogin } from "./store.ts"

/** The CLI's client ID: a client ID metadata document platform ships with. */
export const CLIENT_ID = "https://qualithm.com/oauth/cli.json"

/** The roles a sign-in may be capped at, highest first. */
export const ROLES = ["owner", "manager", "viewer"] as const

/** The authorization server's endpoints, from its RFC 8414 metadata. */
export type AuthServer = {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string
}

/** How long a sign-in waits for the browser before giving up. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

const LOG_IN_AGAIN = "your sign-in has expired or was revoked: run qualithm login"

const base64url = (bytes: Buffer): string => bytes.toString("base64url")

/**
 * A PKCE pair: a random verifier and its S256 challenge.
 *
 * @returns the verifier and challenge
 */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

/**
 * A random `state` value for one authorization request.
 *
 * @returns the state
 */
export function newState(): string {
  return base64url(randomBytes(16))
}

function unreachable(error: unknown): CliError {
  const message = error instanceof Error ? error.message : String(error)
  return new CliError(`could not reach the sign-in server: ${message.toLowerCase()}`, "error")
}

const endpoint = (value: unknown, origin: string, name: string): string => {
  if (typeof value !== "string") {
    throw new CliError(`the sign-in server lists no ${name}`, "api")
  }
  const url = new URL(value)
  // Only the person's browser may leave the API's origin: tokens go to the issuer alone.
  if (name !== "authorization_endpoint" && url.origin !== origin) {
    throw new CliError(`the sign-in server's ${name} is not on ${origin}`, "api")
  }
  if (url.protocol !== "https:" && !isLocal(url)) {
    throw new CliError(`the sign-in server's ${name} is not https`, "api")
  }
  return url.toString()
}

function isLocal(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
}

/**
 * Reads the authorization server metadata the API publishes, and checks it names the API as its
 * issuer.
 *
 * @param api - the API origin, such as `https://api.qualithm.com`
 * @param fetch - sends the request
 * @returns the endpoints
 * @throws {CliError} when the API publishes no metadata, or metadata for another issuer
 */
export async function discover(api: string, fetch: FetchAPI): Promise<AuthServer> {
  let response: Response
  try {
    response = await fetch(`${api}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json" }
    })
  } catch (error) {
    throw unreachable(error)
  }
  if (!response.ok) {
    throw new CliError(
      `${api} does not offer sign-in (status ${String(response.status)}): set QUALITHM_API_TOKEN instead`,
      response.status === 404 ? "not_found" : "api"
    )
  }
  const metadata = (await response.json()) as Record<string, unknown>
  if (metadata.issuer !== api) {
    throw new CliError(`the sign-in server names another issuer than ${api}`, "api")
  }
  const methods = metadata.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new CliError("the sign-in server does not support PKCE with S256", "api")
  }
  return {
    issuer: api,
    authorizationEndpoint: endpoint(metadata.authorization_endpoint, api, "authorization_endpoint"),
    tokenEndpoint: endpoint(metadata.token_endpoint, api, "token_endpoint"),
    revocationEndpoint: endpoint(metadata.revocation_endpoint, api, "revocation_endpoint")
  }
}

/** One authorization request's parameters. */
export type AuthorizeRequest = {
  redirectUri: string
  challenge: string
  state: string
  /** The role to cap the sign-in at; the person's own role when absent. */
  role?: string
}

/**
 * The URL the person opens to approve the CLI.
 *
 * @param server - the authorization server
 * @param request - the request's parameters
 * @returns the URL
 */
export function authorizeUrl(server: AuthServer, request: AuthorizeRequest): string {
  const url = new URL(server.authorizationEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", request.redirectUri)
  url.searchParams.set("code_challenge", request.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", request.state)
  url.searchParams.set("resource", server.issuer)
  if (request.role !== undefined) {
    url.searchParams.set("scope", request.role)
  }
  return url.toString()
}

/** A loopback listener waiting for one redirect. */
export type Loopback = {
  /** `http://127.0.0.1:<port>/callback`. */
  redirectUri: string
  /** The authorization code, once the browser arrives with a valid one. */
  code: Promise<string>
  /** Stops listening. */
  close: () => void
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1>${title}</h1><p>${body}</p></body></html>`

/**
 * Listens on an ephemeral port on 127.0.0.1 for the one redirect that carries the code, checking
 * its `state` and `iss`. Any other path gets a 404; the first callback settles the sign-in.
 *
 * @param expected - the state sent and the issuer that must answer
 * @param timeoutMs - how long to wait for the browser
 * @returns the listener, once it is bound
 */
export async function listen(
  expected: { state: string; issuer: string },
  timeoutMs: number = LOGIN_TIMEOUT_MS
): Promise<Loopback> {
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end()
      return
    }
    const outcome = callbackOutcome(url.searchParams, expected)
    response.writeHead(outcome.ok ? 200 : 400, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    })
    response.end(
      outcome.ok
        ? PAGE("Signed in", "The Qualithm CLI is signed in. You can close this tab.")
        : PAGE("Not signed in", "The Qualithm CLI did not sign in. Return to your terminal.")
    )
    if (outcome.ok) {
      settle?.resolve(outcome.code)
    } else {
      settle?.reject(outcome.error)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  const timer = setTimeout(() => {
    settle?.reject(
      new CliError("no answer from the browser in time: run qualithm login again", "error")
    )
  }, timeoutMs)
  const close = (): void => {
    clearTimeout(timer)
    server.closeAllConnections()
    server.close()
  }
  code.then(close, close)
  return { redirectUri: `http://127.0.0.1:${String(port)}/callback`, code, close }
}

function callbackOutcome(
  params: URLSearchParams,
  expected: { state: string; issuer: string }
): { ok: true; code: string } | { ok: false; error: CliError } {
  if (params.get("state") !== expected.state) {
    return { ok: false, error: new CliError("the sign-in answer did not match this login", "auth") }
  }
  if (params.get("iss") !== expected.issuer) {
    return {
      ok: false,
      error: new CliError("the sign-in answer came from another server than the API", "auth")
    }
  }
  const error = params.get("error")
  if (error === "access_denied") {
    return { ok: false, error: new CliError("sign-in was declined in the browser", "auth") }
  }
  const code = params.get("code")
  if (error !== null || code === null || code === "") {
    return {
      ok: false,
      error: new CliError(`sign-in failed: ${error ?? "no code returned"}`, "auth")
    }
  }
  return { ok: true, code }
}

async function tokenRequest(
  server: AuthServer,
  form: Record<string, string>,
  fetch: FetchAPI,
  now: () => number
): Promise<StoredLogin> {
  let response: Response
  try {
    response = await fetch(server.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams(form).toString()
    })
  } catch (error) {
    throw unreachable(error)
  }
  if (response.status === 400 || response.status === 401) {
    throw new CliError(LOG_IN_AGAIN, "auth")
  }
  if (!response.ok) {
    throw new CliError(
      `the sign-in server answered ${String(response.status)}: try again`,
      response.status === 503 ? "unavailable" : "api"
    )
  }
  const body = (await response.json()) as Record<string, unknown>
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn, scope } = body
  if (typeof access !== "string" || typeof refresh !== "string") {
    throw new CliError("the sign-in server returned no tokens", "api")
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000,
    scope: typeof scope === "string" ? scope : ""
  }
}

/**
 * Redeems an authorization code with its PKCE verifier.
 *
 * @param server - the authorization server
 * @param grant - the code, the redirect URI it was sent to and the verifier
 * @param fetch - sends the request
 * @param now - the clock
 * @returns the new sign-in
 * @throws {CliError} `auth` when the server refuses the code
 */
export async function exchangeCode(
  server: AuthServer,
  grant: { code: string; redirectUri: string; verifier: string },
  fetch: FetchAPI,
  now: () => number = Date.now
): Promise<StoredLogin> {
  return tokenRequest(
    server,
    {
      grant_type: "authorization_code",
      code: grant.code,
      client_id: CLIENT_ID,
      redirect_uri: grant.redirectUri,
      code_verifier: grant.verifier
    },
    fetch,
    now
  )
}

/**
 * Trades a refresh token for new tokens; the old refresh token stops working.
 *
 * @param server - the authorization server
 * @param refreshToken - the current refresh token
 * @param fetch - sends the request
 * @param now - the clock
 * @returns the new sign-in
 * @throws {CliError} `auth` when the refresh token is expired, revoked or already used
 */
export async function refresh(
  server: AuthServer,
  refreshToken: string,
  fetch: FetchAPI,
  now: () => number = Date.now
): Promise<StoredLogin> {
  return tokenRequest(
    server,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID },
    fetch,
    now
  )
}

/**
 * Revokes the whole grant a token belongs to.
 *
 * @param server - the authorization server
 * @param token - the refresh or access token
 * @param fetch - sends the request
 * @throws {CliError} when the server can't be reached or doesn't answer 200
 */
export async function revoke(server: AuthServer, token: string, fetch: FetchAPI): Promise<void> {
  let response: Response
  try {
    response = await fetch(server.revocationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString()
    })
  } catch (error) {
    throw unreachable(error)
  }
  if (!response.ok) {
    throw new CliError(
      `the sign-in server answered ${String(response.status)}: nothing was changed, try again`,
      response.status === 503 ? "unavailable" : "api"
    )
  }
}

export { LOG_IN_AGAIN }
