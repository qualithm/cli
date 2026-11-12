import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  type AgentHost,
  type AgentsResult,
  connectAgents,
  defaultAgentHost,
  disconnectAgents,
  type ExecResult,
  execRunner,
  qualithmServer
} from "../../../agents/connect.ts"

const QUALITHM = "/opt/qualithm/bin/qualithm"

type Fake = {
  host: AgentHost
  root: string
  calls: string[][]
  file: (...parts: string[]) => string
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qualithm-agents-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

/**
 * A machine under a temporary home, with fake `claude` and `codex` executables on its PATH that
 * edit the configs the real CLIs would.
 */
function fake(
  options: {
    platform?: NodeJS.Platform
    desktop?: boolean
    claude?: boolean
    codex?: boolean
    codexApp?: boolean
    fail?: string
    server?: { command: string; args: string[] }
  } = {}
): Fake {
  const home = join(root, "home")
  const bin = join(root, "bin")
  const apps = join(root, "Applications")
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const platform = options.platform ?? "darwin"
  if (options.desktop === true) {
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true })
  }
  if (options.claude === true) {
    put(join(bin, "claude"), "")
  }
  if (options.codex === true) {
    put(join(bin, "codex"), "")
  }
  if (options.codexApp === true) {
    mkdirSync(join(apps, "Codex.app"), { recursive: true })
  }
  const calls: string[][] = []
  const claudeJson = join(home, ".claude.json")
  const codexToml = join(home, ".codex", "config.toml")
  const exec: AgentHost["exec"] = async (file, args) => Promise.resolve(step(file, args))
  function step(file: string, args: readonly string[]): ExecResult {
    const name = file.split("/").at(-1) ?? file
    calls.push([name, ...args])
    if (options.fail === name) {
      return { code: 1, stdout: "", stderr: `${name}: something broke\nmore detail` }
    }
    const [, verb] = args
    if (name === "claude") {
      const doc = existsSync(claudeJson) ? readJson(claudeJson) : {}
      const servers = (doc.mcpServers ?? {}) as Record<string, unknown>
      if (verb === "add") {
        const at = args.indexOf("--")
        servers[args[at - 1] ?? ""] = {
          type: "stdio",
          command: args[at + 1],
          args: args.slice(at + 2),
          env: {}
        }
        put(claudeJson, JSON.stringify({ ...doc, mcpServers: servers }))
      } else {
        const kept = Object.entries(servers).filter(([key]) => key !== args.at(-1))
        put(claudeJson, JSON.stringify({ ...doc, mcpServers: Object.fromEntries(kept) }))
      }
    } else {
      const text = existsSync(codexToml) ? readFileSync(codexToml, "utf8") : ""
      if (verb === "add") {
        const at = args.indexOf("--")
        const list = args
          .slice(at + 2)
          .map((a) => JSON.stringify(a))
          .join(", ")
        put(
          codexToml,
          `${text}[mcp_servers.${args[2] ?? ""}]\ncommand = ${JSON.stringify(args[at + 1])}\nargs = [${list}]\n`
        )
      } else {
        put(codexToml, text.replace(/\[mcp_servers\.qualithm\][^[]*/, ""))
      }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return {
    root,
    calls,
    file: (...parts) => join(home, ...parts),
    host: {
      platform,
      home,
      env: { PATH: `${join(root, "nowhere")}:${bin}` },
      applications: [apps],
      server: options.server ?? { command: QUALITHM, args: ["mcp"] },
      exec
    }
  }
}

const DESKTOP = ["Library", "Application Support", "Claude", "claude_desktop_config.json"]

function statuses(result: AgentsResult): Record<string, string> {
  return Object.fromEntries(result.agents.map((a) => [a.agent, a.status]))
}

describe("qualithmServer", () => {
  it("runs a compiled binary with mcp alone", () => {
    expect(qualithmServer("/usr/local/bin/qualithm", "/$bunfs/root/qualithm")).toEqual({
      command: "/usr/local/bin/qualithm",
      args: ["mcp"]
    })
  })

  it("names the runtime and the script for a script install", () => {
    expect(qualithmServer("/usr/bin/node", "/usr/lib/qualithm.js")).toEqual({
      command: "/usr/bin/node",
      args: ["/usr/lib/qualithm.js", "mcp"]
    })
    expect(qualithmServer("C:\\node\\node.exe", undefined).args).toEqual(["mcp"])
  })

  it("describes this machine by default", () => {
    const host = defaultAgentHost()
    expect(host.platform).toBe(process.platform)
    expect(host.server.args.at(-1)).toBe("mcp")
  })
})

describe("detection", () => {
  it("reports every agent as not installed on a bare machine", async () => {
    const { host } = fake()
    expect(statuses(await connectAgents(host, { dryRun: false }))).toEqual({
      "claude-desktop": "not_installed",
      "claude-code": "not_installed",
      "codex-app": "not_installed",
      "codex-cli": "not_installed"
    })
  })

  it("finds Claude desktop by its app bundle when it has no config dir yet", async () => {
    const f = fake()
    mkdirSync(join(f.root, "Applications", "Claude.app"), { recursive: true })
    const result = await connectAgents(f.host, { dryRun: false })
    expect(statuses(result)["claude-desktop"]).toBe("connected")
    expect(readJson(f.file(...DESKTOP))).toEqual({
      mcpServers: { qualithm: { command: QUALITHM, args: ["mcp"] } }
    })
  })

  it("looks for app bundles on macOS only", async () => {
    const f = fake({ platform: "linux", codexApp: true })
    mkdirSync(join(f.root, "Applications", "Claude.app"), { recursive: true })
    expect(statuses(await connectAgents(f.host, { dryRun: false }))).toMatchObject({
      "claude-desktop": "not_installed",
      "codex-app": "not_installed"
    })
  })

  it("finds Claude desktop's config under XDG_CONFIG_HOME on Linux and APPDATA on Windows", async () => {
    const linux = fake({ platform: "linux" })
    const xdg = join(root, "xdg")
    mkdirSync(join(xdg, "Claude"), { recursive: true })
    const onLinux = await connectAgents(
      { ...linux.host, env: { ...linux.host.env, XDG_CONFIG_HOME: xdg } },
      { dryRun: true }
    )
    expect(onLinux.agents[0]?.config).toBe(join(xdg, "Claude", "claude_desktop_config.json"))

    mkdirSync(linux.file(".config", "Claude"), { recursive: true })
    const plain = await connectAgents(linux.host, { dryRun: true })
    expect(plain.agents[0]?.config).toBe(
      linux.file(".config", "Claude", "claude_desktop_config.json")
    )

    const appData = join(root, "AppData")
    mkdirSync(join(appData, "Claude"), { recursive: true })
    const onWindows = await connectAgents(
      { ...linux.host, platform: "win32", env: { APPDATA: appData } },
      { dryRun: true }
    )
    expect(onWindows.agents[0]?.config).toBe(join(appData, "Claude", "claude_desktop_config.json"))
    mkdirSync(linux.file("AppData", "Roaming", "Claude"), { recursive: true })
    const noAppData = await connectAgents(
      { ...linux.host, platform: "win32", env: {} },
      { dryRun: true }
    )
    expect(noAppData.agents[0]?.status).toBe("would_connect")
  })

  it("finds a Windows agent CLI by its PATHEXT extension", async () => {
    const f = fake()
    put(join(root, "win", "claude.cmd"), "")
    const result = await connectAgents(
      { ...f.host, platform: "win32", env: { PATH: `;${join(root, "win")}` } },
      { dryRun: true }
    )
    expect(statuses(result)["claude-code"]).toBe("would_connect")
    const noPath = await connectAgents({ ...f.host, platform: "win32", env: {} }, { dryRun: true })
    expect(statuses(noPath)["claude-code"]).toBe("not_installed")
  })

  it("reads Claude Code from CLAUDE_CONFIG_DIR and Codex from CODEX_HOME when set", async () => {
    const f = fake({ claude: true, codex: true })
    const env = { ...f.host.env, CLAUDE_CONFIG_DIR: join(root, "cc"), CODEX_HOME: join(root, "cx") }
    const result = await connectAgents({ ...f.host, env }, { dryRun: true })
    expect(result.agents[1]?.config).toBe(join(root, "cc", ".claude.json"))
    expect(result.agents[3]?.config).toBe(join(root, "cx", "config.toml"))
  })
})

describe("connect", () => {
  it("connects every installed agent with an absolute command and no token", async () => {
    const f = fake({ desktop: true, claude: true, codex: true, codexApp: true })
    put(
      f.file(...DESKTOP),
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } })
    )
    const result = await connectAgents(f.host, { dryRun: false })
    expect(result.server).toEqual({ name: "qualithm", command: QUALITHM, args: ["mcp"] })
    expect(statuses(result)).toEqual({
      "claude-desktop": "connected",
      "claude-code": "connected",
      "codex-app": "connected",
      "codex-cli": "connected"
    })
    expect(result.agents[2]).toMatchObject({ via: "codex-cli" })
    expect(readJson(f.file(...DESKTOP))).toEqual({
      theme: "dark",
      mcpServers: { other: { command: "x" }, qualithm: { command: QUALITHM, args: ["mcp"] } }
    })
    expect(f.calls).toEqual([
      ["claude", "mcp", "add", "--scope", "user", "qualithm", "--", QUALITHM, "mcp"],
      ["codex", "mcp", "add", "qualithm", "--", QUALITHM, "mcp"]
    ])
    expect(JSON.stringify(result)).not.toMatch(/token/i)
    expect(readdirSync(dirname(f.file(...DESKTOP)))).toEqual(["claude_desktop_config.json"])
  })

  it("changes nothing when run a second time", async () => {
    const f = fake({ desktop: true, claude: true, codex: true, codexApp: true })
    await connectAgents(f.host, { dryRun: false })
    const desktop = readFileSync(f.file(...DESKTOP), "utf8")
    const toml = readFileSync(f.file(".codex", "config.toml"), "utf8")
    f.calls.length = 0
    const again = await connectAgents(f.host, { dryRun: false })
    expect(Object.values(statuses(again))).toEqual(Array(4).fill("already_connected"))
    expect(f.calls).toEqual([])
    expect(readFileSync(f.file(...DESKTOP), "utf8")).toBe(desktop)
    expect(readFileSync(f.file(".codex", "config.toml"), "utf8")).toBe(toml)
  })

  it("updates an entry that starts a different qualithm and reports the old one", async () => {
    const f = fake({ desktop: true, claude: true, codex: true })
    const old = { command: "qualithm", args: ["mcp"], env: { QUALITHM_API_TOKEN: "qmt_secret" } }
    put(f.file(...DESKTOP), JSON.stringify({ mcpServers: { qualithm: old } }))
    put(f.file(".claude.json"), JSON.stringify({ mcpServers: { qualithm: old } }))
    put(
      f.file(".codex", "config.toml"),
      `[mcp_servers.qualithm]\ncommand = "/old/qualithm"\nargs = ["mcp"]\n`
    )
    const result = await connectAgents(f.host, { dryRun: false })
    const was = { command: "qualithm", args: ["mcp"], env: ["QUALITHM_API_TOKEN"] }
    expect(result.agents[0]).toMatchObject({ status: "connected", before: was })
    expect(result.agents[1]).toMatchObject({ status: "connected", before: was })
    expect(result.agents[3]).toMatchObject({
      status: "connected",
      before: { command: "/old/qualithm", args: ["mcp"] }
    })
    expect(JSON.stringify(result)).not.toContain("qmt_secret")
    expect(readFileSync(f.file(...DESKTOP), "utf8")).not.toContain("qmt_secret")
    expect(f.calls).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "qualithm"],
      ["claude", "mcp", "add", "--scope", "user", "qualithm", "--", QUALITHM, "mcp"],
      ["codex", "mcp", "remove", "qualithm"],
      ["codex", "mcp", "add", "qualithm", "--", QUALITHM, "mcp"]
    ])
  })

  it("edits config.toml directly for the Codex app without the CLI, keeping everything else", async () => {
    const f = fake({ codexApp: true })
    const toml = f.file(".codex", "config.toml")
    put(
      toml,
      [
        'model = "o4"',
        "",
        "[mcp_servers.qualithm]",
        "command = 'qualithm'",
        'args = ["mcp"] # old',
        "",
        "[mcp_servers.qualithm.env]",
        'QUALITHM_API_TOKEN = "qmt_x"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        ""
      ].join("\n")
    )
    const result = await connectAgents(f.host, { dryRun: false })
    expect(result.agents[2]).toMatchObject({
      status: "connected",
      before: { command: "qualithm", args: ["mcp"], env: ["env"] },
      after: { command: QUALITHM, args: ["mcp"] }
    })
    expect(readFileSync(toml, "utf8")).toBe(
      `model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.qualithm]\ncommand = "${QUALITHM}"\nargs = ["mcp"]\n`
    )
    const again = await connectAgents(f.host, { dryRun: false })
    expect(again.agents[2]?.status).toBe("already_connected")
  })

  it("creates config.toml for the Codex app when there is none", async () => {
    const f = fake({ codexApp: true })
    await connectAgents(f.host, { dryRun: false })
    expect(readFileSync(f.file(".codex", "config.toml"), "utf8")).toBe(
      `[mcp_servers.qualithm]\ncommand = "${QUALITHM}"\nargs = ["mcp"]\n`
    )
  })

  it("rewrites a qualithm table it can't read", async () => {
    const f = fake({ codexApp: true })
    put(
      f.file(".codex", "config.toml"),
      '[mcp_servers."qualithm"]\ncommand = "\\q"\nargs = [\n  "mcp",\n]\nenv = { A = "b" }\n'
    )
    const result = await connectAgents(f.host, { dryRun: false })
    expect(result.agents[2]).toMatchObject({
      status: "connected",
      before: { command: "", args: [], env: ["env"] }
    })
  })

  it("treats an unreadable ~/.claude.json as having no entry", async () => {
    const f = fake({ claude: true })
    put(f.file(".claude.json"), "{not json")
    const result = await connectAgents(f.host, { dryRun: true })
    expect(result.agents[1]).toMatchObject({ status: "would_connect", before: null })
  })
})

