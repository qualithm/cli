import type { DeviceCredential } from "@qualithm/device"
import { describe, expect, it } from "vitest"

import { sdkDevice } from "../../../eval/device.ts"
import { type EvalIo, EXIT_CONFIG, runAgentEval } from "../../../eval/main.ts"
import { decodeToolResult, EvalToolError, type McpConnection } from "../../../eval/mcp-client.ts"
import type { DeviceDriver } from "../../../eval/run.ts"

type Harness = {
  io: EvalIo & Required<Pick<EvalIo, "connect" | "device" | "writeReport">>
  out: () => string
  err: () => string
  written: Record<string, string>
  started: { command: string; args: string[]; env: Record<string, string> }[]
  closed: () => boolean
}

function io(env: Record<string, string>, connection?: Partial<McpConnection>): Harness {
  let out = ""
  let err = ""
  const written: Record<string, string> = {}
  const started: { command: string; args: string[]; env: Record<string, string> }[] = []
  let closed = false
  const device: DeviceDriver = {
    claim: async () => Promise.resolve({ deviceId: "dev_1" }),
    publishTelemetry: async () => Promise.resolve()
  }
  return {
    io: {
      stdout: (t: string) => {
        out += t
      },
      stderr: (t: string) => {
        err += t
      },
      env,
      connect: async (command: string, args: string[], serverEnv: Record<string, string>) => {
        started.push({ command, args, env: serverEnv })
        await Promise.resolve()
        return {
          call: async () => Promise.reject(new EvalToolError("list_spaces: auth: no")),
          close: async () => {
            closed = true
            await Promise.resolve()
          },
          ...connection
        }
      },
      device: () => device,
      writeReport: async (path: string, text: string) => {
        written[path] = text
        await Promise.resolve()
      }
    },
    out: () => out,
    err: () => err,
    written,
    started,
    closed: () => closed
  }
}

const ENV = { QUALITHM_API_TOKEN: "qmt_x", PATH: "/bin" }

describe("runAgentEval", () => {
  it.each([
    [[], ENV, "agent-eval: --server and QUALITHM_API_TOKEN are required; the eval did not run\n"],
    [
      ["--server", "/srv/qualithm.js"],
      {},
      "agent-eval: --server and QUALITHM_API_TOKEN are required; the eval did not run\n"
    ],
    [
      ["--server", "dist/qualithm.js"],
      ENV,
      "agent-eval: --server must be an absolute path, got dist/qualithm.js\n"
    ]
  ])("exits %s without running when config is missing", async (argv, env, message) => {
    const c = io(env)
    expect(await runAgentEval(argv, c.io)).toBe(EXIT_CONFIG)
    expect(c.err()).toBe(message)
    expect(c.started).toEqual([])
  })

  it("starts qualithm mcp with only the token, API URL and PATH, and fails on a failed step", async () => {
    const c = io({ ...ENV, SECRET: "x", AGENT_EVAL_SERVER: "/srv/qualithm.js" })
    expect(await runAgentEval(["--out", "/tmp/r.json"], c.io)).toBe(1)
    expect(c.started[0]?.args).toEqual(["/srv/qualithm.js", "mcp"])
    expect(c.started[0]?.env).toEqual({
      PATH: "/bin",
      QUALITHM_API_TOKEN: "qmt_x",
      QUALITHM_API_URL: "https://api.test.qualithm.com"
    })
    expect(c.out()).toMatch(/^agent-eval FAIL/)
    expect(JSON.parse(c.written["/tmp/r.json"] ?? "")).toMatchObject({ ok: false })
    expect(c.closed()).toBe(true)
  })

  it("passes when every step does, with the API URL and zone from flags", async () => {
    const replies: Record<string, unknown> = {
      list_spaces: { items: [] },
      create_space: { id: "spc_1" },
      create_enrollment: { enrollment: { id: "enr_1" }, code: "QM" },
      get_telemetry: { items: [] }
    }
    let value = 0
    const c = io(ENV, {
      call: async (name, args) => {
        await Promise.resolve()
        if (name === "get_telemetry") {
          return { items: [{ value }] }
        }
        if (name === "create_space") {
          expect(args).toEqual({ zone: "de-fra-a" })
        }
        return replies[name]
      }
    })
    c.io.device = () => ({
      claim: async () => Promise.resolve({ deviceId: "dev_1" }),
      publishTelemetry: async (_m, v) => {
        value = v
        await Promise.resolve()
      }
    })
    const argv = [
      "--server",
      "/srv/q.js",
      "--api-url",
      "https://api.dev.qualithm.com",
      "--zone",
      "de-fra-a"
    ]
    expect(await runAgentEval(argv, c.io)).toBe(0)
    expect(c.started[0]?.env.QUALITHM_API_URL).toBe("https://api.dev.qualithm.com")
  })

  it("fails when the server won't start", async () => {
    const c = io(ENV)
    c.io.connect = async () => Promise.reject(new Error("spawn ENOENT"))
    expect(await runAgentEval(["--server", "/srv/q.js"], c.io)).toBe(1)
    expect(c.err()).toBe("agent-eval: start qualithm mcp: spawn ENOENT\n")
  })
})

