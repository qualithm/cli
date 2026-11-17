import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  type BoardRecords,
  boardRecordsPath,
  fileRecords,
  type ListedBoard,
  recordedOps
} from "../../../core/records.ts"
import { fakeOps } from "./fake-ops.ts"

async function recordsFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "records-")), ".qualithm", "boards.json")
}

/** Records held in memory, with every call kept. */
function memoryRecords(): BoardRecords & { entries: Map<string, string>; calls: string[] } {
  const entries = new Map<string, string>()
  const calls: string[] = []
  return {
    entries,
    calls,
    sdk: (serial) => entries.get(serial),
    deployed: (serial, sdk) => {
      calls.push(`deployed:${serial}:${sdk}`)
      entries.set(serial, sdk)
    },
    forget: (serial) => {
      calls.push(`forget:${serial}`)
      entries.delete(serial)
    }
  }
}

describe("fileRecords", () => {
  it("keeps the board records beside the core's socket", () => {
    expect(boardRecordsPath("/home/ada")).toBe(join("/home/ada", ".qualithm", "boards.json"))
  })

  it("holds nothing until a deploy is recorded, and never writes for a forget", async () => {
    const path = await recordsFile()
    const records = fileRecords(path)
    expect(records.sdk("abc")).toBeUndefined()
    records.forget("abc")
    await expect(readFile(path, "utf8")).rejects.toThrow()
  })

  it("finds a board whichever form of its serial number lists it", async () => {
    const path = await recordsFile()
    const records = fileRecords(path)
    records.deployed("a6afd22c8a7c3ef8", "0.9.3")
    expect(records.sdk("A6AFD22C8A7C3EF8")).toBe("0.9.3")
    records.deployed("A6AFD22C8A7C3EF8", "0.9.4")
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(saved).toEqual({ A6AFD22C8A7C3EF8: { sdk: "0.9.4" } })
    records.forget("a6afd22c8a7c3ef8")
    expect(records.sdk("a6afd22c8a7c3ef8")).toBeUndefined()
  })

  it("reads a damaged file as no records and replaces it whole on the next deploy", async () => {
    const path = await recordsFile()
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "{not json")
    const records = fileRecords(path)
    expect(records.sdk("abc")).toBeUndefined()
    records.deployed("abc", "0.9.3")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ abc: { sdk: "0.9.3" } })
  })

  it("skips entries that carry no release", async () => {
    const path = await recordsFile()
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, JSON.stringify({ abc: { sdk: 3 }, def: null, ghi: { sdk: "0.9.3" } }))
    const records = fileRecords(path)
    expect(records.sdk("abc")).toBeUndefined()
    expect(records.sdk("def")).toBeUndefined()
    expect(records.sdk("ghi")).toBe("0.9.3")
    await writeFile(path, JSON.stringify(["abc"]))
    expect(records.sdk("ghi")).toBeUndefined()
  })

  it("raises a file it can't read", async () => {
    const path = await recordsFile()
    await mkdir(path, { recursive: true })
    expect(() => fileRecords(path).sdk("abc")).toThrow()
  })
})

describe("recordedOps", () => {
  it("records the SDK release each deploy leaves and lists it with the board", async () => {
    const records = memoryRecords()
    const ops = recordedOps(fakeOps(), records, "0.9.3")
    const before = await ops.list()
    expect(before[0]).not.toHaveProperty("sdk")
    await ops.deploy("abc", [], false)
    expect(records.calls).toEqual(["deployed:abc:0.9.3"])
    const after = (await ops.list()) as ListedBoard[]
    expect(after[0]).toMatchObject({ serialNumber: "abc", sdk: "0.9.3" })
  })

  it("leaves a board without a serial number unrecorded", async () => {
    const records = memoryRecords()
    const fake = fakeOps()
    fake.list = async () => Promise.resolve([{ state: "bootsel", drive: "/Volumes/RP2350" }])
    const ops = recordedOps(fake, records, "0.9.3")
    expect(await ops.list()).toEqual([{ state: "bootsel", drive: "/Volumes/RP2350" }])
  })

  it("records nothing for a dry run or a virtual device", async () => {
    const records = memoryRecords()
    const fake = fakeOps()
    const ops = recordedOps(fake, records, "0.9.3")
    await ops.deploy("abc", [], true)
    fake.deploy = async () =>
      Promise.resolve({
        board: { port: "virtual", serialNumber: "virtual:demo" },
        written: [],
        removed: [],
        unchanged: 0
      })
    await ops.deploy("virtual:demo", [], false)
    expect(records.calls).toEqual([])
  })

  it("forgets a board once it's flashed", async () => {
    const records = memoryRecords()
    records.entries.set("abc", "0.9.3")
    const ops = recordedOps(fakeOps(), records, "0.9.3")
    await ops.flash("abc")
    expect(records.calls).toEqual(["forget:abc"])
    expect(await ops.list()).toEqual([
      { state: "micropython", port: "/dev/cu.pico", serialNumber: "abc" }
    ])
  })

  it("passes every other verb through", async () => {
    const fake = fakeOps()
    const ops = recordedOps(fake, memoryRecords(), "0.9.3")
    await ops.reset("abc")
    expect(fake.calls).toEqual(["reset:abc"])
  })
})
