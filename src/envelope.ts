import { PlatformError } from "@qualithm/platform"

/**
 * A failure's stable code. Agents branch on it, so a value never changes meaning. Each maps
 * one-to-one to an exit code.
 */
export type ErrorCode =
  | "error"
  | "usage"
  | "auth"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "api"
  | "unavailable"
  | "timeout"

/** Exit codes, part of the CLI contract: scripts and agents branch on them. */
export const EXIT_CODES: Readonly<Record<ErrorCode | "ok", number>> = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  not_found: 4,
  conflict: 5,
  rate_limited: 6,
  api: 7,
  unavailable: 8,
  timeout: 9
}

/** A mutation that a dry run planned but did not send. */
export type PlannedAction = {
  method: string
  path: string
  body?: unknown
}

/**
 * The one envelope every command's `--json` output and every MCP tool returns, so agents read
 * one shape everywhere.
 */
export type Result = {
  /** Whether the call succeeded; a dry run counts as success. */
  ok: boolean
  /** The failure's stable code; absent on success. */
  code?: ErrorCode
  /** What failed; absent on success. */
  message?: string
  /** True when a mutation was planned but not applied. */
  dryRun?: boolean
  /** The planned mutation, on a dry run. */
  action?: PlannedAction
  /** The API's payload, on success; on a failure, what the command did before it failed. */
  data?: unknown
}

/** Thrown in place of a mutating request when dry-run is on; carries the planned action. */
export class DryRunError extends Error {
  override readonly name = "DryRunError"
  readonly action: PlannedAction

  /**
   * @param action - the request that was not sent
   */
  constructor(action: PlannedAction) {
    super(`dry run: ${action.method} ${action.path}`)
    this.action = action
  }
}

/** A failure the CLI itself raises, such as a missing argument, with its stable code. */
export class CliError extends Error {
  override readonly name = "CliError"
  readonly code: ErrorCode
  /** What the command did before it failed, carried into the envelope's `data`. */
  readonly data?: unknown

  /**
   * @param message - what failed, lowercase
   * @param code - the stable code; defaults to `usage`
   * @param data - what the command did anyway, such as the agents a connect reached
   */
  constructor(message: string, code: ErrorCode = "usage", data?: unknown) {
    super(message)
    this.code = code
    if (data !== undefined) {
      this.data = data
    }
  }
}

/**
 * Maps an HTTP status to its stable code.
 *
 * @param status - the response status, or `0` when no response arrived
 * @returns the code
 */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 0:
      return "error"
    case 401:
    case 403:
      return "auth"
    case 404:
      return "not_found"
    case 409:
      return "conflict"
    case 429:
      return "rate_limited"
    case 503:
      return "unavailable"
    default:
      return "api"
  }
}

/**
 * Wraps a successful payload.
 *
 * @param data - the API's payload
 * @returns the success envelope
 */
export function success(data?: unknown): Result {
  return data === undefined ? { ok: true } : { ok: true, data }
}

/**
 * Turns any thrown value into an envelope. A dry run is a success carrying its planned action.
 *
 * @param error - what was thrown
 * @returns the failure (or dry-run) envelope
 */
export function failure(error: unknown): Result {
  // The platform client wraps whatever its `fetch` throws, so a dry run arrives as the cause.
  // A refused or missing sign-in is raised inside that `fetch` too.
  if (
    error instanceof PlatformError &&
    (error.cause instanceof DryRunError || error.cause instanceof CliError)
  ) {
    return failure(error.cause)
  }
  if (error instanceof DryRunError) {
    return { ok: true, dryRun: true, action: error.action }
  }
  if (error instanceof CliError) {
    const { code, message, data } = error
    return data === undefined ? { ok: false, code, message } : { ok: false, code, message, data }
  }
  if (error instanceof PlatformError) {
    // No token at all is a setup mistake, not a refused credential: no request was sent.
    const code = error.status === 0 && error.code === "unauthorized" ? "usage" : null
    return { ok: false, code: code ?? codeForStatus(error.status), message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: "error", message }
}

/**
 * The exit code for an envelope.
 *
 * @param result - the envelope
 * @returns `0` on success, else the code's exit code
 */
export function exitCode(result: Result): number {
  return result.ok ? EXIT_CODES.ok : EXIT_CODES[result.code ?? "error"]
}
