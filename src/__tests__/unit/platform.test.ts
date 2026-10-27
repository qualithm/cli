import { describe, expect, it } from "vitest"

import { CliError, DryRunError } from "../../envelope.ts"
import { Session, sessionFetch } from "../../platform.ts"
import { fakePlatform } from "./fake-platform.ts"

describe("sessionFetch", () => {
  it("sends reads with the User-Agent, even on a dry run", async () => {
    const { fetch, requests } = fakePlatform()
    const wrapped = sessionFetch(fetch, { dryRun: true, userAgent: "qualithm/test" })
    const res = await wrapped("https://api.example.com/v1/teams")
    expect(res.status).toBe(200)
    expect(requests).toEqual([{ method: "GET", path: "/v1/teams", userAgent: "qualithm/test" }])
  })

  it("refuses a mutation on a dry run, carrying its method, path and body", async () => {
    const { fetch, requests } = fakePlatform()
    const wrapped = sessionFetch(fetch, { dryRun: true })
    const sent = wrapped(new URL("https://api.example.com/v1/devices?x=1"), {
      method: "post",
      body: JSON.stringify({ name: "lab" })
    })
    await expect(sent).rejects.toEqual(
      new DryRunError({ method: "POST", path: "/v1/devices?x=1", body: { name: "lab" } })
    )
    expect(requests).toEqual([])
  })

  it("keeps a body that isn't JSON as text, and omits a missing one", async () => {
    const wrapped = sessionFetch(fakePlatform().fetch, { dryRun: true })
    const request = new Request("https://api.example.com/v1/x")
    await expect(wrapped(request, { method: "PUT", body: "raw" })).rejects.toMatchObject({
      action: { method: "PUT", path: "/v1/x", body: "raw" }
    })
    await expect(wrapped(request, { method: "DELETE", body: "" })).rejects.toMatchObject({
      action: { method: "DELETE", path: "/v1/x" }
    })
  })

  it("sends mutations when not a dry run", async () => {
    const { fetch, requests } = fakePlatform()
    await sessionFetch(fetch, {})("https://api.example.com/v1/teams/team_1/api-tokens/tok_1", {
      method: "DELETE"
    })
    expect(requests[0]).toMatchObject({ method: "DELETE", userAgent: null })
  })
})

describe("Session.teamId", () => {
  it("uses the configured team without asking the API", async () => {
    const { fetch, requests } = fakePlatform()
    const session = new Session({ token: "qmt_x", team: "team_9", fetch })
    expect(await session.teamId()).toBe("team_9")
    expect(requests).toEqual([])
  })

  it("asks the API once for the token's only team", async () => {
    const { fetch, requests } = fakePlatform()
    const session = new Session({ token: "qmt_x", team: "", fetch })
    expect(await session.teamId()).toBe("team_1")
    expect(await session.teamId()).toBe("team_1")
    expect(requests).toHaveLength(1)
  })

  it.each([
    ["no team", []],
    ["two teams", [{ id: "a" }, { id: "b" }]]
  ])("refuses when the credential has %s", async (_label, items) => {
    const { fetch } = fakePlatform({
      "GET /v1/teams": { status: 200, body: { data: { items, current: 1, last: 1 } } }
    })
    const session = new Session({ token: "qmt_x", fetch })
    await expect(session.teamId()).rejects.toBeInstanceOf(CliError)
  })
})
