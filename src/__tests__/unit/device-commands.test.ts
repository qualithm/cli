import { describe, expect, it } from "vitest"

import { callTool } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import {
  deviceCommandTools,
  getDeviceCapabilities,
  listDeviceCommands,
  sendDeviceCommand
} from "../../tools/device-commands.ts"
import { DEFAULT_ROUTES, fakePlatform } from "./fake-platform.ts"

const COMMAND = {
  id: "cmd_1",
  capability: "power",
  status: "pending",
  createdAt: "2026-10-01T00:00:00.000Z"
}

const CAPABILITY = {
  id: "cap_1",
  deviceId: "dev_1",
  key: "power",
  type: "onoff",
  config: {},
  name: null,
  tags: []
}

const ROUTES = {
  ...DEFAULT_ROUTES,
  "GET /v1/teams/team_1/devices/dev_1/commands": {
    status: 200,
    body: { data: { items: [COMMAND], current: 1, last: 1, total: 1, limit: 20 } }
  },
  "POST /v1/teams/team_1/devices/dev_1/commands": {
    status: 202,
    body: { data: { id: "cmd_1", duplicate: false } }
  },
  "GET /v1/teams/team_1/devices/dev_1/capabilities": { status: 200, body: { data: [CAPABILITY] } }
}

function platform(): ReturnType<typeof fakePlatform> & {
  newSession: (dryRun: boolean) => Session
} {
  const fake = fakePlatform(ROUTES)
  return {
    ...fake,
    newSession: (dryRun) => new Session({ token: "qmt_x", fetch: fake.fetch, dryRun })
  }
}

describe("device command tools", () => {
  it("registers in Go order", () => {
    expect(deviceCommandTools.map((t) => t.name)).toEqual([
      "list_device_commands",
      "send_device_command",
      "get_device_capabilities"
    ])
  })

  it("lists a device's commands", async () => {
    const { newSession, requests } = platform()
    const result = await callTool(listDeviceCommands, newSession, { deviceId: "dev_1", limit: 5 })
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: "cmd_1" }] } })
    expect(requests.at(-1)).toMatchObject({
      method: "GET",
      path: "/v1/teams/team_1/devices/dev_1/commands"
    })
  })

  it("sends a command with its value", async () => {
    const { newSession, requests } = platform()
    const result = await callTool(sendDeviceCommand, newSession, {
      deviceId: "dev_1",
      capability: "level",
      value: { level: 3 },
      dedupKey: "k1"
    })
    expect(result).toEqual({ ok: true, data: { id: "cmd_1", duplicate: false } })
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/teams/team_1/devices/dev_1/commands",
      body: { capability: "level", value: { level: 3 }, dedupKey: "k1" }
    })
  })

  it("sends a trigger command without a value", async () => {
    const { newSession, requests } = platform()
    await callTool(sendDeviceCommand, newSession, {
      deviceId: "dev_1",
      capability: "reboot",
      dedupKey: "k2"
    })
    expect(requests.at(-1)?.body).toEqual({ capability: "reboot", dedupKey: "k2" })
  })

  it("plans a command on a dry run without sending it", async () => {
    const { newSession, requests } = platform()
    const result = await callTool(sendDeviceCommand, newSession, {
      deviceId: "dev_1",
      capability: "power",
      value: true,
      dedupKey: "k3",
      dryRun: true
    })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      action: {
        method: "POST",
        path: "/v1/teams/team_1/devices/dev_1/commands",
        body: { capability: "power", value: true, dedupKey: "k3" }
      }
    })
    expect(requests.map((r) => r.method)).toEqual(["GET"])
  })

  it("rejects a command without a dedupKey", async () => {
    const { newSession, requests } = platform()
    const result = await callTool(sendDeviceCommand, newSession, {
      deviceId: "dev_1",
      capability: "power"
    })
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(requests).toEqual([])
  })

  it("lists a device's capabilities", async () => {
    const { newSession, requests } = platform()
    const result = await callTool(getDeviceCapabilities, newSession, { deviceId: "dev_1" })
    expect(result).toMatchObject({ ok: true, data: [{ key: "power", type: "onoff" }] })
    expect(requests.at(-1)?.path).toBe("/v1/teams/team_1/devices/dev_1/capabilities")
  })
})
