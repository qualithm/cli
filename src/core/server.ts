import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { dirname } from "node:path"

import { CliError } from "../envelope.ts"
import { coreAnswers } from "./client.ts"
import type { Core } from "./core.ts"

/** How the server watches its socket. */
export type ServeConfig = {
  platform: NodeJS.Platform
  /** How often to check the socket file still exists; the core stops once it is gone. */
  sweep_interval_ms: number
}

/** The production settings. */
export const defaultServeConfig: ServeConfig = {
  platform: process.platform,
  sweep_interval_ms: 1000
}

/** A listening core. */
export type CoreServer = {
  path: string
  /** Resolves once the server has stopped, by `close` or because its socket file was removed. */
  closed: Promise<void>
  close: () => Promise<void>
}

async function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }
    server.once("error", onError)
    server.listen(path, () => {
      server.off("error", onError)
      resolve()
    })
  })
}

function connection(core: Core, socket: Socket): void {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      void core.handle(line).then((reply) => {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify(reply)}\n`)
        }
      })
    }
  })
  socket.on("error", () => {
    // A client that hangs up mid-reply is not the core's failure.
  })
}

/**
 * Serves `core` on `path`, reachable only by the current user. Refuses when another core already
 * answers there; replaces a socket file no core answers on.
 *
 * @param core - answers the requests
 * @param path - the socket path or Windows pipe name
 * @param config - platform and timings
 * @returns the running server
 * @throws {CliError} when another core is already running
 */
export async function serveCore(
  core: Core,
  path: string,
  config: ServeConfig = defaultServeConfig
): Promise<CoreServer> {
  const posix = config.platform !== "win32"
  if (posix) {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const server = createServer((socket) => {
    connection(core, socket)
  })
  // The 0700 folder keeps other users out. No umask: it is process-wide, and binding awaits.
  const bind = async (): Promise<void> => listen(server, path)
  try {
    await bind()
  } catch (error) {
    // Bun reports a busy socket without Node's EADDRINUSE code, so the path existing counts too.
    const busy = error instanceof Error && "code" in error && error.code === "EADDRINUSE"
    if (!busy && !existsSync(path)) {
      throw error
    }
    if (await coreAnswers(path)) {
      throw new CliError(`a core is already running on ${path}`, "conflict")
    }
    if (!posix) {
      throw error
    }
    // Left by a core that crashed: nothing answers, so it is safe to replace.
    rmSync(path, { force: true })
    await bind()
  }
  if (posix) {
    chmodSync(path, 0o600)
  }
  let sweep: ReturnType<typeof setInterval> | undefined
  const closed = new Promise<void>((resolve) => {
    server.once("close", () => {
      clearInterval(sweep)
      resolve()
    })
  })
  const close = async (): Promise<void> => {
    if (server.listening) {
      server.close()
    }
    return closed
  }
  if (posix) {
    sweep = setInterval(() => {
      if (!existsSync(path)) {
        void close()
      }
    }, config.sweep_interval_ms)
    sweep.unref()
  }
  return { path, closed, close }
}
