import { EnrollmentsApi, ScopesApi } from "@qualithm/platform"

import type { Setup } from "../board/sync.ts"
import { knownNetworks, savedPassphrase, type WifiDetails, type WifiHost } from "../board/wifi.ts"
import { CliError } from "../envelope.ts"
import type { Session } from "../platform.ts"

/**
 * Finds the Wi-Fi details for a board: the named network, or the likeliest one, and its
 * passphrase. A terminal may ask the person; an agent's call never does.
 */
export type WifiResolver = (network: string | undefined) => Promise<WifiDetails>

/** What the resolvers reach for; the real OS by default. */
export type WifiLookup = {
  host?: WifiHost
  networks?: (host?: WifiHost) => Promise<string[]>
  passphrase?: (ssid: string, host?: WifiHost) => Promise<string | undefined>
}

/** The step a person runs when an agent's deploy can't find the Wi-Fi details itself. */
const IN_A_TERMINAL =
  "run `qualithm deploy` once in a terminal, which can ask for them; later deploys keep them"

/**
 * The likeliest network: the one named, else the first the OS knows.
 *
 * @param network - the network named, if any
 * @param lookup - what to reach for
 * @returns the network name
 * @throws {CliError} when none is named and the OS knows none
 */
export async function pickNetwork(
  network: string | undefined,
  lookup: WifiLookup = {}
): Promise<string> {
  if (network !== undefined) {
    return network
  }
  const [first] = await (lookup.networks ?? knownNetworks)(lookup.host)
  if (first === undefined) {
    throw new CliError(
      `this computer knows no Wi-Fi network for the board: ${IN_A_TERMINAL}`,
      "not_found"
    )
  }
  return first
}

/**
 * A resolver for agents: the passphrase comes only from the OS's own store.
 *
 * @param lookup - what to reach for
 * @returns the resolver
 */
export function keychainWifi(lookup: WifiLookup = {}): WifiResolver {
  return async (network) => {
    const ssid = await pickNetwork(network, lookup)
    const passphrase = await (lookup.passphrase ?? savedPassphrase)(ssid, lookup.host)
    if (passphrase === undefined) {
      throw new CliError(
        `this computer's keychain has no passphrase for the Wi-Fi network ${ssid}: ${IN_A_TERMINAL}`,
        "not_found"
      )
    }
    return { ssid, passphrase }
  }
}

/** Asks a person at a terminal. */
export type Ask = {
  /** Asks a question and returns the answer, or `fallback` when the answer is empty. */
  line: (question: string, fallback: string) => Promise<string>
  /** Asks a question without echoing the answer. */
  secret: (question: string) => Promise<string>
}

/**
 * A resolver for a person at a terminal: offers the likeliest network, then reads its
 * passphrase from the OS's store or, failing that, asks without echo.
 *
 * @param ask - how to ask
 * @param lookup - what to reach for
 * @returns the resolver
 */
export function terminalWifi(ask: Ask, lookup: WifiLookup = {}): WifiResolver {
  return async (network) => {
    let ssid = network
    if (ssid === undefined) {
      const [first = ""] = await (lookup.networks ?? knownNetworks)(lookup.host)
      ssid = (
        await ask.line(`Wi-Fi network for the board${first === "" ? "" : ` [${first}]`}: `, first)
      ).trim()
    }
    if (ssid === "") {
      throw new CliError("the board needs a Wi-Fi network to join", "usage")
    }
    const saved = await (lookup.passphrase ?? savedPassphrase)(ssid, lookup.host)
    const passphrase = saved ?? (await ask.secret(`Passphrase for ${ssid}: `))
    return { ssid, passphrase }
  }
}

/** What provisioning chose, for the deploy's result. The claim code and passphrase stay out. */
export type Provisioned = {
  scopeId: string
  /** The network the board will join; absent for a virtual device, which uses the host's. */
  wifiNetwork?: string
}

/**
 * The scope a new board joins: the one named, else the team's only scope.
 *
 * @param session - the platform
 * @param scopeId - the scope named, if any
 * @returns the scope id
 * @throws {CliError} when none is named and the team has no scope, or several
 */
export async function pickScope(session: Session, scopeId: string | undefined): Promise<string> {
  if (scopeId !== undefined) {
    return scopeId
  }
  const teamId = await session.teamId()
  const { data } = await session.client.api(ScopesApi).listScopes({ teamId, limit: 100 })
  const [only, ...others] = data.items
  if (only === undefined) {
    throw new CliError(
      "your team has no scope for the board yet: create one in the app, then deploy",
      "not_found"
    )
  }
  if (others.length > 0) {
    const names = data.items.map((s) => `${s.name} (${s.id})`).join(", ")
    throw new CliError(
      `your team has several scopes: name one with --scope, from ${names}`,
      "usage"
    )
  }
  return only.id
}

/**
 * Creates a claim code for a new board and puts the setup file together.
 *
 * @param session - the platform
 * @param scopeId - the scope the board joins
 * @param wifi - the network and passphrase, or undefined to keep the board's own
 * @returns the setup to write
 */
export async function makeSetup(
  session: Session,
  scopeId: string,
  wifi: WifiDetails | undefined
): Promise<Setup> {
  const teamId = await session.teamId()
  const { data } = await session.client.api(EnrollmentsApi).createEnrollment({
    teamId,
    createEnrollmentRequest: { scopeId, label: "qualithm deploy" }
  })
  return {
    provisioningUrl: session.baseUrl,
    claimCode: data.code,
    ...(wifi === undefined ? {} : { wifi })
  }
}
