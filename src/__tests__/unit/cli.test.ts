import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { run, USAGE } from "../../cli.ts"
import { dash, table, when } from "../../table.ts"
import { VERSION } from "../../version.ts"
import { capture, fakePlatform } from "./fake-platform.ts"

describe("top level", () => {
  it("prints the version, matching package.json", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
    expect(VERSION).toBe(pkg.version)
    for (const arg of ["version", "--version", "-v"]) {
      const c = capture()
      expect(await run([arg], c.io)).toBe(0)
      expect(c.out()).toBe(`qualithm ${VERSION}\n`)
    }
  })

  it("prints help on request and on stderr with usage exit when bare", async () => {
    const help = capture()
    expect(await run(["--help"], help.io)).toBe(0)
    expect(help.out()).toBe(USAGE)
    const bare = capture()
    expect(await run([], bare.io)).toBe(2)
    expect(bare.err()).toBe(USAGE)
  })

  it("rejects an unknown command or verb", async () => {
    const c = capture()
    expect(await run(["gadget"], c.io)).toBe(2)
    expect(c.err()).toMatch(/^qualithm: unknown command "gadget"/)
    const v = capture()
    expect(await run(["token", "frob"], v.io)).toBe(2)
    expect(v.err()).toMatch(/^qualithm: unknown command "token frob"/)
  })

  it("prints a resource's help, or usage when the verb is missing", async () => {
    const help = capture()
    expect(await run(["tokens", "help"], help.io)).toBe(0)
    expect(help.out()).toBe(USAGE)
    const bare = capture()
    expect(await run(["token"], bare.io)).toBe(2)
    expect(bare.err()).toBe(USAGE)
  })
})

describe("token list", () => {
  it("prints a table", async () => {
    const c = capture()
    expect(await run(["token", "ls"], c.io)).toBe(0)
    expect(c.out()).toBe(
      table([
        ["ID", "NAME", "ROLE", "STATUS", "EXPIRES", "LAST-USED"],
        ["tok_1", "ci", "your role", "active", "-", "2026-10-20T10:00:00.000Z"]
      ])
    )
  })

  it("prints one envelope line with --json", async () => {
    const c = capture()
    expect(await run(["api-token", "list", "--json", "--limit", "5"], c.io)).toBe(0)
    const lines = c.out().trimEnd().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      ok: true,
      data: { items: [{ id: "tok_1" }] }
    })
  })

  it("rejects a non-numeric page", async () => {
    const c = capture()
    expect(await run(["token", "list", "--page", "two", "--json"], c.io)).toBe(2)
    expect(JSON.parse(c.out())).toEqual({
      ok: false,
      code: "usage",
      message: "--page must be a whole number"
    })
  })

  it("rejects an unknown flag", async () => {
    const c = capture()
    expect(await run(["token", "list", "--bogus"], c.io)).toBe(2)
    expect(c.err()).toMatch(/^qualithm: unknown option/)
  })

  it("prints help for a verb", async () => {
    const c = capture()
    expect(await run(["token", "list", "-h"], c.io)).toBe(0)
    expect(c.out()).toBe(USAGE)
  })

  it("exits with the usage code when no token is set", async () => {
    const c = capture({ env: {} })
    expect(await run(["token", "list"], c.io)).toBe(2)
    expect(c.err()).toMatch(/^qualithm: api token missing/)
  })

  it("takes the token, URL and team from flags", async () => {
    const { fetch, requests } = fakePlatform()
    const c = capture({ env: {}, fetch })
    const args = ["token", "list", "--token", "qmt_y", "--url", "https://api.example.com"]
    expect(await run([...args, "--team", "team_1"], c.io)).toBe(0)
    expect(requests).toEqual([
      { method: "GET", path: "/v1/teams/team_1/api-tokens", userAgent: `qualithm/${VERSION}` }
    ])
  })
})

describe("token revoke", () => {
  it("revokes by id", async () => {
    const c = capture()
    expect(await run(["token", "revoke", "tok_1"], c.io)).toBe(0)
    expect(c.out()).toBe("api token tok_1 revoked\n")
  })

  it("prints the planned request on a dry run", async () => {
    const c = capture()
    expect(await run(["token", "rm", "--dry-run", "tok_1"], c.io)).toBe(0)
    expect(c.out()).toBe("dry-run: would DELETE /v1/teams/team_1/api-tokens/tok_1\n")
  })

  it("requires an id", async () => {
    const c = capture()
    expect(await run(["token", "revoke"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: token id is required\n")
  })

  it("maps a missing token to the not-found exit code", async () => {
    const c = capture()
    expect(await run(["token", "delete", "tok_2"], c.io)).toBe(4)
    expect(c.err()).toBe("qualithm: not found\n")
  })
})

describe("token create", () => {
  it("sends the builder to the app", async () => {
    const c = capture()
    expect(await run(["token", "new"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: create API tokens in the app, on your team page\n")
  })
})

describe("mcp", () => {
  it("serves only the board tools without a token", async () => {
    let names: string[] = []
    const c = capture({
      env: {},
      serveMcp: async (server) => {
        await Promise.resolve()
        names = Object.keys(
          (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
        )
      }
    })
    expect(await run(["mcp"], c.io)).toBe(0)
    expect(c.err()).toMatch(/^qualithm: api token missing.*; serving only the board tools\n$/)
    expect(names.sort()).toEqual([
      "board_console",
      "board_logs",
      "deploy_project",
      "flash_board",
      "list_boards",
      "reset_board"
    ])
  })

  it("serves the tools when a token is set", async () => {
    let served = false
    const c = capture({
      serveMcp: async () => {
        await Promise.resolve()
        served = true
      }
    })
    expect(await run(["mcp", "--team", "team_1"], c.io)).toBe(0)
    expect(served).toBe(true)
  })
})

describe("table cells", () => {
  it("dashes missing values and formats times", () => {
    expect(dash(null)).toBe("-")
    expect(dash("")).toBe("-")
    expect(when(undefined)).toBe("-")
    expect(when("")).toBe("-")
    expect(when(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z")
  })
})