describe("decodeToolResult", () => {
  it("returns the envelope's data", () => {
    expect(decodeToolResult("x", { structuredContent: { ok: true, data: [1] } })).toEqual([1])
  })

  it("throws with the stable code on a failure", () => {
    expect(() =>
      decodeToolResult("get_device", {
        isError: true,
        structuredContent: { ok: false, code: "not_found", message: "no such device" }
      })
    ).toThrow("get_device: not_found: no such device")
    expect(() => decodeToolResult("x", { structuredContent: { ok: false, code: "api" } })).toThrow(
      "x: api: "
    )
  })

  it("throws when a failure has no envelope", () => {
    expect(() => decodeToolResult("x", { isError: true })).toThrow(
      "x: tool reported failure without an envelope code"
    )
  })
})

describe("sdkDevice", () => {
  const credential = { deviceId: "dev_1", secret: "s" } as unknown as DeviceCredential

  it("claims, then connects with the stored credential and publishes one reading", async () => {
    const calls: unknown[] = []
    const driver = sdkDevice({
      provisioningUrl: "https://api.example.com",
      claim: async (url, request) => {
        calls.push(["claim", url, request])
        return Promise.resolve(credential)
      },
      newDevice: (store) => ({
        connect: async () => {
          calls.push(["connect", await store.load()])
        },
        publish: async (topic, payload) => {
          calls.push(["publish", topic, payload])
          await Promise.resolve()
        },
        disconnect: async () => {
          calls.push(["disconnect"])
          await Promise.resolve()
        }
      })
    })
    expect(await driver.claim("QM", "agent-eval")).toEqual({ deviceId: "dev_1" })
    await driver.publishTelemetry("agent_eval", 1.5, 42)
    expect(calls).toEqual([
      ["claim", "https://api.example.com", { code: "QM", name: "agent-eval" }],
      ["connect", credential],
      ["publish", "telemetry", '{"ts":42,"metrics":{"agent_eval":1.5}}'],
      ["disconnect"]
    ])
  })

  it("times out a connect that never finishes, and still disconnects", async () => {
    let disconnected = false
    const driver = sdkDevice({
      provisioningUrl: "https://api.example.com",
      timeoutMs: 10,
      newDevice: () => ({
        connect: async () => new Promise<void>(() => undefined),
        publish: async () => Promise.resolve(),
        disconnect: async () => {
          disconnected = true
          await Promise.resolve()
        }
      })
    })
    await expect(driver.publishTelemetry("m", 1, 1)).rejects.toThrow(
      "mqtt connect timed out after 10ms"
    )
    expect(disconnected).toBe(true)
  })

  it("builds a real device when no factory is given", () => {
    expect(typeof sdkDevice({ provisioningUrl: "https://api.example.com" }).claim).toBe("function")
  })
})
