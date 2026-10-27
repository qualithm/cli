import { PlatformClient, TeamsApi } from "@qualithm/platform"

import { CliError, DryRunError } from "./envelope.ts"

/** The `fetch` signature the platform client sends requests with. */
export type FetchAPI = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** How a command or tool reaches the platform. */
export type SessionConfig = {
  /** An API token; defaults to `QUALITHM_API_TOKEN`. */
  token?: string
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
  config: Pick<SessionConfig, "dryRun" | "userAgent">
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
    return base(input, { ...init, headers })
  }
}

/** One authenticated connection to the platform, shared by every call a command makes. */
export class Session {
  readonly client: PlatformClient
  private team: string | undefined

  /**
   * @param config - token, base URL, team, dry-run and User-Agent
   * @throws {PlatformError} when no token is given or set
   */
  constructor(config: SessionConfig = {}) {
    const base = config.fetch ?? (async (input, init) => fetch(input, init))
    this.client = new PlatformClient({
      ...(config.token === undefined ? {} : { token: config.token }),
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      fetch: sessionFetch(base, config)
    })
    this.team = config.team === "" ? undefined : config.team
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
