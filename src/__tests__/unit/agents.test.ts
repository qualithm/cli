import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AgentHost } from "../../agents/connect.ts"
import { run } from "../../cli.ts"
import { noPlatform, runAgents } from "../../commands/agents.ts"
import { callTool } from "../../mcp.ts"
import { agentTools } from "../../tools/agents.ts"

const QUALITHM = "/opt/qualithm/bin/qualithm"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qualithm-agents-cli-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A machine with Claude desktop and Claude Code installed, whose `claude` CLI exits `code`. */
function host(code = 0): AgentHost & { calls: string[][]; desktop: string } {
  const home = join(root, "home")
  const dir = join(home, "Library", "Application Support", "Claude")
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, "bin"), { recursive: true })
  writeFileSync(join(root, "bin", "claude"), "")
  const calls: string[][] = []
  return {
    platform: "darwin",
    home,
    env: { PATH: join(root, "bin") },
    applications: [],
    server: { command: QUALITHM, args: ["mcp"] },
    exec: async (_file, args) => {
      calls.push(args.slice())
      return Promise.resolve({ code, stdout: "", stderr: code === 0 ? "" : "claude broke" })
    },
    calls,
    desktop: join(dir, "claude_desktop_config.json")
  }
}

function capture(agents?: AgentHost): {
  io: Parameters<typeof run>[1]
  out: () => string
  err: () => string
} {
  let out = ""
  let err = ""
  return {
    io: {
      stdout: (t) => {
        out += t
      },
      stderr: (t) => {
        err += t
      },
      ...(agents === undefined ? {} : { agents })
    },
    out: () => out,
    err: () => err
  }
}

describe("qualithm agents", () => {
  it("connects and prints a table, then a hint to restart", async () => {
    const machine = host()
    const c = capture(machine)
    expect(await run(["agents", "connect"], c.io)).toBe(0)
    expect(c.out()).toBe(
      [
        "AGENT           STATUS",
        "Claude desktop  connected",
        "Claude Code     connected",
        "Codex app       not installed",
        "Codex CLI       not installed",
        "Claude desktop:",
        `  edit  ${machine.desktop}`,
        `  now   ${QUALITHM} mcp`,
        "Claude Code:",
        `  run   claude mcp add --scope user qualithm -- ${QUALITHM} mcp`,
        `  now   ${QUALITHM} mcp`,
        "restart a running agent to load the change",
        ""
      ].join("\n")
    )
    expect(JSON.parse(readFileSync(machine.desktop, "utf8"))).toEqual({
      mcpServers: { qualithm: { command: QUALITHM, args: ["mcp"] } }
    })
  })

  it("prints the JSON envelope the desktop apps read", async () => {
    const c = capture(host())
    expect(await run(["agents", "connect", "--json", "--dry-run"], c.io)).toBe(0)
    const envelope = JSON.parse(c.out()) as Record<string, unknown>
    expect(envelope).toMatchObject({
      ok: true,
      dryRun: true,
      data: {
        server: { name: "qualithm", command: QUALITHM, args: ["mcp"] },
        agents: [
          {
            agent: "claude-desktop",
            name: "Claude desktop",
            status: "would_connect",
            before: null
          },
          { agent: "claude-code", status: "would_connect" },
          { agent: "codex-app", status: "not_installed" },
          { agent: "codex-cli", status: "not_installed" }
        ]
      }
    })
  })

  it("shows the old entry when a dry run would remove it", async () => {
    const machine = host()
    writeFileSync(
      machine.desktop,
      JSON.stringify({ mcpServers: { qualithm: { command: "q", args: [], env: { K: "v" } } } })
    )
    const c = capture(machine)
    expect(await run(["agents", "disconnect", "--dry-run"], c.io)).toBe(0)
    expect(c.out()).toContain("Claude desktop  would remove\n")
    expect(c.out()).toContain("  was   q (env K)\n")
    expect(c.out()).not.toContain("restart")
  })

  it("says so when no agent is installed", async () => {
    const c = capture({ ...host(), env: {}, home: join(root, "empty") })
    expect(await runAgents(["connect"], { ...c.io, host: c.io.agents })).toBe(0)
    expect(c.out()).toContain(
      "no Claude or Codex found on this computer: install one, then run this again\n"
    )
  })

  it("prints the table and fails with exit 1 when an agent CLI fails", async () => {
    const c = capture(host(1))
    expect(await run(["agents", "connect"], c.io)).toBe(1)
    expect(c.out()).toContain("Claude Code     failed\n")
    expect(c.err()).toBe("qualithm: claude mcp add exited 1: claude broke\n")
  })

  it("keeps every agent's report in a failed JSON envelope", async () => {
    const c = capture(host(1))
    expect(await run(["agents", "connect", "--json"], c.io)).toBe(1)
    expect(JSON.parse(c.out())).toMatchObject({
      ok: false,
      code: "error",
      message: "claude mcp add exited 1: claude broke",
      data: { agents: [{ status: "connected" }, { status: "failed" }, {}, {}] }
    })
  })

  it("prints its usage for --help", async () => {
    const c = capture(host())
    expect(await run(["agents", "--help"], c.io)).toBe(0)
    expect(c.out()).toMatch(/^Usage:\n {2}qualithm agents connect/)
  })

  it.each([[[]], [["link"]], [["connect", "extra"]]])(
    "refuses %j as usage",
    async (args: string[]) => {
      const c = capture(host())
      expect(await run(["agents", ...args], c.io)).toBe(2)
      expect(c.err()).toMatch(/^qualithm: (agents needs a verb|unknown command "agents )/)
    }
  )

  it("refuses an unknown flag as usage", async () => {
    const c = capture(host())
    expect(await run(["agents", "connect", "--force"], c.io)).toBe(2)
    expect(c.err()).toMatch(/^qualithm: unknown option/)
  })
})

describe("agent tools", () => {
  it("returns the same result over MCP as the command", async () => {
    const machine = host()
    const [connect] = agentTools(() => machine)
    if (connect === undefined) {
      throw new Error("no connect tool")
    }
    const never = (): never => {
      throw new Error("no session")
    }
    const result = await callTool(connect, never, { dryRun: true })
    expect(result).toMatchObject({ ok: true, dryRun: true, data: { agents: [{}, {}, {}, {}] } })
    expect(machine.calls).toEqual([])
  })

  it("fails the envelope when an agent fails", async () => {
    const machine = host()
    writeFileSync(machine.desktop, "{")
    const [, disconnect] = agentTools(() => ({ ...machine, env: {} }))
    if (disconnect === undefined) {
      throw new Error("no disconnect tool")
    }
    const result = await callTool(
      disconnect,
      () => {
        throw new Error("no session")
      },
      {}
    )
    expect(result).toMatchObject({ ok: false, code: "error" })
    expect(result.message).toMatch(/^claude desktop config /)
  })
})

describe("noPlatform", () => {
  it("refuses to open a platform session", () => {
    expect(noPlatform).toThrow("connecting agents never reaches the platform")
  })
})
