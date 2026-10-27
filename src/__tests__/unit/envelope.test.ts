import { PlatformError } from "@qualithm/platform"
import { describe, expect, it } from "vitest"

import {
  CliError,
  codeForStatus,
  DryRunError,
  EXIT_CODES,
  exitCode,
  failure,
  success
} from "../../envelope.ts"

describe("codeForStatus", () => {
  it.each([
    [0, "error"],
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [503, "unavailable"],
    [500, "api"],
    [422, "api"]
  ] as const)("maps %i to %s", (status, code) => {
    expect(codeForStatus(status)).toBe(code)
  })
})

describe("exit codes", () => {
  it("keeps the published contract", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      error: 1,
      usage: 2,
      auth: 3,
      not_found: 4,
      conflict: 5,
      rate_limited: 6,
      api: 7,
      unavailable: 8
    })
  })

  it("exits 0 on success and the code's number on failure", () => {
    expect(exitCode({ ok: true })).toBe(0)
    expect(exitCode({ ok: false, code: "not_found" })).toBe(4)
    expect(exitCode({ ok: false })).toBe(1)
  })
})

describe("success", () => {
  it("omits data when there is none", () => {
    expect(success()).toEqual({ ok: true })
    expect(success({ id: "x" })).toEqual({ ok: true, data: { id: "x" } })
  })
})

describe("failure", () => {
  const action = { method: "DELETE", path: "/v1/x" }

  it("reports a dry run as a success with its planned action", () => {
    expect(failure(new DryRunError(action))).toEqual({ ok: true, dryRun: true, action })
  })

  it("unwraps a dry run the platform client wrapped", () => {
    const wrapped = new PlatformError("request failed", "unknown", 0, {
      cause: new DryRunError(action)
    })
    expect(failure(wrapped)).toEqual({ ok: true, dryRun: true, action })
  })

  it("keeps a CLI error's code", () => {
    expect(failure(new CliError("token id is required"))).toEqual({
      ok: false,
      code: "usage",
      message: "token id is required"
    })
    expect(failure(new CliError("boom", "conflict")).code).toBe("conflict")
  })

  it("classifies a platform error by status", () => {
    expect(failure(new PlatformError("no such device", "not_found", 404))).toEqual({
      ok: false,
      code: "not_found",
      message: "no such device"
    })
  })

  it("treats a missing token as a usage error", () => {
    expect(failure(new PlatformError("api token missing", "unauthorized", 0)).code).toBe("usage")
  })

  it("reports anything else as an error", () => {
    expect(failure(new Error("socket closed"))).toEqual({
      ok: false,
      code: "error",
      message: "socket closed"
    })
    expect(failure("weird")).toEqual({ ok: false, code: "error", message: "weird" })
  })
})
