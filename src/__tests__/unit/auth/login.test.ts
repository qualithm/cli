import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { fileLock, LoginSource } from "../../../auth/login.ts"
import { authorizeUrl, discover, listen, pkce, refresh, revoke } from "../../../auth/oauth.ts"
import { run } from "../../../cli.ts"
import { browserCommand, openBrowser } from "../../../commands/auth.ts"
import { memoryStore } from "../fake-platform.ts"
import { API, authCapture, fakeAuth } from "./fake-auth.ts"

const HOUR = 3600 * 1000

async function loggedIn(): Promise<{
  fake: ReturnType<typeof fakeAuth>
  c: ReturnType<typeof authCapture>
}> {
  const fake = fakeAuth()
  const c = authCapture(fake)
  expect(await run(["login"], c.io)).toBe(0)
  return { fake, c }
}

describe("qualithm login", () => {
  it("signs in with PKCE over a loopback redirect and keeps the tokens in the store", async () => {
    const { fake, c } = await loggedIn()
    const [url] = fake.opened
    expect(`${url?.origin ?? ""}${url?.pathname ?? ""}`).toBe("https://id.example.com/authorize")
    const params = url?.searchParams
    expect(params?.get("response_type")).toBe("code")
    expect(params?.get("client_id")).toBe("https://qualithm.com/oauth/cli.json")
    expect(params?.get("code_challenge_method")).toBe("S256")
    expect(params?.get("resource")).toBe(API)
    expect(params?.has("scope")).toBe(false)
    expect(params?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const stored = c.store.entries.get(API)
    expect(stored?.accessToken).toMatch(/^qmat_/)
    expect(stored?.refreshToken).toMatch(/^qmrt_/)
    expect(stored?.expiresAt).toBe(c.clock.now + HOUR)
    expect(stored?.scope).toBe("manager")
    expect(c.out()).toBe("logged in to team Acme (team_1) as manager\n")
    expect(c.err()).toContain("Approve the Qualithm CLI in your browser")
  })

  it("never puts a token in the JSON envelope", async () => {
    const fake = fakeAuth()
    const c = authCapture(fake)
    expect(await run(["login", "--json"], c.io)).toBe(0)
    const out = c.out()
    expect(JSON.parse(out)).toEqual({
      ok: true,
      data: { api: API, team: { id: "team_1", name: "Acme" }, role: "manager" }
    })
    expect(out + c.err()).not.toMatch(/qmat_|qmrt_/)
  })

  it("caps the sign-in at --role and reports the lower role", async () => {
    const fake = fakeAuth()
    const c = authCapture(fake)
    expect(await run(["login", "--role", "viewer"], c.io)).toBe(0)
    expect(fake.opened[0]?.searchParams.get("scope")).toBe("viewer")
    expect(c.out()).toBe("logged in to team Acme (team_1) as viewer\n")
  })

  it("refuses an unknown role", async () => {
    const c = authCapture(fakeAuth())
    expect(await run(["login", "--role", "admin"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --role must be one of owner, manager, viewer\n")
  })

  it("prints the link instead of opening a browser with --no-browser", async () => {
    const fake = fakeAuth()
    let link = ""
    const c = authCapture(fake)
    c.io.login = {
      ...c.io.login,
      openBrowser: async () => Promise.reject(new Error("should not open"))
    }
    const done = run(["login", "--no-browser"], {
      ...c.io,
      stderr: (text) => {
        link = /\s+(\S+)\n$/.exec(text)?.[1] ?? link
        if (link !== "") {
          void fake.openBrowser(link)
        }
      }
    })
    expect(await done).toBe(0)
    expect(link).toMatch(/^https:\/\/id\.example\.com\/authorize\?/)
  })

  it("prints the link when the browser can't be opened", async () => {
    const fake = fakeAuth()
    const c = authCapture(fake)
    let err = ""
    c.io.login = {
      ...c.io.login,
      openBrowser: async (url) => {
        setTimeout(() => void fake.openBrowser(url), 0)
        return Promise.resolve(false)
      }
    }
    c.io.stderr = (text) => {
      err += text
    }
    expect(await run(["login"], c.io)).toBe(0)
    expect(err).toMatch(/^Open this link to approve the Qualithm CLI:\n {2}https:/)
  })

  it("fails when the state does not match", async () => {
    const fake = fakeAuth()
    fake.consent = "wrong-state"
    const c = authCapture(fake)
    expect(await run(["login"], c.io)).toBe(3)
    expect(c.err()).toMatch(/qualithm: the sign-in answer did not match this login\n$/)
    expect(c.store.entries.size).toBe(0)
    expect(fake.forms).toEqual([])
  })

  it("fails when another issuer answers", async () => {
    const fake = fakeAuth()
    fake.consent = "wrong-iss"
    const c = authCapture(fake)
    expect(await run(["login", "--json"], c.io)).toBe(3)
    expect(JSON.parse(c.out())).toEqual({
      ok: false,
      code: "auth",
      message: "the sign-in answer came from another server than the API"
    })
    expect(c.store.entries.size).toBe(0)
  })

  it("reports a declined consent", async () => {
    const fake = fakeAuth()
    fake.consent = "deny"
    const c = authCapture(fake)
    expect(await run(["login"], c.io)).toBe(3)
    expect(c.err()).toMatch(/qualithm: sign-in was declined in the browser\n$/)
  })

  it("gives up when the browser never answers", async () => {
    const fake = fakeAuth()
    fake.consent = "silent"
    const c = authCapture(fake)
    c.io.login = { ...c.io.login, timeoutMs: 50 }
    expect(await run(["login"], c.io)).toBe(1)
    expect(c.err()).toMatch(/no answer from the browser in time: run qualithm login again\n$/)
  })

  it("refuses a code redeemed without its verifier", async () => {
    const fake = fakeAuth()
    const server = await discover(API, fake.fetch)
    const loopback = await listen({ state: "s", issuer: API })
    const { challenge } = pkce()
    await fake.openBrowser(
      authorizeUrl(server, { redirectUri: loopback.redirectUri, challenge, state: "s" })
    )
    const code = await loopback.code
    const { exchangeCode } = await import("../../../auth/oauth.ts")
    await expect(
      exchangeCode(
        server,
        { code, redirectUri: loopback.redirectUri, verifier: pkce().verifier },
        fake.fetch
      )
    ).rejects.toThrow("your sign-in has expired or was revoked: run qualithm login")
  })

  it("plans the sign-in on a dry run without opening a browser or storing anything", async () => {
    const fake = fakeAuth()
    const c = authCapture(fake)
    expect(await run(["login", "--dry-run", "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out())).toEqual({
      ok: true,
      dryRun: true,
      action: { method: "POST", path: "/oauth/token" },
      data: {
        api: API,
        authorizationEndpoint: "https://id.example.com/authorize",
        clientId: "https://qualithm.com/oauth/cli.json"
      }
    })
    expect(fake.opened).toEqual([])
    expect(c.store.entries.size).toBe(0)
  })

  it("says the API offers no sign-in when it publishes no metadata", async () => {
    const fake = fakeAuth()
    const c = authCapture(fake, { env: { QUALITHM_API_URL: "https://api.other.com" } })
    expect(await run(["login"], c.io)).toBe(4)
    expect(c.err()).toBe(
      "qualithm: https://api.other.com does not offer sign-in (status 404): set QUALITHM_API_TOKEN instead\n"
    )
  })

  it("refuses metadata naming another issuer", async () => {
    const fake = fakeAuth()
    fake.metadata = { ...fake.metadata, issuer: "https://evil.example.com" }
    const c = authCapture(fake)
    expect(await run(["login"], c.io)).toBe(7)
    expect(c.err()).toBe(`qualithm: the sign-in server names another issuer than ${API}\n`)
  })

  it("refuses a token endpoint off the API's origin", async () => {
    const fake = fakeAuth()
    fake.metadata = { ...fake.metadata, token_endpoint: "https://evil.example.com/token" }
    await expect(discover(API, fake.fetch)).rejects.toThrow(
      `the sign-in server's token_endpoint is not on ${API}`
    )
  })

  it("revokes the sign-in it replaces", async () => {
    const { fake, c } = await loggedIn()
    expect(await run(["login"], c.io)).toBe(0)
    expect(fake.grants.get("grant_1")?.revoked).toBe(true)
    expect(fake.grants.get("grant_2")?.revoked).toBe(false)
  })

  it("notes when QUALITHM_API_TOKEN takes precedence over the new sign-in", async () => {
    const fake = fakeAuth()
    const c = authCapture(fake, { env: { QUALITHM_API_URL: API, QUALITHM_API_TOKEN: "qmt_env" } })
    expect(await run(["login", "--json"], c.io)).toBe(0)
    expect(c.err()).toContain("QUALITHM_API_TOKEN is set, and takes precedence")
    expect((JSON.parse(c.out()) as { data: unknown }).data).toMatchObject({
      overriddenBy: "QUALITHM_API_TOKEN"
    })
  })
})

describe("the stored sign-in", () => {
  it("authenticates every API call, with no token configured", async () => {
    const { fake, c } = await loggedIn()
    expect(await run(["token", "list", "--json"], c.io)).toBe(0)
    expect(fake.bearers.at(-1)).toBe(c.store.entries.get(API)?.accessToken)
  })

  it("refreshes an expired access token without asking, rotating the refresh token", async () => {
    const { fake, c } = await loggedIn()
    const before = c.store.entries.get(API)
    c.clock.now += HOUR
    expect(await run(["token", "list"], c.io)).toBe(0)
    const after = c.store.entries.get(API)
    expect(after?.refreshToken).not.toBe(before?.refreshToken)
    expect(after?.accessToken).not.toBe(before?.accessToken)
    expect(fake.forms.at(-1)?.get("grant_type")).toBe("refresh_token")
    expect(fake.forms.at(-1)?.get("refresh_token")).toBe(before?.refreshToken)
  })

  it("refreshes once when the API refuses a token that has not lapsed yet", async () => {
    const { fake, c } = await loggedIn()
    fake.expireAccess()
    expect(await run(["token", "list"], c.io)).toBe(0)
    expect(fake.forms.filter((f) => f.get("grant_type") === "refresh_token")).toHaveLength(1)
  })

  it("says to log in again when the refresh token was revoked", async () => {
    const { fake, c } = await loggedIn()
    fake.revokeAll()
    c.clock.now += HOUR
    expect(await run(["token", "list"], c.io)).toBe(3)
    expect(c.err()).toMatch(
      /\nqualithm: your sign-in has expired or was revoked: run qualithm login\n$/
    )
    expect(c.store.entries.has(API)).toBe(true)
  })

  it("adopts a refresh another process already made instead of reusing the old token", async () => {
    const { fake, c } = await loggedIn()
    const source = new LoginSource({
      api: API,
      store: c.store,
      fetch: fake.fetch,
      lock: async (task) => task(),
      now: () => c.clock.now
    })
    const stale = await source.accessToken()
    c.clock.now += HOUR
    // Another process refreshes first.
    expect(await run(["token", "list"], c.io)).toBe(0)
    const rotated = c.store.entries.get(API)?.accessToken
    expect(await source.accessToken(stale)).toBe(rotated)
    expect(fake.grants.get("grant_1")?.revoked).toBe(false)
  })

  it("shares one refresh between concurrent calls in a process", async () => {
    const { fake, c } = await loggedIn()
    const source = new LoginSource({
      api: API,
      store: c.store,
      fetch: fake.fetch,
      lock: async (task) => task(),
      now: () => c.clock.now
    })
    await source.present()
    c.clock.now += HOUR
    const [a, b] = await Promise.all([source.accessToken(), source.accessToken()])
    expect(a).toBe(b)
    expect(fake.grants.get("grant_1")?.revoked).toBe(false)
  })

  it("lets QUALITHM_API_TOKEN take precedence over the stored sign-in", async () => {
    const { fake, c } = await loggedIn()
    c.io.env = { QUALITHM_API_URL: API, QUALITHM_API_TOKEN: "qmt_env" }
    expect(await run(["whoami"], c.io)).toBe(0)
    expect(fake.bearers.at(-1)).toBe("qmt_env")
    expect(c.out()).toMatch(/with QUALITHM_API_TOKEN\n$/)
  })

  it("serves every tool over MCP from the stored sign-in", async () => {
    const { c } = await loggedIn()
    let count = 0
    c.io.serveMcp = async (server) => {
      await Promise.resolve()
      count = Object.keys(
        (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
      ).length
    }
    expect(await run(["mcp"], c.io)).toBe(0)
    expect(c.err()).not.toContain("serving only the board tools")
    expect(count).toBeGreaterThan(20)
  })
})

describe("qualithm whoami", () => {
  it("names the team and role of the sign-in", async () => {
    const { c } = await loggedIn()
    expect(await run(["whoami", "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out().split("\n").at(-2) ?? "")).toEqual({
      ok: true,
      data: {
        api: API,
        credential: "login",
        team: { id: "team_1", name: "Acme" },
        role: "manager"
      }
    })
  })

  it("prints the team and role in a terminal", async () => {
    const { c } = await loggedIn()
    expect(await run(["whoami"], c.io)).toBe(0)
    expect(c.out()).toMatch(
      /team Acme \(team_1\) as manager on https:\/\/api\.example\.com, with your sign-in\n$/
    )
  })

  it("says to log in when there is no credential", async () => {
    const c = authCapture(fakeAuth())
    expect(await run(["whoami"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: not logged in: run qualithm login, or set QUALITHM_API_TOKEN\n")
  })
})

describe("qualithm logout", () => {
  it("revokes the grant on the server and clears the store", async () => {
    const { fake, c } = await loggedIn()
    const refreshToken = c.store.entries.get(API)?.refreshToken
    expect(await run(["logout"], c.io)).toBe(0)
    expect(c.out()).toMatch(/logged out of https:\/\/api\.example\.com\n$/)
    const form = fake.forms.at(-1)
    expect(form?.get("token")).toBe(refreshToken)
    expect(form?.get("client_id")).toBe("https://qualithm.com/oauth/cli.json")
    expect(fake.grants.get("grant_1")?.revoked).toBe(true)
    expect(c.store.entries.has(API)).toBe(false)
    expect(await run(["token", "list"], c.io)).toBe(2)
  })

  it("plans the sign-out on a dry run without revoking or clearing", async () => {
    const { fake, c } = await loggedIn()
    expect(await run(["logout", "--dry-run"], c.io)).toBe(0)
    expect(c.out()).toMatch(/dry-run: would POST \/oauth\/revoke\n$/)
    expect(fake.grants.get("grant_1")?.revoked).toBe(false)
    expect(c.store.entries.has(API)).toBe(true)
  })

  it("keeps the sign-in when the server can't revoke it", async () => {
    const { fake, c } = await loggedIn()
    const failing = fake.fetch
    c.io.fetch = async (input, init) =>
      (typeof input === "string" ? input : "").endsWith("/oauth/revoke")
        ? new Response(null, { status: 503 })
        : failing(input, init)
    expect(await run(["logout"], c.io)).toBe(8)
    expect(c.err()).toMatch(
      /\nqualithm: the sign-in server answered 503: nothing was changed, try again\n$/
    )
    expect(c.store.entries.has(API)).toBe(true)
  })

  it("does nothing when not logged in", async () => {
    const c = authCapture(fakeAuth())
    expect(await run(["logout", "--json"], c.io)).toBe(0)
    expect(JSON.parse(c.out())).toEqual({ ok: true, data: { api: API, loggedOut: false } })
  })
})

describe("auth commands", () => {
  it("print their help", async () => {
    const c = authCapture(fakeAuth())
    expect(await run(["login", "--help"], c.io)).toBe(0)
    expect(c.out()).toContain("qualithm login [--role owner|manager|viewer] [--no-browser]")
  })

  it("reject an unknown flag", async () => {
    const c = authCapture(fakeAuth())
    expect(await run(["logout", "--bogus"], c.io)).toBe(2)
    expect(c.err()).toMatch(/^qualithm: unknown option/)
  })

  it("reject a --url that is not a URL", async () => {
    const c = authCapture(fakeAuth())
    expect(await run(["whoami", "--url", "nope"], c.io)).toBe(2)
    expect(c.err()).toBe("qualithm: --url is not a URL: nope\n")
  })
})

describe("oauth requests", () => {
  it("report an unreachable server", async () => {
    const down = async (): Promise<Response> => Promise.reject(new Error("ECONNREFUSED"))
    await expect(discover(API, down)).rejects.toThrow(
      "could not reach the sign-in server: econnrefused"
    )
    const server = await discover(API, fakeAuth().fetch)
    await expect(refresh(server, "qmrt_x", down)).rejects.toThrow("could not reach")
    await expect(revoke(server, "qmrt_x", down)).rejects.toThrow("could not reach")
  })

  it("report a token endpoint that fails or returns no tokens", async () => {
    const server = await discover(API, fakeAuth().fetch)
    const reply = (status: number, body?: unknown) => async (): Promise<Response> =>
      Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }))
    await expect(refresh(server, "x", reply(500))).rejects.toThrow(
      "the sign-in server answered 500: try again"
    )
    await expect(refresh(server, "x", reply(503))).rejects.toMatchObject({ code: "unavailable" })
    await expect(refresh(server, "x", reply(200, {}))).rejects.toThrow(
      "the sign-in server returned no tokens"
    )
    const minimal = await refresh(
      server,
      "x",
      reply(200, { access_token: "a", refresh_token: "r" }),
      () => 0
    )
    expect(minimal).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: HOUR, scope: "" })
  })

  it("refuse metadata without S256 or an endpoint, or over http", async () => {
    const fake = fakeAuth()
    fake.metadata = { ...fake.metadata, code_challenge_methods_supported: ["plain"] }
    await expect(discover(API, fake.fetch)).rejects.toThrow("does not support PKCE with S256")
    fake.metadata = {
      ...fake.metadata,
      code_challenge_methods_supported: undefined,
      revocation_endpoint: undefined
    }
    await expect(discover(API, fake.fetch)).rejects.toThrow("lists no revocation_endpoint")
    fake.metadata = {
      ...fake.metadata,
      revocation_endpoint: `${API}/oauth/revoke`,
      authorization_endpoint: "http://id.example.com/authorize"
    }
    await expect(discover(API, fake.fetch)).rejects.toThrow("authorization_endpoint is not https")
  })

  it("answer 404 on the loopback for any other path, and refuse a callback without a code", async () => {
    const loopback = await listen({ state: "s", issuer: API })
    const other = await fetch(loopback.redirectUri.replace("/callback", "/favicon.ico"))
    expect(other.status).toBe(404)
    const bad = await fetch(`${loopback.redirectUri}?state=s&iss=${encodeURIComponent(API)}`)
    expect(bad.status).toBe(400)
    await expect(loopback.code).rejects.toThrow("sign-in failed: no code returned")
  })
})

describe("fileLock", () => {
  it("runs one task at a time and removes its lock file", async () => {
    const home = mkdtempSync(join(tmpdir(), "qualithm-lock-"))
    const lock = fileLock(home)
    const order: string[] = []
    await Promise.all([
      lock(async () => {
        order.push("a-start")
        await new Promise((resolve) => setTimeout(resolve, 150))
        order.push("a-end")
      }),
      lock(async () => {
        order.push("b-start")
        await Promise.resolve()
        order.push("b-end")
      })
    ])
    expect([order.slice(0, 2).join(), order.slice(2).join()].sort()).toEqual([
      "a-start,a-end",
      "b-start,b-end"
    ])
    expect(readdirSync(join(home, ".qualithm"))).toEqual([])
  })

  it("takes over a stale lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "qualithm-lock-"))
    await fileLock(home)(async () => Promise.resolve())
    const path = join(home, ".qualithm", "login.lock")
    writeFileSync(path, "")
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    expect(await fileLock(home)(async () => Promise.resolve("ran"))).toBe("ran")
  })
})

describe("openBrowser", () => {
  it("starts the OS's own command, and reports whether it could", async () => {
    expect(browserCommand("https://x.test", "darwin")).toEqual(["open", ["https://x.test"]])
    expect(browserCommand("https://x.test", "linux")).toEqual(["xdg-open", ["https://x.test"]])
    expect(browserCommand("https://x.test", "win32")).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", "https://x.test"]
    ])
    expect(await openBrowser("https://x.test", ["qualithm-no-such-browser", []])).toBe(false)
    expect(await openBrowser("https://x.test", ["true", []])).toBe(true)
  })
})

describe("memoryStore", () => {
  it("clears an entry", async () => {
    const store = memoryStore()
    await store.clear(API)
    expect(await store.read(API)).toBeUndefined()
  })
})
