import { z } from "zod"

import type { ErrorCode } from "../envelope.ts"

/** The socket API's version. A change to a request or reply shape bumps it. */
export const API_VERSION = 1

const serialNumber = z.string().min(1).optional()

const requestSchema = z.discriminatedUnion("verb", [
  z.object({ api: z.number().int(), verb: z.literal("hello") }),
  z.object({ api: z.number().int(), verb: z.literal("shutdown") }),
  z.object({ api: z.number().int(), verb: z.literal("list") }),
  z.object({ api: z.number().int(), verb: z.literal("flash"), serialNumber }),
  z.object({ api: z.number().int(), verb: z.literal("reset"), serialNumber }),
  z.object({ api: z.number().int(), verb: z.literal("run"), serialNumber, code: z.string() })
])

/** One request line a client sends the core. */
export type CoreRequest = z.infer<typeof requestSchema>

/** A request without its `api` field; the client adds it. */
export type Unversioned<T> = T extends unknown ? Omit<T, "api"> : never

/** A failure's code on the socket: the CLI's codes, plus a refused API version. */
export type CoreErrorCode = ErrorCode | "api_mismatch"

/** One reply line the core sends back. */
export type CoreResponse =
  | { api: number; ok: true; data?: unknown }
  | { api: number; ok: false; error: { code: CoreErrorCode; message: string } }

/** What `hello` answers with. */
export type Hello = {
  /** The running core's `qualithm` version. */
  version: string
  pid: number
}

/** A request line that isn't JSON or doesn't match any verb. */
export class BadRequestError extends Error {
  override readonly name = "BadRequestError"
}

/**
 * Reads one request line.
 *
 * @param line - the line, without its newline
 * @returns the request
 * @throws {BadRequestError} when the line isn't JSON or names no known verb
 */
export function parseRequest(line: string): CoreRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new BadRequestError("request is not json")
  }
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where =
      issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`
    throw new BadRequestError(`bad request${where}: ${issue?.message ?? "invalid"}`)
  }
  return parsed.data
}
