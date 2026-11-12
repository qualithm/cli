import { DEFAULT_BASE_URL, PlatformClient, TeamsApi } from "@qualithm/platform"

import { CliError, DryRunError } from "./envelope.ts"

/** The `fetch` signature the platform client sends requests with. */
export type FetchAPI = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Hands out the access token of a stored sign-in, refreshing it as needed. */
export type AccessTokenSource = {
  /**
   * @param rejected - the token the API just refused, so a fresh one is fetched past it
   * @returns the token to send
   */
  accessToken: (rejected?: string) => Promise<string>
}

/** How a command or tool reaches the platform. */
export type SessionConfig = {
  /** An API token; defaults to `QUALITHM_API_TOKEN`. Takes precedence over `credential`. */
  token?: string
  /** The stored sign-in, used when no token is given. */
  credential?: AccessTokenSource
  /** The API's base URL; defaults to `QUALITHM_API_URL`, else production. */
  baseUrl?: string
  /** The team to act on; defaults to the token's own team. */
  team?: string
  /** Plan mutations without sending them. */
  dryRun?: boolean
  /** Sent as the User-Agent, so API logs tell CLI and MCP traffic apart. */
  userAgent?: string
  /** The `fetch` to send requests with; defaults to the global one. */
  fetch?: FetchAPI
}

/** Methods a dry run never sends. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string" || init.body === "") {
    return undefined
  }
  try {
    return JSON.parse(init.body) as unknown
  } catch {
    return init.body
  }
}

/**
 * Wraps `fetch` to add the User-Agent and, on a dry run, to refuse any mutating request by
 * throwing the `DryRunError` that carries it.
 *
 * @param base - the `fetch` to wrap
 * @param config - the dry-run flag and User-Agent
 * @returns the wrapped `fetch`
 */
export function sessionFetch(
  base: FetchAPI,
  config: Pick<SessionConfig, "dryRun" | "userAgent" | "credential">
): FetchAPI {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase()
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (config.dryRun === true && !SAFE_METHODS.has(method)) {
      const body = bodyOf(init)
      throw new DryRunError({
        method,
        path: url.pathname + url.search,
        ...(body === undefined ? {} : { body })
      })
    }
    const headers = new Headers(init?.headers)
    if (config.userAgent !== undefined) {
      headers.set("User-Agent", config.userAgent)
    }
    const { credential } = config
    if (credential === undefined) {
      return base(input, { ...init, headers })
    }
    const token = await credential.accessToken()
    headers.set("Authorization", `Bearer ${token}`)
    const response = await base(input, { ...init, headers })
    if (response.status !== 401) {
      return response
    }
    // Revoked early or lapsed in flight: refresh once, then let a second refusal through.
    headers.set("Authorization", `Bearer ${await credential.accessToken(token)}`)
    return base(input, { ...init, headers })
  }
}

/** One authenticated connection to the platform, shared by every call a command makes. */
export class Session {
  readonly client: PlatformClient
  /** The API this session talks to, without a trailing slash; the SDK's provisioning URL. */
  readonly baseUrl: string
  private team: string | undefined

  /**
   * @param config - token or stored sign-in, base URL, team, dry-run and User-Agent
   * @throws {PlatformError} when neither a token nor a stored sign-in is given, and none is set
   */
  constructor(config: SessionConfig = {}) {
    const base = config.fetch ?? (async (input, init) => fetch(input, init))
    const { credential, ...rest } = config
    const signedIn = config.token === undefined && credential !== undefined
    this.client = new PlatformClient({
      // A stored sign-in's token is set per request by `sessionFetch`; the client needs a stand-in.
      ...(signedIn ? { token: "stored-sign-in" } : {}),
      ...(config.token === undefined ? {} : { token: config.token }),
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      fetch: sessionFetch(base, signedIn ? config : rest)
    })
    this.team = config.team === "" ? undefined : config.team
    this.baseUrl = (config.baseUrl ?? process.env.QUALITHM_API_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ""
    )
  }

  /**
   * The team every team-scoped call acts on: the configured one, else the token's only team,
   * asked of the API once.
   *
   * @returns the team ID
   * @throws {CliError} when the credential can act on no team, or on more than one
   */
  async teamId(): Promise<string> {
    if (this.team !== undefined) {
      return this.team
    }
    const { data } = await this.client.api(TeamsApi).listTeams({ limit: 2 })
    const [only, second] = data.items
    if (only === undefined || second !== undefined) {
      throw new CliError("no single team for this credential: set --team or QUALITHM_TEAM")
    }
    this.team = only.id
    return only.id
  }
}
