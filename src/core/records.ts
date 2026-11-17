import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { sameSerial } from "../board/discover.ts"
import type { Board } from "../board/pico.ts"
import { DEVICE_SDK } from "../board/sdk.ts"
import type { BoardOps } from "./boards.ts"
import { isVirtual } from "./virtual.ts"

/** A board as the core lists it: what the OS reports, plus what this computer deployed to it. */
export type ListedBoard = Board & {
  /** The Qualithm Device SDK release this computer's last deploy left on the board. */
  sdk?: string
}

/** What the core remembers about the boards it deployed to, by serial number. */
export type BoardRecords = {
  /**
   * @param serialNumber - the board's serial number, in any form `sameSerial` matches
   * @returns the device SDK release the last deploy left on it, when one is on record
   */
  sdk: (serialNumber: string) => string | undefined
  /** Records the device SDK release a deploy left on a board. */
  deployed: (serialNumber: string, sdk: string) => void
  /** Forgets a board, as after a flash that may have erased its files. */
  forget: (serialNumber: string) => void
}

type Entries = Record<string, { sdk: string }>

/**
 * Where the core keeps its board records: beside its socket.
 *
 * @param home - the user's home folder
 * @returns the file's path
 */
export function boardRecordsPath(home: string = homedir()): string {
  return join(home, ".qualithm", "boards.json")
}

function parseEntries(text: string): Entries {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A damaged file holds nothing usable; the next deploy writes a whole one.
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {}
  }
  const entries: Entries = {}
  for (const [serial, entry] of Object.entries(parsed)) {
    const sdk: unknown =
      typeof entry === "object" && entry !== null ? (entry as { sdk?: unknown }).sdk : undefined
    if (typeof sdk === "string" && sdk !== "") {
      entries[serial] = { sdk }
    }
  }
  return entries
}

/** The key a board is on record under, whichever form of its serial number listed it. */
function keyOf(entries: Entries, serialNumber: string): string | undefined {
  return Object.keys(entries).find((serial) => sameSerial(serial, serialNumber))
}

function without(entries: Entries, key: string | undefined): Entries {
  return key === undefined
    ? entries
    : Object.fromEntries(Object.entries(entries).filter(([serial]) => serial !== key))
}

/**
 * Board records in a JSON file, reread on every call. No file holds no records; each change
 * replaces the file whole, through a rename.
 *
 * @param path - the file
 * @returns the records
 */
export function fileRecords(path: string = boardRecordsPath()): BoardRecords {
  const load = (): Entries => {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {}
      }
      throw error
    }
    return parseEntries(text)
  }
  const save = (entries: Entries): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.tmp`
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  }
  return {
    sdk: (serialNumber) => {
      const entries = load()
      const key = keyOf(entries, serialNumber)
      return key === undefined ? undefined : entries[key]?.sdk
    },
    deployed: (serialNumber, sdk) => {
      const entries = load()
      save({ ...without(entries, keyOf(entries, serialNumber)), [serialNumber]: { sdk } })
    },
    forget: (serialNumber) => {
      const entries = load()
      const key = keyOf(entries, serialNumber)
      if (key !== undefined) {
        save(without(entries, key))
      }
    }
  }
}

/**
 * Wraps the core's board operations so every deploy that writes a board's files is recorded, a
 * flash forgets the board, and each listed board carries the SDK release on record for it.
 * Virtual devices aren't boards, so they're never recorded.
 *
 * @param ops - the board operations
 * @param records - where the records live
 * @param sdk - the device SDK release a deploy installs
 * @returns the operations, recording
 */
export function recordedOps(
  ops: BoardOps,
  records: BoardRecords,
  sdk: string = DEVICE_SDK.version
): BoardOps {
  return {
    ...ops,
    list: async () => {
      const boards = await ops.list()
      return boards.map((board): ListedBoard => {
        const release =
          board.serialNumber === undefined ? undefined : records.sdk(board.serialNumber)
        return release === undefined ? board : { ...board, sdk: release }
      })
    },
    flash: async (serialNumber) => {
      const result = await ops.flash(serialNumber)
      const flashed = result.serialNumber ?? serialNumber
      if (flashed !== undefined) {
        records.forget(flashed)
      }
      return result
    },
    deploy: async (serialNumber, files, dryRun, setup) => {
      const result = await ops.deploy(serialNumber, files, dryRun, setup)
      const deployed = result.board.serialNumber
      if (!dryRun && deployed !== undefined && !isVirtual(deployed)) {
        records.deployed(deployed, sdk)
      }
      return result
    }
  }
}
