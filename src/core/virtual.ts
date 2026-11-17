import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

import { loadRuntime } from "../board/runtime.ts"
import type { Setup } from "../board/sync.ts"
import { CliError } from "../envelope.ts"
import type { BoardOps, BoardRef, DeployResult, ProbeResult } from "./boards.ts"
import type { LogChunk, LogPage } from "./taps.ts"

/** The serial-number prefix that names a virtual device rather than a board. */
export const VIRTUAL_PREFIX = "virtual:"

/** The files the device SDK owns in a virtual device's folder, as it does on a board. */
const CREDENTIAL = "qualithm-credential.json"
const SETUP = "qualithm-setup.json"
/** What the last deploy wrote, so the next one can remove what the project dropped. */
const MANIFEST = ".qualithm-deployed.json"

/**
 * Says whether a serial number names a virtual device.
 *
 * @param serialNumber - the serial number a verb was given
 * @returns true for `virtual:<name>`
 */
export function isVirtual(serialNumber: string | undefined): boolean {
  return serialNumber?.startsWith(VIRTUAL_PREFIX) === true
}

/**
 * The serial number of the virtual device a project folder deploys to: `virtual:` and the
 * folder's name in lowercase, with anything but letters, digits and dashes made a dash.
 *
 * @param dir - the project folder
 * @returns the serial number
 */
