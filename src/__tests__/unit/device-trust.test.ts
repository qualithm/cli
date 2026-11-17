import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { run } from "../../cli.ts"
import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import { createAuthority } from "../../tools/authorities.ts"
import { capture, fakePlatform } from "./fake-platform.ts"

describe("authority list", () => {
  it("prints a table", async () => {
    const c = capture()
    expect(await run(["authorities", "ls"], c.io)).toBe(0)
    expect(c.out()).toMatch(/^ID\s+NAME\s+KIND\s+STATUS\s+FINGERPRINT\nca_1\s+fleet\s+platform/)
  })

  it("prints one envelope line with --json", async () => {
    const c = capture()
    expect(await run(["authority", "list", "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out())).toMatchObject({ ok: true, data: { items: [{ id: "ca_1" }] } })
  })
})

describe("authority create", () => {
  it("registers a platform authority by default", async () => {
    const c = capture()
    expect(await run(["authority", "register", "--name", "fleet"], c.io)).toBe(0)
    expect(c.out()).toBe("authority ca_1 (fleet) registered\n")
    expect(c.requests.at(-1)).toMatchObject({
      method: "POST",
      body: { name: "fleet", kind: "platform" }
    })
  })

  it("reads a byo certificate from --cert-file and plans it on a dry run", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "qualithm-cli-")), "ca.pem")
    writeFileSync(file, "-----BEGIN CERTIFICATE-----\n")
    const c = capture()
    const args = ["authority", "create", "--name", "own", "--kind", "byo", "--cert-file", file]
    expect(await run([...args, "--dry-run", "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out())).toEqual({
      ok: true,
      dryRun: true,
      action: {
        method: "POST",
        path: "/v1/teams/team_1/authorities",
        body: { name: "own", kind: "byo", certificatePem: "-----BEGIN CERTIFICATE-----\n" }
      }
    })
  })

  it.each([
    [["authority", "create"], "qualithm: --name is required\n", 2],
    [
      ["authority", "create", "--name", "x", "--kind", "byo"],
      "qualithm: --cert-file is required for byo authorities\n",
      2
    ],
    [["authority", "create", "--name", "x", "--kind", "other"], /^qualithm: kind: /, 2]
  ] as const)("refuses %j", async (args, message, code) => {
    const c = capture()
    expect(await run([...args], c.io)).toBe(code)
    expect(c.err()).toMatch(message)
  })

  it("reports an unreadable certificate file as an error", async () => {
    const c = capture()
    const args = ["authority", "create", "--name", "x", "--kind", "byo"]
    expect(await run([...args, "--cert-file", "/no/such/ca.pem"], c.io)).toBe(1)
    expect(c.err()).toMatch(/^qualithm: read cert: /)
  })

  it("requires the certificate for byo over MCP too", async () => {
    const { fetch } = fakePlatform()
    const result = await callTool(createAuthority, () => new Session({ token: "qmt_x", fetch }), {
      name: "own",
      kind: "byo"
    })
    expect(result).toEqual({
      ok: false,
      code: "usage",
      message: "certificatePem is required when kind is byo"
    })
  })
})

describe("authority revoke", () => {
  it("revokes by id", async () => {
    const c = capture()
    expect(await run(["authority", "rm", "ca_1"], c.io)).toBe(0)
    expect(c.out()).toBe("authority ca_1 revoked\n")
  })

  it("requires an id", async () => {
    const c = capture()
    expect(await run(["authority", "revoke"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: authority id is required\n")
  })
})

describe("enrollment", () => {
  it("lists claim codes", async () => {
    const c = capture()
    expect(await run(["enrollments", "list"], c.io)).toBe(0)
    expect(c.out()).toMatch(/\nenr_1\s+spc_1\s+-\s+pending\s+2026-10-02T00:00:00.000Z\n$/)
  })

  it("creates a claim code and shows it once", async () => {
    const c = capture()
    const args = ["enrollment", "new", "--scope", "spc_1", "--label", "lab"]
    expect(await run([...args, "--expires-minutes", "60"], c.io)).toBe(0)
    expect(c.out()).toBe(
      "claim code enr_1 created for scope spc_1\nclaim code (shown once): QM-1234\n"
    )
    expect(c.requests.at(-1)?.body).toEqual({
      scopeId: "spc_1",
      label: "lab",
      expiresInMinutes: 60
    })
  })

  it("sends only the scope when nothing else is given", async () => {
    const c = capture()
    expect(await run(["enrollment", "create", "--scope", "spc_1"], c.io)).toBe(0)
    expect(c.requests.at(-1)?.body).toEqual({ scopeId: "spc_1" })
  })

  it("requires a scope", async () => {
    const c = capture()
    expect(await run(["enrollment", "create"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --scope is required\n")
  })

  it("revokes by id, and plans it on a dry run", async () => {
    const c = capture()
    expect(await run(["enrollment", "delete", "enr_1"], c.io)).toBe(0)
    expect(c.out()).toBe("claim code enr_1 revoked\n")
    const dry = capture()
    expect(await run(["enrollment", "revoke", "enr_1", "--dry-run"], dry.io)).toBe(0)
    expect(dry.out()).toBe("dry-run: would DELETE /v1/teams/team_1/enrollments/enr_1\n")
  })
})
