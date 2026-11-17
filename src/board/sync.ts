import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { CliError } from "../envelope.ts"
import { defaultRawReplConfig, RawRepl, type RawReplConfig } from "./raw-repl.ts"
import { DEVICE_SDK, FROZEN_SDK_PROBE, isSdkPath, SDK_DIRS, SDK_PACKAGE_DIR } from "./sdk.ts"
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

/** What a board already holds for joining the platform. */
export type SetupState = {
  /** The SDK has stored a credential: the board is claimed. */
  credential: boolean
  /** A setup file still holds an unspent claim code. */
  claimCode: boolean
  /** The network a setup file names, so a redeploy can keep it. */
  wifiNetwork?: string
}

/** What deploy writes to `/qualithm-setup.json` for the SDK's `pico.start()`. */
export type Setup = {
  provisioningUrl: string
  claimCode: string
  /** Omitted to keep the network the board's setup file already names. */
  wifi?: { ssid: string; passphrase: string }
}

const SETUP_PATH = "/qualithm-setup.json"

/** The board-side check for a credential and a setup file; prints one JSON line. */
export const PROBE = `import os, json
try:
    os.stat("/qualithm-credential.json")
    _c = True
except OSError:
    _c = False
try:
    _s = json.loads(open("/qualithm-setup.json").read())
except (OSError, ValueError):
    _s = {}
_w = _s.get("wifi") if isinstance(_s, dict) else None
print(json.dumps({"credential": _c, "claimCode": bool(isinstance(_s, dict) and _s.get("claimCode")), "wifiNetwork": _w.get("ssid") if isinstance(_w, dict) else None}))`

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
  const sdk = files.find((f) => isSdkPath(f.path))
  if (sdk !== undefined) {
    throw new CliError(
      `the project has ${sdk.path}, where deploy installs the device SDK: rename it`,
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
def _rd(ds):
    for d in ds:
        try:
            os.rmdir(d)
        except OSError:
            pass
def _ls(d):
    try:
        names = os.listdir(d)
    except OSError:
        return
    for n in names:
        p = d + "/" + n
        if os.stat(p)[0] & 0x4000:
            _ls(p)
        else:
            print(p)
`

/** Folders a deploy never removes, even when it empties them. */
const KEPT_DIRS = new Set(["/", "/lib"])

/**
 * The folders that removing `removed` may have emptied, deepest first: each removed file's
 * parent folders, less `/`, `/lib` and any folder a project file is in. An empty folder at the
 * root shadows a package of the same name in `/lib` (qualithm/pm#3663).
 *
 * @param removed - the files removed, absolute on the board
 * @param kept - the project's files, absolute on the board
 * @returns the folders to try removing; the board keeps any that still hold something
 */
export function emptiedDirs(removed: readonly string[], kept: readonly string[]): string[] {
  const parents = (path: string): string[] => {
    const parts = path.split("/").slice(1, -1)
    return parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`)
  }
  const keep = new Set([...KEPT_DIRS, ...kept.flatMap(parents)])
  const dirs = new Set(removed.flatMap(parents).filter((d) => !keep.has(d)))
  return [...dirs].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b))
}

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
 * Reads which device SDK release the board's firmware has frozen in, if any.
 *
 * @param repl - the session
 * @returns the release, or undefined on firmware without the SDK built in
 * @throws {CliError} when the board raises
 */
export async function frozenSdk(repl: Repl): Promise<string | undefined> {
  const version = (await run(repl, FROZEN_SDK_PROBE)).trim()
  return version === "" ? undefined : version
}

/**
 * Leaves the SDK's own package out of a deploy to firmware that has it frozen in. MicroPython
 * imports frozen modules before `/lib`, so a copy there would never run.
 *
 * @param files - the project's files and the SDK's
 * @param frozen - the release the firmware has frozen in, if any
 * @param version - the release this deploy installs
 * @returns the files to write
 * @throws {CliError} when the firmware has another release frozen in
 */
export function withoutFrozenSdk(
  files: ProjectFile[],
  frozen: string | undefined,
  version: string
): ProjectFile[] {
  if (frozen === undefined) {
    return files
  }
  if (frozen !== version) {
    throw new CliError(
      `the board's firmware has the device SDK ${frozen} built in, not ${version}: run \`qualithm board flash\` to update it, then deploy again`,
      "error"
    )
  }
  return files.filter((f) => !f.path.startsWith(`${SDK_PACKAGE_DIR}/`))
}

/**
 * The sync itself, inside a raw REPL session the caller holds. On firmware with the device SDK
 * frozen in, the SDK's package isn't written, and a copy a previous deploy wrote is removed.
 *
 * @param repl - the session
 * @param all - the project's files and the SDK's
 * @param dryRun - report what would change without changing it
 * @param sdkVersion - the device SDK release among `all`
 * @returns what changed
 * @throws {CliError} when the board refuses a write, its filesystem is full, or its firmware has
 *   another SDK release frozen in
 */
