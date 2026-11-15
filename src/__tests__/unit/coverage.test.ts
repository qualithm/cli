import { describe, expect, it } from "vitest"

import { routeCoverage, specOperations } from "../../tools/coverage.ts"
import { TOOLS, UNTOOLED_OPERATIONS } from "../../tools/index.ts"
import { defineTool, type Tool } from "../../tools/tool.ts"

function op(operationId: string, audience?: string): Record<string, unknown> {
  return audience === undefined ? { operationId } : { operationId, "x-qualithm-audience": audience }
}

const spec = {
  paths: {
    "/v1/teams/{teamId}/devices": {
      parameters: [{ name: "teamId" }],
      get: op("listDevices", "management"),
      post: op("createDevice", "management")
    },
    "/v1/devices/{deviceId}/readings": { post: op("publishReading", "device") },
    "/healthz": { get: op("health", "infra") }
  }
}

function tool(name: string, operations: string[]): Tool {
  return defineTool({
    name,
    description: name,
    mutating: false,
    operations,
    input: {},
    run: async () => Promise.resolve(undefined)
  })
}

const devices = [tool("list_devices", ["listDevices"]), tool("create_device", ["createDevice"])]

describe("specOperations", () => {
  it("reads each operation's audience and skips path-level keys", () => {
    expect([...specOperations(spec)]).toEqual([
      ["listDevices", "management"],
      ["createDevice", "management"],
      ["publishReading", "device"],
      ["health", "infra"]
    ])
  })

  it("reads nothing from a document with no paths", () => {
    expect(specOperations(null).size).toBe(0)
    expect(specOperations({}).size).toBe(0)
  })
})

describe("routeCoverage", () => {
  it("passes when every management operation has a tool, needing none for device or infra", () => {
    expect(routeCoverage(spec, devices, {})).toEqual([])
  })

  it("fails a management operation with no tool and no tracked gap", () => {
    expect(routeCoverage(spec, devices.slice(0, 1), {})).toEqual([
      "createDevice is a management operation with no tool: add one, or list it in UNTOOLED_OPERATIONS with its issue"
    ])
  })

  it("accepts a management operation tracked as untooled", () => {
    expect(routeCoverage(spec, devices.slice(0, 1), { createDevice: "qualithm/pm#1" })).toEqual([])
  })

  it("fails an untooled entry a tool now calls, or one that isn't a management operation", () => {
    expect(
      routeCoverage(spec, devices, {
        createDevice: "qualithm/pm#1",
        publishReading: "qualithm/pm#2",
        gone: "qualithm/pm#3"
      })
    ).toEqual([
      "createDevice has a tool now: drop it from UNTOOLED_OPERATIONS (qualithm/pm#1)",
      "publishReading is untooled but isn't a management operation in the spec",
      "gone is untooled but isn't a management operation in the spec"
    ])
  })

  it("fails a tool that names an operation the spec doesn't have", () => {
    expect(routeCoverage(spec, [...devices, tool("old_tool", ["removedOp"])], {})).toEqual([
      "old_tool names removedOp, which the spec doesn't have"
    ])
  })

  it("fails an empty spec rather than passing it", () => {
    expect(routeCoverage({ paths: {} }, devices, {})).toEqual(["the spec has no operations"])
  })
})

describe("the served tools", () => {
  it("name each operation once, and every untooled entry names its issue", () => {
    for (const served of TOOLS) {
      expect(new Set(served.operations).size).toBe(served.operations.length)
    }
    for (const issue of Object.values(UNTOOLED_OPERATIONS)) {
      expect(issue).toMatch(/^qualithm\/pm#\d+$/)
    }
  })
})