describe("dry run", () => {
  it("shows every change and writes nothing", async () => {
    const f = fake({ desktop: true, claude: true, codex: true, codexApp: true })
    const result = await connectAgents(f.host, { dryRun: true })
    expect(Object.values(statuses(result))).toEqual(Array(4).fill("would_connect"))
    expect(result.agents[0]).toMatchObject({
      config: f.file(...DESKTOP),
      before: null,
      after: { command: QUALITHM, args: ["mcp"] }
    })
    expect(result.agents[1]?.commands).toEqual([
      ["claude", "mcp", "add", "--scope", "user", "qualithm", "--", QUALITHM, "mcp"]
    ])
    expect(f.calls).toEqual([])
    expect(existsSync(f.file(...DESKTOP))).toBe(false)
    expect(existsSync(f.file(".codex"))).toBe(false)
  })

  it("shows a removal and writes nothing", async () => {
    const f = fake({ desktop: true, codexApp: true })
    await connectAgents(f.host, { dryRun: false })
    const before = readFileSync(f.file(...DESKTOP), "utf8")
    const result = await disconnectAgents(f.host, { dryRun: true })
    expect(statuses(result)).toMatchObject({
      "claude-desktop": "would_remove",
      "codex-app": "would_remove"
    })
    expect(readFileSync(f.file(...DESKTOP), "utf8")).toBe(before)
  })
})

