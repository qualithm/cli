import { spawn } from "node:child_process"
import { parseArgs } from "node:util"

import { TeamsApi } from "@qualithm/platform"

import {
  authorizeUrl,
  CLIENT_ID,
  discover,
  exchangeCode,
  listen,
  newState,
  pkce,
  revoke,
  ROLES
} from "../auth/oauth.ts"
import type { CredentialStore } from "../auth/store.ts"
import { CliError, EXIT_CODES, exitCode, failure, type Result, success } from "../envelope.ts"
import type { FetchAPI, Session } from "../platform.ts"

/** What `qualithm login`, `logout` and `whoami` reach for; tests pass their own. */
export type AuthIo = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  fetch: FetchAPI
  store: CredentialStore
  /** The API origin, from `--url` or `QUALITHM_API_URL`, else production. */
  api: (values: Readonly<Record<string, string | boolean | undefined>>) => string
  /** The token that takes precedence over a sign-in, by where it came from, if one is set. */
  override: (values: Readonly<Record<string, string | boolean | undefined>>) => string | undefined
  /** A session on the credential the other commands would use, or on the sign-in alone. */
  newSession: (
    values: Readonly<Record<string, string | boolean | undefined>>,
    signInOnly?: boolean
  ) => Session
  /** Opens a URL in the system browser; resolves false when it can't. */
  openBrowser?: (url: string) => Promise<boolean>
  /** How long login waits for the browser. */
  timeoutMs?: number
  now?: () => number
}

export const AUTH_USAGE = `Usage:
  qualithm login [--role owner|manager|viewer] [--no-browser]
  qualithm logout
  qualithm whoami

login opens your browser to approve the CLI for one team, then keeps the sign-in in this
computer's keychain, where qualithm mcp finds it too. --role caps it below your own role;
--no-browser prints the link instead of opening it. logout revokes the sign-in and removes it.
QUALITHM_API_TOKEN, when set, takes precedence over the sign-in.

Flags:
  --url string   API base URL (env QUALITHM_API_URL)
  --json         print one JSON envelope line
  --dry-run      report what would happen without signing in or out
`

const OPTIONS = {
  url: { type: "string" },
  token: { type: "string" },
  team: { type: "string" },
  role: { type: "string" },
  "no-browser": { type: "boolean" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" }
} as const

/**
 * The command that opens a URL in the system browser, without a shell.
 *
 * @param url - the URL
 * @param platform - the OS
 * @returns the command and its arguments
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): [string, string[]] {
  return platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]]
}

/**
 * Opens a URL in the system browser.
 *
 * @param url - the URL
 * @param command - the command to run; the OS's own by default
 * @returns whether the command could be started
 */
export async function openBrowser(
  url: string,
  command: [string, string[]] = browserCommand(url)
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command[1], {
      stdio: "ignore",
      detached: true,
      windowsHide: true
    })
    child.once("error", () => {
      resolve(false)
    })
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}

const rank = (role: string): number => {
  const index = (ROLES as readonly string[]).indexOf(role)
  return index === -1 ? ROLES.length : index
}

/** The lower of two roles: a sign-in never acts above its ceiling or the member's role. */
const lower = (a: string, b: string): string => (rank(a) >= rank(b) ? a : b)

type Identity = { team: { id: string; name: string }; role: string }

async function identify(session: Session, ceiling?: string): Promise<Identity> {
  const { data } = await session.client.api(TeamsApi).listTeams({ limit: 2 })
  const [team, second] = data.items
  if (team === undefined || second !== undefined) {
    throw new CliError("no single team for this credential: set --team or QUALITHM_TEAM", "api")
  }
  const role =
    ceiling === undefined || ceiling === "" ? team.memberRole : lower(team.memberRole, ceiling)
  return { team: { id: team.id, name: team.name }, role }
}

