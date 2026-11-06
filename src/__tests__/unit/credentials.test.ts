import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { run } from "../../cli.ts"
import { capture } from "./fake-platform.ts"

const device = ["--device", "dev_1"]

describe("credential list", () => {
  it("prints a table for a device", async () => {
    const c = capture()
    expect(await run(["credentials", "ls", ...device], c.io)).toBe(0)
    expect(c.out()).toMatch(
      /^ID\s+KIND\s+LABEL\s+STATUS\s+EXPIRES\ncred_2\s+token\s+-\s+active\s+-\n$/
    )
  })

  it("requires a device", async () => {
    const c = capture()
    expect(await run(["credential", "list"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --device is required\n")
  })
})

describe("credential create", () => {
  it("creates a token and shows its secret once", async () => {
    const c = capture()
    const args = ["credential", "create", ...device, "--label", "lab"]
    expect(await run([...args, "--expires-at", "2026-12-31T00:00:00Z"], c.io)).toBe(0)
    expect(c.out()).toBe(
      "credential cred_2 created for device dev_1\nsecret (shown once): qmd_secret\n"
    )
    expect(c.requests.at(-1)?.body).toEqual({
      label: "lab",
      expiresAt: "2026-12-31T00:00:00.000Z"
    })
  })

  it("rejects an expiry that isn't RFC 3339 through the mint alias", async () => {
    const c = capture()
    expect(await run(["credential", "mint", ...device, "--expires-at", "tomorrow"], c.io)).toBe(2)
    expect(c.err()).toBe(
      "qualithm: --expires-at must be an RFC 3339 time, like 2026-12-31T00:00:00Z\n"
    )
  })
})

describe("credential cert", () => {
  it("issues a certificate from a CSR file", async () => {
    const csr = join(mkdtempSync(join(tmpdir(), "qualithm-cli-")), "device.csr")
    writeFileSync(csr, "CSR\n")
    const c = capture()
    const args = ["credential", "cert", ...device, "--csr-file", csr, "--expires-days", "7"]
    expect(await run(args, c.io)).toBe(0)
    expect(c.out()).toBe(
      "certificate cred_3 issued for device dev_1\nfingerprint: aa:bb\nCERT\nCA\n"
    )
    expect(c.requests.at(-1)?.body).toEqual({ csrPem: "CSR\n", expiresInDays: 7 })
  })

  it("requires a device and a CSR file", async () => {
    const c = capture()
    expect(await run(["credential", "cert", ...device], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --device and --csr-file are required\n")
  })

  it("reports an unreadable CSR file as an error", async () => {
    const c = capture()
    expect(await run(["credential", "cert", ...device, "--csr-file", "/no/such.csr"], c.io)).toBe(1)
    expect(c.err()).toMatch(/^qualithm: read csr: /)
  })
})

describe("credential rotate", () => {
  it("rotates and revokes the old credential when asked", async () => {
    const c = capture()
    const args = ["credential", "rotate", ...device, "--credential", "cred_1", "--revoke"]
    expect(await run(args, c.io)).toBe(0)
    expect(c.out()).toBe("credential rotated: cred_1 -> cred_2\nsecret (shown once): qmd_new\n")
    expect(c.requests.at(-1)).toMatchObject({ method: "POST" })
  })

  it("plans the rotation on a dry run, with the revoke flag in the query", async () => {
    const c = capture()
    const args = ["credential", "rotate", ...device, "--credential", "cred_1", "--revoke"]
    expect(
      await run([...args, "--expires-at", "2026-12-31T00:00:00Z", "--dry-run", "--json"], c.io)
    ).toBe(0)
    expect(JSON.parse(c.out())).toEqual({
      ok: true,
      dryRun: true,
      action: {
        method: "POST",
        path: "/v1/teams/team_1/devices/dev_1/credentials/cred_1/rotate?revoke=true",
        body: { expiresAt: "2026-12-31T00:00:00.000Z" }
      }
    })
  })

  it("keeps the old credential by default", async () => {
    const c = capture()
    const args = [
      "credential",
      "rotate",
      ...device,
      "--credential",
      "cred_1",
      "--dry-run",
      "--json"
    ]
    expect(await run(args, c.io)).toBe(0)
    expect((JSON.parse(c.out()) as { action: { path: string } }).action.path).not.toContain(
      "revoke"
    )
  })

  it("requires a device and a credential", async () => {
    const c = capture()
    expect(await run(["credential", "rotate", ...device], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --device and --credential are required\n")
  })
})

describe("credential revoke", () => {
  it("revokes by device and id", async () => {
    const c = capture()
    expect(await run(["credential", "rm", ...device, "--credential", "cred_1"], c.io)).toBe(0)
    expect(c.out()).toBe("credential cred_1 revoked\n")
  })
})