describe("disconnect", () => {
  it("removes the entry from every agent and leaves the rest", async () => {
    const f = fake({ desktop: true, claude: true, codex: true, codexApp: true })
    put(f.file(...DESKTOP), JSON.stringify({ mcpServers: { other: { command: "x" } } }))
    await connectAgents(f.host, { dryRun: false })
    f.calls.length = 0
    const result = await disconnectAgents(f.host, { dryRun: false })
    expect(Object.values(statuses(result))).toEqual(Array(4).fill("removed"))
    expect(readJson(f.file(...DESKTOP))).toEqual({ mcpServers: { other: { command: "x" } } })
    expect(f.calls).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "qualithm"],
      ["codex", "mcp", "remove", "qualithm"]
    ])
    const again = await disconnectAgents(f.host, { dryRun: false })
    expect(Object.values(statuses(again))).toEqual(Array(4).fill("not_connected"))
  })

  it("reports the Codex app as not connected when its config has no qualithm table", async () => {
    const f = fake({ codexApp: true })
    const result = await disconnectAgents(f.host, { dryRun: false })
    expect(result.agents[2]?.status).toBe("not_connected")
    expect(existsSync(f.file(".codex"))).toBe(false)
  })

  it("removes a qualithm entry Claude desktop can't read", async () => {
    const f = fake({ desktop: true })
    put(f.file(...DESKTOP), JSON.stringify({ mcpServers: { qualithm: "junk" } }))
    const result = await disconnectAgents(f.host, { dryRun: false })
    expect(result.agents[0]).toMatchObject({ status: "removed", before: { command: "", args: [] } })
    expect(readJson(f.file(...DESKTOP))).toEqual({ mcpServers: {} })
  })

  it("removes the Codex app's table directly without the CLI", async () => {
    const f = fake({ codexApp: true })
    await connectAgents(f.host, { dryRun: false })
    const result = await disconnectAgents(f.host, { dryRun: false })
    expect(result.agents[2]?.status).toBe("removed")
    expect(readFileSync(f.file(".codex", "config.toml"), "utf8")).toBe("")
  })
})