async function login(
  values: Readonly<Record<string, string | boolean | undefined>>,
  io: AuthIo
): Promise<Result> {
  const role = typeof values.role === "string" ? values.role : undefined
  if (role !== undefined && !(ROLES as readonly string[]).includes(role)) {
    throw new CliError(`--role must be one of ${ROLES.join(", ")}`)
  }
  const api = io.api(values)
  const server = await discover(api, io.fetch)
  if (values["dry-run"] === true) {
    return {
      ok: true,
      dryRun: true,
      action: { method: "POST", path: new URL(server.tokenEndpoint).pathname },
      data: { api, authorizationEndpoint: server.authorizationEndpoint, clientId: CLIENT_ID }
    }
  }
  const { verifier, challenge } = pkce()
  const state = newState()
  const loopback = await listen({ state, issuer: server.issuer }, io.timeoutMs)
  try {
    const url = authorizeUrl(server, {
      redirectUri: loopback.redirectUri,
      challenge,
      state,
      ...(role === undefined ? {} : { role })
    })
    const opened =
      values["no-browser"] !== true &&
      (await (io.openBrowser ?? (async (u: string) => openBrowser(u)))(url).catch(() => false))
    io.stderr(
      opened
        ? `Approve the Qualithm CLI in your browser. If it didn't open, go to:\n  ${url}\n`
        : `Open this link to approve the Qualithm CLI:\n  ${url}\n`
    )
    const code = await loopback.code
    const signedIn = await exchangeCode(
      server,
      { code, redirectUri: loopback.redirectUri, verifier },
      io.fetch,
      io.now
    )
    const previous = await io.store.read(api).catch(() => undefined)
    await io.store.write(api, signedIn)
    if (previous !== undefined) {
      // The earlier sign-in is replaced; end its grant too, and never fail the login over it.
      await revoke(server, previous.refreshToken, io.fetch).catch(() => undefined)
    }
    const who = await identify(io.newSession(values, true), signedIn.scope)
    const override = io.override(values)
    if (override !== undefined) {
      io.stderr(`${override} is set, and takes precedence over this sign-in until you unset it\n`)
    }
    return success({ api, ...who, ...(override === undefined ? {} : { overriddenBy: override }) })
  } finally {
    loopback.close()
  }
}

async function logout(
  values: Readonly<Record<string, string | boolean | undefined>>,
  io: AuthIo
): Promise<Result> {
  const api = io.api(values)
  const stored = await io.store.read(api)
  if (stored === undefined) {
    return success({ api, loggedOut: false })
  }
  const server = await discover(api, io.fetch)
  if (values["dry-run"] === true) {
    return {
      ok: true,
      dryRun: true,
      action: { method: "POST", path: new URL(server.revocationEndpoint).pathname },
      data: { api }
    }
  }
  await revoke(server, stored.refreshToken, io.fetch)
  await io.store.clear(api)
  return success({ api, loggedOut: true })
}

async function whoami(
  values: Readonly<Record<string, string | boolean | undefined>>,
  io: AuthIo
): Promise<Result> {
  const api = io.api(values)
  const override = io.override(values)
  const stored = override === undefined ? await io.store.read(api) : undefined
  const who = await identify(io.newSession(values), stored?.scope)
  return success({ api, credential: override ?? "login", ...who })
}

function human(verb: string, data: Record<string, unknown>): string {
  const who = data as Partial<Identity> & { api: string; loggedOut?: boolean; credential?: string }
  if (verb === "logout") {
    return who.loggedOut === true ? `logged out of ${who.api}\n` : `not logged in to ${who.api}\n`
  }
  const line = `team ${who.team?.name ?? ""} (${who.team?.id ?? ""}) as ${who.role ?? ""}`
  return verb === "login"
    ? `logged in to ${line}\n`
    : `${line} on ${who.api}, with ${who.credential === "login" ? "your sign-in" : (who.credential ?? "")}\n`
}

/**
 * Runs `qualithm login`, `logout` or `whoami`. Never throws. No token ever reaches the output.
 *
 * @param verb - which one
 * @param args - its arguments
 * @param io - where output goes and what it reaches for
 * @returns the exit code
 */
export async function runAuth(
  verb: "login" | "logout" | "whoami",
  args: string[],
  io: AuthIo
): Promise<number> {
  let values: Record<string, string | boolean | undefined>
  try {
    ;({ values } = parseArgs({ args, options: OPTIONS, allowPositionals: false, strict: true }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`qualithm: ${message.toLowerCase()}\n`)
    return EXIT_CODES.usage
  }
  if (values.help === true) {
    io.stdout(AUTH_USAGE)
    return EXIT_CODES.ok
  }
  let result: Result
  try {
    result = await (verb === "login" ? login : verb === "logout" ? logout : whoami)(values, io)
  } catch (error) {
    result = failure(error)
  }
  if (values.json === true) {
    io.stdout(`${JSON.stringify(result)}\n`)
  } else if (!result.ok) {
    io.stderr(`qualithm: ${result.message ?? "request failed"}\n`)
  } else if (result.dryRun === true && result.action !== undefined) {
    io.stdout(`dry-run: would ${result.action.method} ${result.action.path}\n`)
  } else {
    io.stdout(human(verb, result.data as Record<string, unknown>))
  }
  return exitCode(result)
}
