import { describe, expect, it } from "vitest"

import { keychainStore, type SecretHost, type StoredLogin } from "../../../auth/store.ts"

const ORIGIN = "https://api.example.com"
const LOGIN: StoredLogin = {
  accessToken: "qmat_a",
  refreshToken: "qmrt_r",
  expiresAt: 1_800_000_000_000,
  scope: "manager"
}

type Call = { command: string; args: readonly string[]; input?: string }

function host(
  platform: NodeJS.Platform,
  reply: (call: Call) => string | { code: number | string }
): SecretHost & { calls: Call[] } {
  const calls: Call[] = []
  return {
    platform,
    calls,
    run: async (command, args, input) => {
      const call = { command, args, ...(input === undefined ? {} : { input }) }
      calls.push(call)
      const result = reply(call)
      if (typeof result === "string") {
        return Promise.resolve(result)
      }
      return Promise.reject(Object.assign(new Error("failed"), result))
    }
  }
}

const decodedScript = (args: readonly string[]): string =>
  Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le")

describe("keychainStore on macOS", () => {
  it("writes over stdin, so the secret never shows on a command line", async () => {
    const h = host("darwin", () => "")
    await keychainStore(h).write(ORIGIN, LOGIN)
    const [call] = h.calls
    expect(call?.command).toBe("security")
    expect(call?.args).toEqual(["-i"])
    expect(call?.args.join(" ")).not.toContain("qmrt_")
    const hex = /-X ([0-9a-f]+)\n$/.exec(call?.input ?? "")?.[1] ?? ""
    expect(JSON.parse(Buffer.from(hex, "hex").toString("utf8"))).toEqual(LOGIN)
    expect(call?.input).toContain(`-s qualithm -a "${ORIGIN}"`)
  })

  it("reads the entry back, and treats a missing one as none", async () => {
    const found = host("darwin", () => `${JSON.stringify(LOGIN)}\n`)
    expect(await keychainStore(found).read(ORIGIN)).toEqual(LOGIN)
    expect(found.calls[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "qualithm",
      "-a",
      ORIGIN,
      "-w"
    ])
    expect(await keychainStore(host("darwin", () => ({ code: 44 }))).read(ORIGIN)).toBeUndefined()
    expect(await keychainStore(host("darwin", () => "not json")).read(ORIGIN)).toBeUndefined()
    expect(await keychainStore(host("darwin", () => '{"a":1}')).read(ORIGIN)).toBeUndefined()
  })

  it("reports a keychain that refuses", async () => {
    const refusing = keychainStore(host("darwin", () => ({ code: 51 })))
    await expect(refusing.read(ORIGIN)).rejects.toThrow(
      "could not read the sign-in from this computer's keychain: failed"
    )
    await expect(refusing.write(ORIGIN, LOGIN)).rejects.toThrow(
      "could not save the sign-in to this computer's keychain"
    )
    await expect(refusing.clear(ORIGIN)).rejects.toThrow(
      "could not clear the sign-in from this computer's keychain"
    )
  })

  it("clears the entry, and a missing one is fine", async () => {
    const h = host("darwin", () => ({ code: 44 }))
    await keychainStore(h).clear(ORIGIN)
    expect(h.calls[0]?.args[0]).toBe("delete-generic-password")
  })

  it("refuses an origin that could break out of the command", async () => {
    await expect(
      keychainStore(host("darwin", () => "")).write('https://x" -A', LOGIN)
    ).rejects.toThrow("not an API origin")
  })
})

