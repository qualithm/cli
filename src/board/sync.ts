import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { CliError } from "../envelope.ts"
import { defaultRawReplConfig, RawRepl, type RawReplConfig } from "./raw-repl.ts"
import type { SerialPort } from "./serial.ts"

/** One file of a project, at its path on the board. */
export type ProjectFile = {
  /** Absolute on the board, e.g. `/main.py` or `/lib/sensor.py`. */
  path: string
  bytes: Uint8Array
}

/** What a sync did, or would do on a dry run. */
export type SyncResult = {
  /** Files written because they were new or differed. */
  written: string[]
  /** Files a previous deploy wrote that the project no longer has. */
  removed: string[]
  /** How many files already matched. */
  unchanged: number
}

/** Files the SDK owns on the board; a deploy never writes or removes them. */
export const RESERVED = [
  "/qualithm-credential.json",
  "/qualithm-credential.json.tmp",
  "/qualithm-setup.json"
] as const

/** Where a deploy records the files it wrote, so the next one can remove the ones gone since. */
export const MANIFEST = "/.qualithm-deploy.json"

const SKIPPED_DIRS = new Set(["__pycache__", "node_modules"])

/** Base64 per write; small enough that one exec stays well inside the board's RAM. */
const CHUNK_BYTES = 1536

/**
 * Reads a project folder: every file, at its path on the board, skipping hidden files and
 * folders and `__pycache__`.
 *
 * @param dir - the project folder
 * @returns the files, sorted by path
 * @throws {CliError} when the folder can't be read, has no files, or holds a reserved name
 */
export async function collectProject(dir: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = []
  const walk = async (at: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new CliError(`read the project folder ${dir}: ${reason}`, "not_found")
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) {
        continue
      }
      const full = join(at, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const path = `/${relative(dir, full).split(sep).join("/")}`
        files.push({ path, bytes: new Uint8Array(await readFile(full)) })
      }
    }
  }
  await walk(dir)
  const reserved = files.find((f) => (RESERVED as readonly string[]).includes(f.path))
  if (reserved !== undefined) {
    throw new CliError(
      `the project has ${reserved.path}, which the device SDK owns on the board: rename it`,
      "usage"
    )
  }
  if (files.length === 0) {
    throw new CliError(`the project folder ${dir} has no files to deploy`, "usage")
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The SHA-256 of some bytes, as the board reports it.
 *
 * @param bytes - the bytes
 * @returns the hex digest
 */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const HELPERS = `import os, hashlib, binascii
def _h(p):
    try:
        s = hashlib.sha256()
        f = open(p, "rb")
        while True:
            b = f.read(1024)
            if not b:
                break
            s.update(b)
        f.close()
        return binascii.hexlify(s.digest()).decode()
    except OSError:
        return ""
def _md(p):
    d = ""
    for part in p.split("/")[1:-1]:
        d += "/" + part
        try:
            os.mkdir(d)
        except OSError:
            pass
def _rm(p):
    try:
        os.remove(p)
    except OSError:
        pass
`

/** What a sync needs from a raw REPL session. */
export type Repl = Pick<RawRepl, "exec">

async function run(repl: Repl, code: string): Promise<string> {
  const { stdout, stderr } = await repl.exec(code)
  if (stderr.trim() !== "") {
    const last = stderr.trim().split("\n").at(-1)?.trim() ?? stderr.trim()
    if (/ENOSPC|Errno 28\b/.test(last)) {
      throw new CliError("the board's filesystem is full: deploy fewer or smaller files", "error")
    }
    throw new CliError(`the board raised ${last}`, "error")
  }
  return stdout
}

/** A Python string literal for `text`; JSON's escapes are valid Python. */
const py = (text: string): string => JSON.stringify(text)

async function readManifest(repl: Repl): Promise<string[]> {
  const out = await run(
    repl,
    `try:\n    print(open(${py(MANIFEST)}).read())\nexcept OSError:\n    print("[]")`
  )
  try {
    const parsed: unknown = JSON.parse(out.trim())
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []
  } catch {
    // A manifest that isn't JSON records nothing usable; nothing gets removed.
    return []
  }
}

async function writeFile(repl: Repl, file: ProjectFile): Promise<void> {
  const tmp = `${file.path}.qualithm-tmp`
  await run(repl, `_md(${py(file.path)})\n_f = open(${py(tmp)}, "wb")`)
  const base64 = Buffer.from(file.bytes).toString("base64")
  for (let at = 0; at < base64.length; at += CHUNK_BYTES) {
    await run(repl, `_f.write(binascii.a2b_base64(${py(base64.slice(at, at + CHUNK_BYTES))}))`)
  }
  // Rename over the old file, so an interrupted write never leaves half a file in its place.
  await run(repl, `_f.close()\n_rm(${py(file.path)})\nos.rename(${py(tmp)}, ${py(file.path)})`)
}

/**
 * The sync itself, inside a raw REPL session the caller holds.
 *
 * @param repl - the session
 * @param files - the project's files
 * @param dryRun - report what would change without changing it
 * @returns what changed
 * @throws {CliError} when the board refuses a write or its filesystem is full
 */
export async function syncWith(
  repl: Repl,
  files: ProjectFile[],
  dryRun: boolean
): Promise<SyncResult> {
  await run(repl, HELPERS)
  const paths = files.map((f) => f.path)
  // A JSON list of strings is also a Python list literal.
  const listing = await run(repl, `for _p in ${JSON.stringify(paths)}:\n    print(_h(_p))`)
  const hashes = listing.trim().split(/\r?\n/)
  const changed = files.filter((f, i) => hashes[i]?.trim() !== sha256(f.bytes))
  const previous = await readManifest(repl)
  const removed = previous.filter(
    (p) => !paths.includes(p) && !(RESERVED as readonly string[]).includes(p)
  )
  const result = {
    written: changed.map((f) => f.path),
    removed,
    unchanged: files.length - changed.length
  }
  if (dryRun) {
    return result
  }
  for (const file of changed) {
    await writeFile(repl, file)
  }
  for (const path of removed) {
    await run(repl, `_rm(${py(path)})`)
  }
  const manifest = JSON.stringify(paths)
  await run(repl, `_f = open(${py(MANIFEST)}, "w")\n_f.write(${py(manifest)})\n_f.close()`)
  return result
}

/**
 * Makes the board's files match a project: writes the files that differ, removes those a
 * previous deploy wrote that are gone, then soft-resets so `main.py` runs. Never touches the
 * SDK's reserved files or files a deploy didn't write.
 *
 * @param port - the board's open serial port
 * @param files - the project's files
 * @param dryRun - report what would change without changing it
 * @param config - raw REPL timings
 * @returns what changed
 * @throws {CliError} when the board refuses a write or its filesystem is full
 */
export async function syncProject(
  port: SerialPort,
  files: ProjectFile[],
  dryRun = false,
  config: RawReplConfig = defaultRawReplConfig
): Promise<SyncResult> {
  const repl = new RawRepl(port, config)
  await repl.enter()
  let result: SyncResult
  try {
    result = await syncWith(repl, files, dryRun)
    if (dryRun) {
      return result
    }
  } finally {
    await repl.exit()
  }
  // Ctrl-D at the normal prompt soft-resets the board, which runs boot.py and main.py.
  await port.write(new Uint8Array([0x04]))
  return result
}
