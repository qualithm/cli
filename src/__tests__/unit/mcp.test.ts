import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, it } from "vitest"

import { buildMcpServer, callTool, type SessionFactory, toCallToolResult } from "../../mcp.ts"
import { Session } from "../../platform.ts"
import { TOOLS } from "../../tools/index.ts"
import { listApiTokens, revokeApiToken } from "../../tools/tokens.ts"
import { DEFAULT_ROUTES, fakePlatform, TOKEN } from "./fake-platform.ts"

function sessions(): {
  newSession: SessionFactory
  requests: ReturnType<typeof fakePlatform>["requests"]
} {
  const { fetch, requests } = fakePlatform()
  return {
    newSession: (dryRun) => new Session({ token: "qmt_x", fetch, dryRun, userAgent: "test" }),
    requests
  }
}

async function connect(newSession: SessionFactory): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildMcpServer(newSession, "9.9.9").connect(serverSide)
  const client = new Client({ name: "test", version: "1" })
  await client.connect(clientSide)
  return client
}

// The agent contract every tool keeps: snake_case unique names, and dryRun on exactly the tools
// that change state.
describe("tool registry conformance", () => {
  it("names every tool once, in snake_case", () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/)
    }
  })

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
    "%s takes dryRun exactly when it mutates",
    (_name, tool) => {
      expect("dryRun" in tool.input).toBe(tool.mutating)
      expect(tool.description).not.toBe("")
    }
  )

  it("serves exactly the registry over MCP", async () => {
    const client = await connect(sessions().newSession)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name))
    const revoke = tools.find((tool) => tool.name === "revoke_api_token")
    expect(revoke?.inputSchema.properties).toHaveProperty("dryRun")
    expect(client.getServerVersion()).toMatchObject({ name: "qualithm", version: "9.9.9" })
  })
})

describe("callTool", () => {
  it("returns the API's payload in the envelope", async () => {
    const result = await callTool(listApiTokens, sessions().newSession, { limit: 5 })
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ items: [{ id: TOKEN.id }] })
  })

  it("plans a mutation without sending it on a dry run", async () => {
    const { newSession, requests } = sessions()
    const result = await callTool(revokeApiToken, newSession, { tokenId: "tok_1", dryRun: true })
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      action: { method: "DELETE", path: "/v1/teams/team_1/api-tokens/tok_1" }
    })
    expect(requests.map((r) => r.method)).toEqual(["GET"])
  })

  it("sends the mutation when not a dry run", async () => {
    const { newSession, requests } = sessions()
    expect(await callTool(revokeApiToken, newSession, { tokenId: "tok_1" })).toEqual({ ok: true })
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", userAgent: "test" })
  })

  it("rejects invalid input as a usage error naming the field", async () => {
    const result = await callTool(revokeApiToken, sessions().newSession, { tokenId: 7 })
    expect(result).toMatchObject({ ok: false, code: "usage" })
    expect(result.message).toMatch(/^tokenId: /)
  })

  it("reports a refused input with no field as a usage error", async () => {
    const result = await callTool(listApiTokens, sessions().newSession, "nope")
    expect(result).toMatchObject({ ok: false, code: "usage" })
  })

  it("classifies an API failure by status", async () => {
    const result = await callTool(revokeApiToken, sessions().newSession, { tokenId: "tok_404" })
    expect(result).toEqual({ ok: false, code: "not_found", message: "not found" })
  })
})

describe("over MCP", () => {
  it("returns the envelope as structured content", async () => {
    const client = await connect(sessions().newSession)
    const res = await client.callTool({ name: "list_api_tokens", arguments: {} })
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toMatchObject({ ok: true, data: { items: [{ id: "tok_1" }] } })
  })

  it("flags a failure as an error with its code in the text", async () => {
    const client = await connect(sessions().newSession)
    const res = await client.callTool({ name: "revoke_api_token", arguments: { tokenId: "nope" } })
    expect(res.isError).toBe(true)
    expect(res.content).toEqual([{ type: "text", text: "not_found: not found" }])
  })
})

describe("a team's spent write cap", () => {
  it("names the refusal and keeps the API's retry hint", async () => {
    const { fetch } = fakePlatform({
      ...DEFAULT_ROUTES,
      "DELETE /v1/teams/team_1/api-tokens/tok_1": {
        status: 429,
        body: { message: "team write rate exceeded: retry after 3s", code: "team_write_limited" }
      }
    })
    const client = await connect(
      (dryRun) => new Session({ token: "qmt_x", fetch, dryRun, userAgent: "test" })
    )
    const res = await client.callTool({ name: "revoke_api_token", arguments: { tokenId: "tok_1" } })
    expect(res.isError).toBe(true)
    expect(res.content).toEqual([
      { type: "text", text: "rate_limited: team write rate exceeded: retry after 3s" }
    ])
  })
})

describe("toCallToolResult", () => {
  it("falls back when a failure has no code or message", () => {
    expect(toCallToolResult({ ok: false }).content).toEqual([
      { type: "text", text: "error: request failed" }
    ])
  })
})
