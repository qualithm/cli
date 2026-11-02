import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { run, USAGE } from "../../cli.ts"
import { table } from "../../table.ts"
import { capture, DEFAULT_ROUTES, DEVICE, type Reply } from "./fake-platform.ts"

const dir = mkdtempSync(join(tmpdir(), "qualithm-apply-"))
let files = 0

function manifest(body: string): string {
  files++
  const path = join(dir, `fleet-${String(files)}.yaml`)
  writeFileSync(path, body)
  return path
}

const ONE = "scopes:\n  - id: spc_1\n    devices:\n      - name: gw-1\n"

const pageOf = (items: unknown[], last = 1): Reply => ({
  status: 200,
  body: { data: { items, current: 1, last } }
})

const NEW_DEVICE = { ...DEVICE, id: "dev_new", name: "" }

const routes = (extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  ...DEFAULT_ROUTES,
  "GET /v1/teams/team_1/devices": pageOf([]),
  "POST /v1/teams/team_1/devices": { status: 201, body: { data: NEW_DEVICE } },
  "PATCH /v1/teams/team_1/devices/dev_new": { status: 204 },
  ...extra
})

const mutations = (
  c: ReturnType<typeof capture>
): { method: string; path: string; body: unknown }[] =>
  c.requests
    .filter((r) => r.method !== "GET")
    .map((r) => ({ method: r.method, path: r.path, body: r.body }))

describe("apply", () => {
  it("creates a missing device and names it after the manifest", async () => {
    const c = capture({}, routes())
    expect(await run(["apply", manifest(ONE)], c.io)).toBe(0)
    expect(mutations(c)).toEqual([
      { method: "POST", path: "/v1/teams/team_1/devices", body: { scopeId: "spc_1" } },
      { method: "PATCH", path: "/v1/teams/team_1/devices/dev_new", body: { name: "gw-1" } }
    ])
    expect(c.out()).toBe(
      table([
        ["SCOPE", "DEVICE", "ACTION", "ID"],
        ["spc_1", "gw-1", "create", "dev_new"]
      ])
    )
  })

  it("leaves an existing device alone and prints the results as the envelope's data", async () => {
    const c = capture(
      {},
      routes({ "GET /v1/teams/team_1/devices": pageOf([{ ...DEVICE, name: "gw-1" }]) })
    )
    expect(await run(["apply", manifest(ONE), "--json"], c.io)).toBe(0)
    expect(mutations(c)).toEqual([])
    const lines = c.out().trimEnd().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ok: true,
      data: [{ scope: "spc_1", device: "gw-1", action: "exists" }]
    })
  })

  it("lists every page of a scope's devices, filtered by scope", async () => {
    const c = capture(
      {},
      routes({ "GET /v1/teams/team_1/devices": pageOf([{ ...DEVICE, name: "gw-1" }], 2) })
    )
    expect(await run(["apply", manifest(ONE)], c.io)).toBe(0)
    const lists = c.requests.filter((r) => r.path === "/v1/teams/team_1/devices")
    expect(lists).toHaveLength(2)
    expect(c.out()).toContain("exists")
  })

  it("parses a JSON manifest and a scope with no devices", async () => {
    const path = manifest(
      JSON.stringify({ scopes: [{ id: "spc_1", devices: [{ name: "gw-1" }] }, { id: "spc_2" }] })
    )
    const c = capture({}, routes({ "GET /v1/teams/team_1/devices": pageOf([], 0) }))
    expect(await run(["apply", path, "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out())).toEqual({
      ok: true,
      data: [{ scope: "spc_1", device: "gw-1", action: "create", id: "dev_new" }]
    })
  })

  it("reports would-create on a dry run without sending a mutation", async () => {
    const c = capture({}, routes())
    expect(await run(["apply", manifest(ONE), "--dry-run"], c.io)).toBe(0)
    expect(mutations(c)).toEqual([])
    expect(c.out()).toBe(
      table([
        ["SCOPE", "DEVICE", "ACTION", "ID"],
        ["spc_1", "gw-1", "would-create", "-"]
      ])
    )
  })

  it("marks the JSON envelope a dry run", async () => {
    const c = capture({}, routes())
    expect(await run(["apply", manifest(ONE), "--dry-run", "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out())).toEqual({
      ok: true,
      dryRun: true,
      data: [{ scope: "spc_1", device: "gw-1", action: "would-create" }]
    })
  })

  it("passes on a failed list or create", async () => {
    const forbidden = capture(
      {},
      routes({ "GET /v1/teams/team_1/devices": { status: 403, body: { message: "forbidden" } } })
    )
    expect(await run(["apply", manifest(ONE)], forbidden.io)).toBe(3)
    expect(forbidden.err()).toContain("forbidden")

    const conflict = capture(
      {},
      routes({ "POST /v1/teams/team_1/devices": { status: 409, body: { message: "limit" } } })
    )
    expect(await run(["apply", manifest(ONE), "--json"], conflict.io)).toBe(5)
    expect(JSON.parse(conflict.out())).toMatchObject({ ok: false, code: "conflict" })
  })

  it("requires a manifest path", async () => {
    const c = capture()
    expect(await run(["apply"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: a manifest path is required\n")
    expect(c.requests).toEqual([])
  })

  it("prints usage on --help", async () => {
    const c = capture()
    expect(await run(["apply", "--help"], c.io)).toBe(0)
    expect(c.out()).toBe(USAGE)
  })

  it("fails to read a missing manifest", async () => {
    const c = capture()
    expect(await run(["apply", join(dir, "missing.yaml"), "--json"], c.io)).toBe(1)
    expect(JSON.parse(c.out())).toMatchObject({ ok: false, code: "error" })
    expect((JSON.parse(c.out()) as { message: string }).message).toMatch(/^read manifest: /)
  })

  it.each([
    ["malformed YAML", "scopes: [oops\n", /^parse manifest: /],
    ["the wrong shape", "scopes: 5\n", /^parse manifest: scopes: /],
    ["no scopes", "scopes: []\n", /^manifest declares no scopes$/],
    ["an empty file", "", /^manifest declares no scopes$/],
    ["a scope without an id", "scopes:\n  - devices:\n      - name: gw\n", /missing an id$/],
    [
      "a device without a name",
      'scopes:\n  - id: spc_1\n    devices:\n      - name: ""\n',
      /missing a name$/
    ]
  ])("rejects %s as usage", async (_label, body, message) => {
    const c = capture()
    expect(await run(["apply", manifest(body), "--json"], c.io)).toBe(2)
    const result = JSON.parse(c.out()) as { ok: boolean; code: string; message: string }
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(result.message).toMatch(message)
    expect(c.requests).toEqual([])
  })
})
