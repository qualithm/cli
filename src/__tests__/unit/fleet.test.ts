import { describe, expect, it } from "vitest"

import { run } from "../../cli.ts"
import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import { updateDevice } from "../../tools/devices.ts"
import { listSpaces } from "../../tools/spaces.ts"
import { capture, fakePlatform } from "./fake-platform.ts"

const session = (): Session => new Session({ token: "qmt_x", fetch: fakePlatform().fetch })

describe("device", () => {
  it("lists devices, optionally one space's", async () => {
    const c = capture()
    expect(await run(["devices", "ls"], c.io)).toBe(0)
    expect(c.out()).toMatch(/^ID\s+NAME\s+SPACE\s+SPACE-NAME\ndev_1\s+sensor\s+spc_1\s+lab\n$/)
    const one = capture()
    expect(await run(["device", "list", "--space", "spc_1", "--limit", "5"], one.io)).toBe(0)
    expect(one.requests.at(-1)?.path).toBe("/v1/teams/team_1/devices")
  })

  it("shows one device", async () => {
    const c = capture()
    expect(await run(["device", "show", "dev_1"], c.io)).toBe(0)
    expect(c.out()).toMatch(
      /^id\s+dev_1\nname\s+sensor\nspace\s+spc_1\nspaceName\s+lab\nparkedAt\s+-\n/
    )
  })

  it("creates a device in a space", async () => {
    const c = capture()
    expect(await run(["device", "new", "--space", "spc_1"], c.io)).toBe(0)
    expect(c.out()).toBe("device dev_1 (sensor) created in space spc_1\n")
  })

  it("requires a space to create", async () => {
    const c = capture()
    expect(await run(["device", "create"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --space is required\n")
  })

  it("renames, moves and parks a device", async () => {
    const c = capture()
    const args = ["device", "patch", "dev_1", "--name", "probe", "--space", "spc_2", "--park"]
    expect(await run(args, c.io)).toBe(0)
    expect(c.out()).toBe("device dev_1 updated\n")
    expect(c.requests.at(-1)).toMatchObject({
      method: "PATCH",
      body: { name: "probe", spaceId: "spc_2", parked: true }
    })
  })

  it("unparks a device", async () => {
    const c = capture()
    expect(await run(["device", "update", "dev_1", "--unpark"], c.io)).toBe(0)
    expect(c.requests.at(-1)?.body).toEqual({ parked: false })
  })

  it.each([
    [["device", "update", "dev_1"], "qualithm: set --name, --space, --park or --unpark\n"],
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
      message: "set name, spaceId or parked"
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

describe("space", () => {
  it("lists spaces, optionally one zone's", async () => {
    const c = capture()
    expect(await run(["spaces", "ls", "--zone", "de-fra-a"], c.io)).toBe(0)
    expect(c.out()).toMatch(/^ID\s+NAME\s+ZONE\s+DEVICES\nspc_1\s+lab\s+de-fra-a\s+1\n$/)
  })

  it("rejects a zone that doesn't exist", async () => {
    const c = capture()
    expect(await run(["space", "list", "--zone", "mars-a", "--json"], c.io)).toBe(2)
    expect(JSON.parse(c.out())).toMatchObject({ ok: false, code: "usage" })
    expect(await callTool(listSpaces, session, { zone: "de-fra-a" })).toMatchObject({ ok: true })
  })

  it("shows one space", async () => {
    const c = capture()
    expect(await run(["space", "get", "spc_1"], c.io)).toBe(0)
    expect(c.out()).toMatch(/^id\s+spc_1\nname\s+lab\nzone\s+de-fra-a\ndeviceTotal\s+1\n/)
  })

  it("creates a space in a zone", async () => {
    const c = capture()
    expect(await run(["space", "new", "--zone", "de-fra-a"], c.io)).toBe(0)
    expect(c.out()).toBe("space spc_1 (lab) created in zone de-fra-a\n")
    const missing = capture()
    expect(await run(["space", "create"], missing.io)).toBe(2)
    expect(missing.err()).toBe("qualithm: --zone is required\n")
  })

  it("renames a space", async () => {
    const c = capture()
    expect(await run(["space", "patch", "spc_1", "--name", "bench"], c.io)).toBe(0)
    expect(c.out()).toBe("space spc_1 renamed to bench\n")
    const missing = capture()
    expect(await run(["space", "update", "spc_1"], missing.io)).toBe(2)
    expect(missing.err()).toBe("qualithm: --name is required\n")
  })

  it("deletes a space", async () => {
    const c = capture()
    expect(await run(["space", "rm", "spc_1"], c.io)).toBe(0)
    expect(c.out()).toBe("space spc_1 deleted\n")
  })
})