export async function syncWith(
  repl: Repl,
  all: ProjectFile[],
  dryRun: boolean,
  sdkVersion: string = DEVICE_SDK.version
): Promise<SyncResult> {
  const files = withoutFrozenSdk(all, await frozenSdk(repl), sdkVersion)
  await run(repl, HELPERS)
  const paths = files.map((f) => f.path)
  // A JSON list of strings is also a Python list literal.
  const listing = await run(repl, `for _p in ${JSON.stringify(paths)}:\n    print(_h(_p))`)
  const hashes = listing.trim().split(/\r?\n/)
  const changed = files.filter((f, i) => hashes[i]?.trim() !== sha256(f.bytes))
  const previous = await readManifest(repl)
  // The SDK's folders hold only the SDK: a stale copy there, say a .py, would shadow it.
  const owned = (await run(repl, `for _d in ${JSON.stringify(SDK_DIRS)}:\n    _ls(_d)`))
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
  const removed = [...new Set([...previous, ...owned])].filter(
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
  const dirs = emptiedDirs(removed, paths)
  if (dirs.length > 0) {
    // os.rmdir refuses a folder that still holds something, so only emptied folders go.
    await run(repl, `_rd(${JSON.stringify(dirs)})`)
  }
  const manifest = JSON.stringify(paths)
  await run(repl, `_f = open(${py(MANIFEST)}, "w")\n_f.write(${py(manifest)})\n_f.close()`)
  return result
}

/**
 * Reads what the board holds for joining the platform, inside a raw REPL session.
 *
 * @param repl - the session
 * @returns the state
 * @throws {CliError} when the board raises
 */
export async function probeSetup(repl: Repl): Promise<SetupState> {
  const out = await run(repl, PROBE)
  const parsed = JSON.parse(out.trim()) as {
    credential: boolean
    claimCode: boolean
    wifiNetwork: string | null
  }
  return {
    credential: parsed.credential,
    claimCode: parsed.claimCode,
    ...(typeof parsed.wifiNetwork === "string" ? { wifiNetwork: parsed.wifiNetwork } : {})
  }
}

/**
 * Writes the setup file, replacing it atomically. Without `wifi`, keeps the network the
 * existing file names.
 *
 * @param repl - the session
 * @param setup - what to write
 * @throws {CliError} when no Wi-Fi is given and the board's setup file has none
 */
export async function writeSetup(repl: Repl, setup: Setup): Promise<void> {
  // The JSON is passed as a string, so the passphrase is never Python source.
  await run(
    repl,
    `import json, os
_n = json.loads(${py(JSON.stringify(setup))})
if "wifi" not in _n:
    _n["wifi"] = json.loads(open(${py(SETUP_PATH)}).read())["wifi"]
_f = open(${py(`${SETUP_PATH}.tmp`)}, "w")
_f.write(json.dumps(_n))
_f.close()
os.rename(${py(`${SETUP_PATH}.tmp`)}, ${py(SETUP_PATH)})`
  )
}

/** How {@link syncProject} runs a deploy. */
export type SyncOptions = {
  /** Report what would change without changing it. */
  dryRun?: boolean
  /** Raw REPL timings. */
  config?: RawReplConfig
  /** A setup file to write before the reset, for a board not yet claimed. */
  setup?: Setup
}

/**
 * Makes the board's files match a project: writes the files that differ, removes those a
 * previous deploy wrote that are gone and any folder that leaves empty, then soft-resets so `main.py` runs. Never touches the
 * SDK's reserved files or files a deploy didn't write.
 *
 * @param port - the board's open serial port
 * @param files - the project's files and the device SDK's
 * @param sdkVersion - the device SDK release among `files`
 * @param options - a dry run, raw REPL timings, and a setup file to write
 * @returns what changed
 * @throws {CliError} when the board refuses a write, its filesystem is full, or its firmware has
 *   another SDK release frozen in
 */
export async function syncProject(
  port: SerialPort,
  files: ProjectFile[],
  sdkVersion: string,
  { dryRun = false, config = defaultRawReplConfig, setup }: SyncOptions = {}
): Promise<SyncResult> {
  const repl = new RawRepl(port, config)
  await repl.enter()
  let result: SyncResult
  try {
    result = await syncWith(repl, files, dryRun, sdkVersion)
    if (dryRun) {
      return result
    }
    if (setup !== undefined) {
      await writeSetup(repl, setup)
    }
  } finally {
    await repl.exit()
  }
  // Ctrl-D at the normal prompt soft-resets the board, which runs boot.py and main.py.
  await port.write(new Uint8Array([0x04]))
  return result
}

/**
 * Reads what a running board holds for joining the platform.
 *
 * @param port - the board's open serial port
 * @param config - raw REPL timings
 * @returns the state
 * @throws {CliError} when the board doesn't answer or raises
 */
export async function probeBoard(
  port: SerialPort,
  config: RawReplConfig = defaultRawReplConfig
): Promise<SetupState> {
  const repl = new RawRepl(port, config)
  await repl.enter()
  try {
    return await probeSetup(repl)
  } finally {
    await repl.exit()
  }
}