describe("keychainStore on Linux", () => {
  it("stores through secret-tool with the secret on stdin", async () => {
    const h = host("linux", () => "")
    await keychainStore(h).write(ORIGIN, LOGIN)
    expect(h.calls[0]).toEqual({
      command: "secret-tool",
      args: ["store", "--label=Qualithm CLI sign-in", "service", "qualithm", "account", ORIGIN],
      input: JSON.stringify(LOGIN)
    })
  })

  it("looks the entry up, treating not found and no secret-tool as none", async () => {
    expect(await keychainStore(host("linux", () => JSON.stringify(LOGIN))).read(ORIGIN)).toEqual(
      LOGIN
    )
    expect(await keychainStore(host("linux", () => ({ code: 1 }))).read(ORIGIN)).toBeUndefined()
    expect(
      await keychainStore(host("linux", () => ({ code: "ENOENT" }))).read(ORIGIN)
    ).toBeUndefined()
    await expect(keychainStore(host("linux", () => ({ code: 2 }))).read(ORIGIN)).rejects.toThrow(
      "could not read the sign-in"
    )
  })

  it("says how to get a keychain when secret-tool is missing", async () => {
    const missing = keychainStore(host("linux", () => ({ code: "ENOENT" })))
    await expect(missing.write(ORIGIN, LOGIN)).rejects.toThrow(
      "this computer has no keychain the CLI can use: install secret-tool (libsecret), or set QUALITHM_API_TOKEN"
    )
    await missing.clear(ORIGIN)
    await expect(
      keychainStore(host("linux", () => ({ code: 3 }))).write(ORIGIN, LOGIN)
    ).rejects.toThrow("could not save")
    await expect(keychainStore(host("linux", () => ({ code: 3 }))).clear(ORIGIN)).rejects.toThrow(
      "could not clear"
    )
  })
})

describe("keychainStore on Windows", () => {
  it("writes to Credential Manager with the secret on stdin", async () => {
    const h = host("win32", () => "")
    await keychainStore(h).write(ORIGIN, LOGIN)
    const [call] = h.calls
    expect(call?.command).toBe("powershell.exe")
    expect(call?.input).toBe(JSON.stringify(LOGIN))
    const script = decodedScript(call?.args ?? [])
    expect(script).toContain(
      `[QualithmCredential]::Write('qualithm:${ORIGIN}', [Console]::In.ReadToEnd())`
    )
    expect(script).toContain("CredWriteW")
    expect(script).not.toContain("qmrt_")
  })

  it("reads and deletes the entry", async () => {
    const h = host("win32", (call) =>
      decodedScript(call.args).includes("::Read(") ? JSON.stringify(LOGIN) : ""
    )
    const store = keychainStore(h)
    expect(await store.read(ORIGIN)).toEqual(LOGIN)
    await store.clear(ORIGIN)
    expect(decodedScript(h.calls[1]?.args ?? [])).toContain(
      `[QualithmCredential]::Delete('qualithm:${ORIGIN}')`
    )
    expect(await keychainStore(host("win32", () => "")).read(ORIGIN)).toBeUndefined()
  })

  it("reports a failure", async () => {
    const failing = keychainStore(host("win32", () => ({ code: 1 })))
    await expect(failing.read(ORIGIN)).rejects.toThrow("could not read")
    await expect(failing.write(ORIGIN, LOGIN)).rejects.toThrow("could not save")
    await expect(failing.clear(ORIGIN)).rejects.toThrow("could not clear")
  })
})

describe("keychainStore elsewhere", () => {
  it("holds nothing and refuses to save", async () => {
    const store = keychainStore(host("freebsd", () => ""))
    expect(await store.read(ORIGIN)).toBeUndefined()
    await store.clear(ORIGIN)
    await expect(store.write(ORIGIN, LOGIN)).rejects.toThrow(
      "this computer has no keychain the CLI can use: set QUALITHM_API_TOKEN"
    )
  })
})

describe("defaultSecretHost", () => {
  it("passes stdin to the command and rejects with its exit code", async () => {
    const { defaultSecretHost } = await import("../../../auth/store.ts")
    expect(await defaultSecretHost.run("cat", [], "hello")).toBe("hello")
    await expect(defaultSecretHost.run("false", [])).rejects.toMatchObject({ code: 1 })
  })
})
