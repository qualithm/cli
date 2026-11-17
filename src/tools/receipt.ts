/** One choice Qualithm made on the builder's behalf, in the platform's receipt shape. */
export type Decision = {
  /** Stable identifier, for code. */
  key: string
  /** Sentence-case name, for people. */
  label: string
  /** The value as held by its source. */
  value: string
  /** Where the value is held. */
  source: string
  /** The docs page that explains the default. */
  docsUrl: string
}

/** A receipt holds at most this many decisions, as the platform's does. */
export const MAX_DECISIONS = 6

const DOCS = "https://docs.qualithm.com"

/** What a flash or deploy used; a value it didn't use is left out. */
export type BoardChoices = {
  /** The MicroPython release the board now runs, pinned by this CLI. */
  firmware?: string
  /** The Qualithm Device SDK release the run installed, pinned by this CLI. */
  sdk?: string
  /** The scope a new device was set to claim itself into. */
  scopeId?: string
  /** The Wi-Fi network a new board was set to join; never its passphrase. */
  wifiNetwork?: string
}

/**
 * The receipt for a board flash or deploy: what the run decided, each value from where it is held.
 *
 * @param choices - what the run used
 * @returns the decisions, most consequential first
 */
export function boardDecisions(choices: BoardChoices): Decision[] {
  const decisions: Decision[] = []
  if (choices.firmware !== undefined) {
    decisions.push({
      key: "firmware",
      label: "MicroPython",
      value: choices.firmware,
      source: "cli",
      docsUrl: `${DOCS}/micropython#the-micropython-release`
    })
  }
  if (choices.sdk !== undefined && choices.sdk !== "") {
    decisions.push({
      key: "sdk",
      label: "Qualithm Device SDK",
      value: choices.sdk,
      source: "cli",
      docsUrl: `${DOCS}/micropython#the-device-sdk`
    })
  }
  if (choices.scopeId !== undefined) {
    decisions.push({
      key: "scope",
      label: "Scope",
      value: choices.scopeId,
      source: "team",
      docsUrl: `${DOCS}/scopes#add-a-device-to-a-scope`
    })
  }
  if (choices.wifiNetwork !== undefined && choices.wifiNetwork !== "") {
    decisions.push({
      key: "wifi",
      label: "Wi-Fi network",
      value: choices.wifiNetwork,
      source: "computer",
      docsUrl: `${DOCS}/micropython#the-wi-fi-network`
    })
  }
  return decisions.slice(0, MAX_DECISIONS)
}
