import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { connect } from "node:net"
import { dirname } from "node:path"

import { CliError } from "../envelope.ts"
import {
  API_VERSION,
  type CoreRequest,
  type CoreResponse,
  type Hello,
  type Unversioned
} from "./protocol.ts"

const STALE = "run `qualithm core stop`, then try again"

/**
 * Sends one request to the core and returns its reply's data.
 *
 * @param path - the socket path or Windows pipe name
 * @param request - the request, without `api`
 * @returns the reply's data
 * @throws {CliError} when no core answers, the core refuses this API version, or the verb fails
 */
export async function sendCore(path: string, request: Unversioned<CoreRequest>): Promise<unknown> {
  const reply = await exchange(path, `${JSON.stringify({ api: API_VERSION, ...request })}\n`)
  const stale = new CliError(
    `the running core is from another qualithm version: ${STALE}`,
    "conflict"
  )
  if (!reply.ok) {
    const { code, message } = reply.error
    throw code === "api_mismatch" ? stale : new CliError(message, code)
  }
  if (reply.api !== API_VERSION && request.verb !== "shutdown") {
    throw stale
  }
  return reply.data
}

async function exchange(path: string, line: string): Promise<CoreResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let buffer = ""
    let settled = false
    const settle = (outcome: () => void): void => {
      if (!settled) {
        settled = true
        socket.destroy()
        outcome()
      }
    }
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket.write(line)
    })
    socket.on("data", (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf("\n")
      if (end === -1) {
        return
      }
      const text = buffer.slice(0, end)
      settle(() => {
        try {
          resolve(JSON.parse(text) as CoreResponse)
        } catch {
          reject(new CliError(`the core sent a reply that isn't json: ${STALE}`, "error"))
        }
      })
    })
    socket.on("error", (error) => {
      settle(() => {
        reject(new CliError(`no core answers on ${path}: ${error.message}`, "unavailable"))
      })
    })
    socket.on("close", () => {
      settle(() => {
        reject(new CliError("the core closed the connection before replying", "unavailable"))
      })
    })
  })
}

/**
 * Whether a core answers on `path`.
 *
 * @param path - the socket path or Windows pipe name
 * @returns true when something accepts a connection there
 */
export async function coreAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/** How a client waits for a core it started. */
export type EnsureConfig = {
  /** Starts a core on the path, without waiting for it. */
  start: (path: string) => void
  wait_ms: number
  poll_ms: number
  sleep: (ms: number) => Promise<void>
}

/**
 * Connects to the user's core, starting one when none answers.
 *
 * @param path - the socket path or Windows pipe name
 * @param config - how to start and wait
 * @returns the core's `hello`
 * @throws {CliError} when the core doesn't come up in time, or is from another version
 */
export async function ensureCore(path: string, config: EnsureConfig): Promise<Hello> {
  if (!(await coreAnswers(path))) {
    config.start(path)
    const deadline = Date.now() + config.wait_ms
    while (!(await coreAnswers(path))) {
      if (Date.now() >= deadline) {
        throw new CliError(`the core didn't start on ${path} in time`, "unavailable")
      }
      await config.sleep(config.poll_ms)
    }
  }
  return (await sendCore(path, { verb: "hello" })) as Hello
}

/**
 * The command that runs this same `qualithm`: the binary alone when compiled, the runtime and
 * script otherwise.
 *
 * @param execPath - the running executable
 * @param script - the script it runs, if any
 * @returns the program and its leading arguments
 */
export function selfCommand(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1]
): string[] {
  // A compiled Bun binary reports its embedded entry point under a virtual root.
  const compiled = script === undefined || script.startsWith("/$bunfs/") || script.includes("~BUN")
  return compiled ? [execPath] : [execPath, script]
}

/**
 * Starts `qualithm core run` in the background, detached from this process, with its output
 * appended to `log`.
 *
 * @param path - the socket path the core listens on
 * @param log - the file the core writes to
 * @param command - the program and leading arguments that run `qualithm`
 */
export function startDetached(path: string, log: string, command: string[] = selfCommand()): void {
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
  const out = openSync(log, "a", 0o600)
  const [program = process.execPath, ...lead] = command
  try {
    const child = spawn(program, [...lead, "core", "run", "--socket", path], {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true
    })
    child.unref()
  } finally {
    closeSync(out)
  }
}