describe("failures", () => {
  it("reports an agent CLI that fails and carries on with the others", async () => {
    const f = fake({ desktop: true, claude: true, codex: true, codexApp: true, fail: "claude" })
    const result = await connectAgents(f.host, { dryRun: false })
    expect(result.agents[1]).toMatchObject({
      status: "failed",
      error: "claude mcp add exited 1: claude: something broke"
    })
    expect(statuses(result)).toMatchObject({
      "claude-desktop": "connected",
      "codex-cli": "connected"
    })
  })

  it("reports a failing CLI that printed nothing", async () => {
    const f = fake({ claude: true })
    f.host.exec = async () => Promise.resolve({ code: 2, stdout: "", stderr: "" })
    const result = await connectAgents(f.host, { dryRun: false })
    expect(result.agents[1]?.error).toBe("claude mcp add exited 2")
  })

  it("refuses a malformed claude_desktop_config.json and leaves it alone", async () => {
    for (const text of ["{oops", "[]", '{"mcpServers": 3}']) {
      const f = fake({ desktop: true })
      put(f.file(...DESKTOP), text)
      const result = await connectAgents(f.host, { dryRun: false })
      expect(result.agents[0]).toMatchObject({ status: "failed" })
      expect(result.agents[0]?.error).toMatch(/^claude desktop config .* isn't valid JSON/)
      expect(readFileSync(f.file(...DESKTOP), "utf8")).toBe(text)
    }
  })

  it("fails one agent when its config can't be written", async () => {
    const f = fake({ codexApp: true })
    put(f.file(".codex"), "a file, not a folder")
    const result = await connectAgents(f.host, { dryRun: false })
    expect(result.agents[2]).toMatchObject({ status: "failed" })
    expect(result.agents[2]?.error).toMatch(/^codex app: /)
  })

  it("passes a failure the Codex CLI had on to the app it covers", async () => {
    const f = fake({ codex: true, codexApp: true, fail: "codex" })
    const result = await connectAgents(f.host, { dryRun: false })
    expect(result.agents[2]).toMatchObject({ status: "failed", via: "codex-cli" })
  })
})

describe("execRunner", () => {
  it("runs a program and collects its output and exit code", async () => {
    const script = join(root, "fake-claude")
    put(script, '#!/bin/sh\necho "args: $*"\necho oops >&2\nexit 3\n')
    chmodSync(script, 0o755)
    const result = await execRunner("darwin")(script, ["mcp", "add"])
    expect(result).toEqual({ code: 3, stdout: "args: mcp add\n", stderr: "oops\n" })
  })

  it("reports a program that can't start as exit 1", async () => {
    const result = await execRunner("linux")(join(root, "missing"), [])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/ENOENT/)
  })

  it("exits 0 for a program that succeeds", async () => {
    const script = join(root, "ok")
    put(script, "#!/bin/sh\nexit 0\n")
    chmodSync(script, 0o755)
    expect((await execRunner("linux")(script, [])).code).toBe(0)
  })
})