export function virtualSerial(dir: string): string {
  const name = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${VIRTUAL_PREFIX}${name === "" ? "project" : name}`
}

/**
 * The per-user folder virtual devices live in for this OS. It holds their credentials, so it
 * is user data, not cache.
 *
 * @param platform - the OS
 * @param env - environment variables
 * @param home - the user's home folder
 * @returns the folder
 */
export function virtualRoot(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "qualithm", "virtual")
  }
  const xdg = env.XDG_DATA_HOME
  return join(
    xdg === undefined || xdg === "" ? join(home, ".local", "share") : xdg,
    "qualithm",
    "virtual"
  )
}

/** A running virtual device, as the core sees it. */
export type VirtualProcess = {
  /** Calls `listener` with each piece of what the device prints. */
  onOutput: (listener: (text: string) => void) => void
  /** Calls `listener` once, when the device stops. */
  onExit: (listener: (code: number | null) => void) => void
  kill: () => void
}

/** What the virtual-device operations reach for; the real machine by default, fakes in tests. */
export type VirtualDeps = {
  /** The folder each virtual device's files live in, one subfolder each. */
  root: () => string
  /** The path of the MicroPython Unix port to run. */
  runtime: () => Promise<string>
  /** Starts `main.py` in `cwd` under `runtime`. */
  launch: (runtime: string, cwd: string) => VirtualProcess
  /** How many output chunks each device's buffer keeps. */
  max_chunks: number
  /** How long a stopping device may take before the core moves on. */
  stop_timeout_ms: number
}

type Device = {
  serialNumber: string
  dir: string
  chunks: LogChunk[]
  seq: number
  process?: VirtualProcess
  exited?: Promise<void>
  waiters: (() => void)[]
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** A board path such as `/lib/x.mpy` as a path under the device's folder. */
const local = (dir: string, path: string): string => join(dir, ...path.split("/").filter(Boolean))

async function readOrUndefined(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    return undefined
  }
}

async function readManifest(dir: string): Promise<string[]> {
  const bytes = await readOrUndefined(join(dir, MANIFEST))
  if (bytes === undefined) {
    return []
  }
  try {
    const paths: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : []
  } catch {
    return []
  }
}

async function unsupported(what: string): Promise<never> {
  return Promise.reject(
    new CliError(
      `a virtual device has no ${what}: deploy to it, read its logs or reset it`,
      "usage"
    )
  )
}

/**
 * Virtual-device operations over `deps`: deploy, reset, logs and probe, for serial numbers that
 * start with `virtual:`.
 *
 * @param deps - what to reach for
 * @returns the operations
 */
export function virtualOps(deps: VirtualDeps): BoardOps {
  const devices = new Map<string, Device>()

  const nameOf = (serialNumber: string | undefined): string => {
    const name = serialNumber?.slice(VIRTUAL_PREFIX.length) ?? ""
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new CliError(`no virtual device named ${serialNumber ?? "-"}`, "not_found")
    }
    return name
  }

  const device = (serialNumber: string | undefined): Device => {
    const name = nameOf(serialNumber)
    const key = `${VIRTUAL_PREFIX}${name}`
    let found = devices.get(key)
    if (found === undefined) {
      found = { serialNumber: key, dir: join(deps.root(), name), chunks: [], seq: 0, waiters: [] }
      devices.set(key, found)
    }
    return found
  }

  const ref = (d: Device): BoardRef => ({ port: d.dir, serialNumber: d.serialNumber })

  const append = (d: Device, text: string): void => {
    d.seq += 1
    d.chunks.push({ seq: d.seq, at_ms: Date.now(), text })
    if (d.chunks.length > deps.max_chunks) {
      d.chunks.splice(0, d.chunks.length - deps.max_chunks)
    }
    for (const wake of d.waiters.splice(0)) {
      wake()
    }
  }

  const stop = async (d: Device): Promise<void> => {
    const { process: running, exited } = d
    if (running === undefined) {
      return
    }
    d.process = undefined
    running.kill()
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, deps.stop_timeout_ms))
    ])
  }

  const start = async (d: Device): Promise<void> => {
    await stop(d)
    const running = deps.launch(await deps.runtime(), d.dir)
    d.process = running
    d.exited = new Promise((resolve) => {
      running.onExit((code) => {
        append(d, `\n[stopped${code === null ? "" : `, exit code ${String(code)}`}]\n`)
        if (d.process === running) {
          d.process = undefined
        }
        resolve()
      })
    })
    running.onOutput((text) => {
      append(d, text)
    })
  }

  const deployed = async (d: Device): Promise<void> => {
    if ((await readOrUndefined(join(d.dir, "main.py"))) === undefined) {
      throw new CliError(
        `${d.serialNumber} isn't deployed yet: run qualithm deploy --virtual in its project folder`,
        "not_found"
      )
    }
  }

  return {
    list: async () => Promise.resolve([]),
    flash: async () => unsupported("firmware to flash"),
    run: async () => unsupported("prompt to run code at"),
    write: async () => unsupported("console"),
    release: async () => unsupported("port to release"),
    reconnect: async () => unsupported("port to reconnect"),
    probe: async (serialNumber): Promise<ProbeResult> => {
      const d = device(serialNumber)
      const credential = (await readOrUndefined(join(d.dir, CREDENTIAL))) !== undefined
      const setup = await readOrUndefined(join(d.dir, SETUP))
      let claimCode = false
      if (setup !== undefined) {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(setup))
          claimCode =
            typeof parsed === "object" &&
            parsed !== null &&
            typeof (parsed as { claimCode?: unknown }).claimCode === "string"
        } catch {
          claimCode = false
        }
      }
      return { blank: false, credential, claimCode }
    },
    deploy: async (serialNumber, files, _sdk, dryRun, setup?: Setup): Promise<DeployResult> => {
      const d = device(serialNumber)
      const paths = new Set(files.map((f) => f.path))
      const written: string[] = []
      let unchanged = 0
      for (const file of files) {
        const current = await readOrUndefined(local(d.dir, file.path))
        if (current !== undefined && sha256(current) === sha256(file.bytes)) {
          unchanged += 1
        } else {
          written.push(file.path)
        }
      }
      const removed = (await readManifest(d.dir)).filter((p) => !paths.has(p))
      if (!dryRun) {
        await mkdir(d.dir, { recursive: true, mode: 0o700 })
        for (const path of written) {
          const file = files.find((f) => f.path === path)
          if (file !== undefined) {
            const target = local(d.dir, path)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, file.bytes)
          }
        }
        for (const path of removed) {
          await rm(local(d.dir, path), { force: true })
        }
        await writeFile(join(d.dir, MANIFEST), JSON.stringify([...paths].sort()))
        if (setup !== undefined) {
          // A virtual device uses the host's network, so the setup file carries no Wi-Fi.
          const { provisioningUrl, claimCode } = setup
          await writeFile(join(d.dir, SETUP), JSON.stringify({ provisioningUrl, claimCode }), {
            mode: 0o600
          })
        }
        await start(d)
      }
      return { board: ref(d), written, removed, unchanged }
    },
    reset: async (serialNumber) => {
      const d = device(serialNumber)
      await deployed(d)
      await start(d)
      return ref(d)
    },
    logs: async (serialNumber, after, waitMs, limit): Promise<LogPage> => {
      const d = device(serialNumber)
      if (d.process === undefined && d.chunks.length === 0) {
        await deployed(d)
      }
      if (!d.chunks.some((c) => c.seq > after) && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            d.waiters = d.waiters.filter((w) => w !== wake)
            resolve()
          }, waitMs)
          const wake = (): void => {
            clearTimeout(timer)
            resolve()
          }
          d.waiters.push(wake)
        })
      }
      const fresh = d.chunks.filter((c) => c.seq > after)
      const chunks = fresh.slice(0, limit)
      const next = chunks.at(-1)?.seq ?? Math.max(after, d.chunks.at(-1)?.seq ?? after)
      return { board: ref(d), chunks, next, more: fresh.length > chunks.length }
    },
    close: async () => {
      await Promise.all([...devices.values()].map(async (d) => stop(d)))
    }
  }
}

