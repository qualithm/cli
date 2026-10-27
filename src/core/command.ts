import { parseArgs } from "node:util"

import { CliError, EXIT_CODES, exitCode, failure, type Result, success } from "../envelope.ts"
import { VERSION } from "../version.ts"
import { type BoardOps, defaultBoardOps } from "./boards.ts"
import { coreAnswers, sendCore } from "./client.ts"
import { Core } from "./core.ts"
import type { Hello } from "./protocol.ts"
import { type CoreServer, defaultServeConfig, type ServeConfig, serveCore } from "./server.ts"
import { corePath } from "./socket.ts"

/** Where `qualithm core` writes and what it reaches for; tests pass their own. */
export type CoreIo = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** The board operations a started core uses; the real machine by default. */
  boardOps?: () => BoardOps
  serve?: ServeConfig
  /** Called once a started core listens, before it waits to stop. */
  onListening?: (server: CoreServer) => void
}

export const CORE_USAGE = `Usage:
  qualithm core run      run the device core in the foreground
  qualithm core status   report whether a core is running, and its version
  qualithm core stop     stop the running core

A device command starts the core when none is running, so these are rarely needed.

Flags:
  --socket string  the socket path (default: the current user's)
  --json           print one JSON envelope line
`

function print(io: CoreIo, json: boolean, result: Result, human: string): number {
  if (json) {
    io.stdout(`${JSON.stringify(result)}\n`)
  } else if (!result.ok) {
    io.stderr(`qualithm: ${result.message ?? "core request failed"}\n`)
  } else {
    io.stdout(human)
  }
  return exitCode(result)
}

async function runForeground(io: CoreIo, path: string, json: boolean): Promise<number> {
  let server: CoreServer | undefined
  const core = new Core((io.boardOps ?? defaultBoardOps)(), VERSION, () => {
    void server?.close()
  })
  try {
    server = await serveCore(core, path, io.serve ?? defaultServeConfig)
  } catch (error) {
    return print(io, json, failure(error), "")
  }
  const running = server
  const stop = (): void => {
    void running.close()
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  io.stderr(`qualithm: core ${VERSION} listening on ${path}\n`)
  io.onListening?.(running)
  await running.closed
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
  return EXIT_CODES.ok
}

/**
 * Runs `qualithm core <verb>`. Never throws: every failure becomes an exit code and a message.
 *
 * @param args - the arguments after `core`
 * @param io - where output goes
 * @returns the exit code
 */
export async function runCore(args: readonly string[], io: CoreIo): Promise<number> {
  let values: { socket?: string; json?: boolean; help?: boolean }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: [...args],
      options: {
        socket: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" }
      },
      allowPositionals: true,
      strict: true
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`qualithm: ${message.toLowerCase()}\n`)
    return EXIT_CODES.usage
  }
  const [verb] = positionals
  if (values.help === true || verb === "help") {
    io.stdout(CORE_USAGE)
    return EXIT_CODES.ok
  }
  const json = values.json === true
  const path = values.socket ?? corePath()
  if (verb === "run") {
    return runForeground(io, path, json)
  }
  if (verb === "status") {
    return status(io, path, json)
  }
  if (verb === "stop") {
    return stop(io, path, json)
  }
  io.stderr(
    `qualithm: ${verb === undefined ? "core needs a verb" : `unknown command "core ${verb}"`}\n\n${CORE_USAGE}`
  )
  return EXIT_CODES.usage
}

async function status(io: CoreIo, path: string, json: boolean): Promise<number> {
  if (!(await coreAnswers(path))) {
    return print(
      io,
      json,
      failure(new CliError(`no core is running on ${path}`, "unavailable")),
      ""
    )
  }
  try {
    const hello = (await sendCore(path, { verb: "hello" })) as Hello
    const human = `core ${hello.version} (pid ${String(hello.pid)}) on ${path}\n`
    return print(io, json, success({ ...hello, path }), human)
  } catch (error) {
    return print(io, json, failure(error), "")
  }
}

async function stop(io: CoreIo, path: string, json: boolean): Promise<number> {
  if (!(await coreAnswers(path))) {
    return print(io, json, success({ stopped: false, path }), "no core is running\n")
  }
  try {
    await sendCore(path, { verb: "shutdown" })
    return print(io, json, success({ stopped: true, path }), "core stopped\n")
  } catch (error) {
    return print(io, json, failure(error), "")
  }
}
