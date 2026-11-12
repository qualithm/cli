import { describe, expect, it } from "vitest"

import { run } from "../../cli.ts"
import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import { getDevice, updateDevice } from "../../tools/devices.ts"
import { createScope, listScopes } from "../../tools/scopes.ts"
import { capture, DEFAULT_ROUTES, DEVICE, fakePlatform } from "./fake-platform.ts"

const session = (): Session => new Session({ token: "qmt_x", fetch: fakePlatform().fetch })

describe("device", () => {
  it("lists devices, optionally one scope's", async () => {
    const c = capture()
    expect(await run(["devices", "ls"], c.io)).toBe(0)
    expect(c.out()).toMatch(/^ID\s+NAME\s+SCOPE\s+LEVEL\ndev_1\s+sensor\s+spc_1\s+-\n$/)
    expect(c.requests.at(-1)?.path).toBe("/v1/teams/team_1/devices")
    const one = capture()
    expect(await run(["device", "list", "--scope", "spc_1", "--limit", "5"], one.io)).toBe(0)
    expect(one.requests.at(-1)?.path).toBe("/v1/teams/team_1/scopes/spc_1/devices")
  })

  it("shows each device's state: online, last seen and metrics", async () => {
    const items = [
      {
        deviceId: "dev_1",
        scopeId: "spc_1",
        spaceId: "spc_1",
        online: true,
        lastSeenAt: "2026-10-20T10:00:00.000Z",
        metrics: { temperature: 21.5, rssi: -60 }
      },
      {
        deviceId: "dev_2",
        scopeId: "spc_1",
        spaceId: "spc_1",
        online: false,
        lastSeenAt: "2026-10-19T08:00:00.000Z",
        metrics: {}
      }
    ]
    const routes = {
      ...DEFAULT_ROUTES,
      "GET /v1/teams/team_1/device-states": {
        status: 200,
        body: { data: { items, current: 1, last: 1, nextCursor: null } }
      }
    }
    const c = capture({}, routes)
    expect(await run(["device", "state", "--limit", "5"], c.io)).toBe(0)
    expect(c.out()).toBe(
      "ID     SCOPE  ONLINE  LAST SEEN                 METRICS\n" +
        "dev_1  spc_1  yes     2026-10-20T10:00:00.000Z  temperature=21.5 rssi=-60\n" +
        "dev_2  spc_1  no      2026-10-19T08:00:00.000Z  -\n"
    )
    expect(c.requests.at(-1)).toMatchObject({ path: "/v1/teams/team_1/device-states" })
    const json = capture({}, routes)
    expect(await run(["device", "state", "--json"], json.io)).toBe(0)
    const envelope = JSON.parse(json.out()) as { ok: boolean; data: { items: unknown[] } }
    expect(envelope.ok).toBe(true)
    expect(envelope.data.items[0]).toMatchObject({
      deviceId: "dev_1",
      online: true,
      lastSeenAt: "2026-10-20T10:00:00.000Z"
    })
  })

  it("shows one device", async () => {
    const c = capture()
    expect(await run(["device", "show", "dev_1"], c.io)).toBe(0)
    expect(c.out()).toMatch(/^id\s+dev_1\nname\s+sensor\nscope\s+spc_1\nparkedAt\s+-\n/)
  })

  it("prints a development device's level and each check, with the fix for a failing one", async () => {
    const checks = [
      { id: "credential-certificate", pass: false, evidence: "the device connects with a token" },
      { id: "key-protected", pass: true, evidence: "its key was generated in a secure element" }
    ]
    const c = capture(
      {},
      {
        ...DEFAULT_ROUTES,
        "GET /v1/teams/team_1/devices": {
          status: 200,
          body: {
            data: {
              items: [{ ...DEVICE, level: "development", checks }],
              current: 1,
              last: 1,
              total: 1,
              limit: 20,
              nextCursor: null
            }
          }
        },
        "GET /v1/teams/team_1/devices/dev_1": {
          status: 200,
          body: { data: { ...DEVICE, level: "development", checks } }
        }
      }
    )
    expect(await run(["device", "get", "dev_1"], c.io)).toBe(0)
    expect(c.out()).toContain(
      "\nLevel: Development\n" +
        "A device reaches production when every check passes.\n" +
        "Certificate credential  fail  The device connects with a token. " +
        "Connect the device with a certificate, then revoke its tokens.\n" +
        "Protected key           pass  Its key was generated in a secure element.\n"
    )
    expect(await run(["device", "list"], c.io)).toBe(0)
    expect(c.out()).toMatch(/dev_1\s+sensor\s+spc_1\s+Development\n/)
  })

  it("prints a production device's level without the hint", async () => {
    const checks = [{ id: "firmware-signed", pass: true, evidence: "the firmware is signed" }]
    const c = capture(
      {},
      {
        ...DEFAULT_ROUTES,
        "GET /v1/teams/team_1/devices/dev_1": {
          status: 200,
          body: { data: { ...DEVICE, level: "production", checks } }
        }
      }
    )
    expect(await run(["device", "get", "dev_1"], c.io)).toBe(0)
    expect(c.out()).toContain(
      "\nLevel: Production\nSigned firmware  pass  The firmware is signed.\n"
    )
    expect(c.out()).not.toContain("reaches production")
  })

  it("hands MCP the device's level and checks as data", async () => {
    const checks = [{ id: "credential-current", pass: true, evidence: "every credential expires" }]
    const withLevel = (): Session =>
      new Session({
        token: "qmt_x",
        fetch: fakePlatform({
          ...DEFAULT_ROUTES,
          "GET /v1/teams/team_1/devices/dev_1": {
            status: 200,
            body: { data: { ...DEVICE, level: "production", checks } }
          }
        }).fetch
      })
    expect(await callTool(getDevice, withLevel, { deviceId: "dev_1" })).toMatchObject({
      ok: true,
      data: { id: "dev_1", level: "production", checks }
    })
  })

  it("prints what the claim decided after the device", async () => {
    const decisions = [
      {
        key: "zone",
        label: "Zone",
        value: "Singapore (sg-sin-a)",
        source: "scope",
        docsUrl: "https://docs.qualithm.com/zones"
      },
      {
        key: "credential",
        label: "Credential",
        value: "token",
        source: "credential",
        docsUrl: "https://docs.qualithm.com/http#move-a-device-to-a-certificate"
      }
    ]
    const c = capture(
      {},
      {
        ...DEFAULT_ROUTES,
        "GET /v1/teams/team_1/devices/dev_1": {
          status: 200,
          body: { data: { ...DEVICE, decisions } }
        }
      }
    )
    expect(await run(["device", "get", "dev_1"], c.io)).toBe(0)
    expect(c.out()).toContain(
      "\nDecided at claim\n" +
        "Zone        Singapore (sg-sin-a)  https://docs.qualithm.com/zones\n" +
        "Credential  token                 https://docs.qualithm.com/http#move-a-device-to-a-certificate\n"
    )
  })

  it("hands MCP the claim's decisions as data, and a device without them unchanged", async () => {
    const decisions = [
      { key: "zone", label: "Zone", value: "de-fra-a", source: "scope", docsUrl: "https://d/z" }
    ]
    const withDecisions = (): Session =>
      new Session({
        token: "qmt_x",
        fetch: fakePlatform({
          ...DEFAULT_ROUTES,
          "GET /v1/teams/team_1/devices/dev_1": {
            status: 200,
            body: { data: { ...DEVICE, decisions } }
          }
        }).fetch
      })
    expect(await callTool(getDevice, withDecisions, { deviceId: "dev_1" })).toMatchObject({
      ok: true,
      data: { id: "dev_1", decisions }
    })
    const plain = await callTool(getDevice, session, { deviceId: "dev_1" })
    expect(plain).toMatchObject({ ok: true, data: { id: "dev_1" } })
    expect((plain as { data: { decisions?: unknown } }).data.decisions).toBeUndefined()
  })

  it("creates a device in a scope", async () => {
    const c = capture()
    expect(await run(["device", "new", "--scope", "spc_1"], c.io)).toBe(0)
    expect(c.out()).toBe("device dev_1 (sensor) created in scope spc_1\n")
  })

  it("requires a scope to create", async () => {
    const c = capture()
    expect(await run(["device", "create"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --scope is required\n")
  })

  it("renames, moves and parks a device", async () => {
    const c = capture()
    const args = ["device", "patch", "dev_1", "--name", "probe", "--scope", "spc_2", "--park"]
    expect(await run(args, c.io)).toBe(0)
    expect(c.out()).toBe("device dev_1 updated\n")
    expect(c.requests.at(-1)).toMatchObject({
      method: "PATCH",
      body: { name: "probe", scopeId: "spc_2", parked: true }
    })
  })

  it("unparks a device", async () => {
    const c = capture()
    expect(await run(["device", "update", "dev_1", "--unpark"], c.io)).toBe(0)
    expect(c.requests.at(-1)?.body).toEqual({ parked: false })
  })

  it.each([
    [["device", "update", "dev_1"], "qualithm: set --name, --scope, --park or --unpark\n"],
    [
      ["device", "update", "dev_1", "--park", "--unpark"],
      "qualithm: --park and --unpark can't be used together\n"
    ],
    [["device", "update"], "qualithm: device id is required\n"]
  ])("refuses %j", async (args, message) => {
    const c = capture()
    expect(await run(args, c.io)).toBe(2)
    expect(c.err()).toBe(message)
  })

  it("refuses an empty update over MCP too", async () => {
    expect(await callTool(updateDevice, session, { deviceId: "dev_1" })).toEqual({
      ok: false,
      code: "usage",
      message: "set name, scopeId or parked"
    })
  })

  it("deletes a device, and plans it on a dry run", async () => {
    const c = capture()
    expect(await run(["device", "rm", "dev_1"], c.io)).toBe(0)
    expect(c.out()).toBe("device dev_1 deleted\n")
    const dry = capture()
    expect(await run(["device", "delete", "dev_1", "--dry-run"], dry.io)).toBe(0)
    expect(dry.out()).toBe("dry-run: would DELETE /v1/teams/team_1/devices/dev_1\n")
  })
})

describe("scope", () => {
  it("lists scopes, optionally one zone's or one parent's children", async () => {
    const c = capture()
    expect(await run(["scopes", "ls", "--zone", "de-fra-a"], c.io)).toBe(0)
    expect(c.out()).toMatch(
      /^ID\s+NAME\s+ZONE\s+PARENT\s+DEVICES\nspc_1\s+lab\s+de-fra-a\s+-\s+1\n$/
    )
    const children = capture()
    expect(await run(["scope", "list", "--parent", "spc_1"], children.io)).toBe(0)
    expect(children.requests.at(-1)?.path).toBe("/v1/teams/team_1/scopes")
  })

  it("rejects a zone that doesn't exist", async () => {
    const c = capture()
    expect(await run(["scope", "list", "--zone", "mars-a", "--json"], c.io)).toBe(2)
    expect(JSON.parse(c.out())).toMatchObject({ ok: false, code: "usage" })
    expect(await callTool(listScopes, session, { zone: "de-fra-a" })).toMatchObject({ ok: true })
  })

  it("shows one scope", async () => {
    const c = capture()
    expect(await run(["scope", "get", "spc_1"], c.io)).toBe(0)
    expect(c.out()).toMatch(
      /^id\s+spc_1\nname\s+lab\nzone\s+de-fra-a\nparentId\s+-\ndeviceTotal\s+1\n/
    )
  })

  it("creates a scope in a zone or under a parent", async () => {
    const c = capture()
    expect(await run(["scope", "new", "--name", "lab", "--zone", "de-fra-a"], c.io)).toBe(0)
    expect(c.out()).toBe("scope spc_1 (lab) created in zone de-fra-a\n")
    expect(c.requests.at(-1)?.body).toEqual({ name: "lab", zone: "de-fra-a" })
    const child = capture()
    expect(await run(["scope", "new", "--name", "bench", "--parent", "spc_1"], child.io)).toBe(0)
    expect(child.requests.at(-1)?.body).toEqual({ name: "bench", parentId: "spc_1" })
    const unnamed = capture()
    expect(await run(["scope", "create", "--zone", "de-fra-a"], unnamed.io)).toBe(2)
    expect(unnamed.err()).toBe("qualithm: --name is required\n")
    const neither = capture()
    expect(await run(["scope", "create", "--name", "lab"], neither.io)).toBe(2)
    expect(neither.err()).toBe(
      "qualithm: set --zone for a top-level scope or --parent for a child scope\n"
    )
  })

  it("rejects a scope with both or neither of zone and parent", async () => {
    const both = await callTool(createScope, session, {
      name: "lab",
      zone: "de-fra-a",
      parentId: "spc_1"
    })
    expect(both).toMatchObject({ ok: false, code: "usage" })
    expect(await callTool(createScope, session, { name: "lab" })).toMatchObject({ ok: false })
  })

  it("renames a scope", async () => {
    const c = capture()
    expect(await run(["scope", "patch", "spc_1", "--name", "bench"], c.io)).toBe(0)
    expect(c.out()).toBe("scope spc_1 renamed to bench\n")
    const missing = capture()
    expect(await run(["scope", "update", "spc_1"], missing.io)).toBe(2)
    expect(missing.err()).toBe("qualithm: --name is required\n")
  })

  it("deletes a scope", async () => {
    const c = capture()
    expect(await run(["scope", "rm", "spc_1"], c.io)).toBe(0)
    expect(c.out()).toBe("scope spc_1 deleted\n")
  })
})