/**
 * Starts `main.py` under the Unix port, with the device SDK's `lib` folder on its import path.
 *
 * @param runtime - the MicroPython executable
 * @param cwd - the virtual device's folder
 * @returns the running device
 */
export function launchMicroPython(runtime: string, cwd: string): VirtualProcess {
  const child = spawn(runtime, ["main.py"], {
    cwd,
    env: { ...process.env, MICROPYPATH: "lib:.frozen" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const decoder = new TextDecoder()
  return {
    onOutput: (listener) => {
      const forward = (data: Buffer): void => {
        listener(decoder.decode(data, { stream: true }))
      }
      child.stdout.on("data", forward)
      child.stderr.on("data", forward)
    },
    onExit: (listener) => {
      child.once("exit", (code) => {
        listener(code)
      })
      child.once("error", () => {
        listener(null)
      })
    },
    kill: () => {
      child.kill()
    }
  }
}

/** The real machine's virtual-device operations. */
export function defaultVirtualOps(): BoardOps {
  return virtualOps({
    root: () => virtualRoot(),
    runtime: async () => loadRuntime(),
    launch: launchMicroPython,
    max_chunks: 5000,
    stop_timeout_ms: 2000
  })
}

/**
 * Board operations that send every verb naming a `virtual:` serial number to `virtual` and the
 * rest to `boards`.
 *
 * @param boards - the boards plugged in
 * @param virtual - the virtual devices
 * @returns the operations
 */
export function routedOps(boards: BoardOps, virtual: BoardOps): BoardOps {
  const pick = (serialNumber: string | undefined): BoardOps =>
    isVirtual(serialNumber) ? virtual : boards
  return {
    list: async () => boards.list(),
    flash: async (serialNumber) => pick(serialNumber).flash(serialNumber),
    reset: async (serialNumber) => pick(serialNumber).reset(serialNumber),
    run: async (serialNumber, code) => pick(serialNumber).run(serialNumber, code),
    logs: async (serialNumber, after, waitMs, limit) =>
      pick(serialNumber).logs(serialNumber, after, waitMs, limit),
    write: async (serialNumber, data) => pick(serialNumber).write(serialNumber, data),
    deploy: async (serialNumber, files, sdk, dryRun, setup) =>
      pick(serialNumber).deploy(serialNumber, files, sdk, dryRun, setup),
    probe: async (serialNumber) => pick(serialNumber).probe(serialNumber),
    release: async (serialNumber) => pick(serialNumber).release(serialNumber),
    reconnect: async (serialNumber) => pick(serialNumber).reconnect(serialNumber),
    close: async () => {
      await Promise.all([boards.close(), virtual.close()])
    }
  }
}
