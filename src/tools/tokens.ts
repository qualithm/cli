import { ApiTokensApi } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, dryRunInput, pageInput } from "./tool.ts"

/** Lists the team's member API tokens: metadata only, never secrets. */
export const listApiTokens = defineTool({
  name: "list_api_tokens",
  description:
    "List member API tokens for the token's team (metadata only; secrets are never listed).",
  mutating: false,
  input: pageInput,
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(ApiTokensApi).listApiTokens({ teamId, ...input })
    return data
  }
})

/** Revokes one member API token. */
export const revokeApiToken = defineTool({
  name: "revoke_api_token",
  description: "Revoke a member API token by id.",
  mutating: true,
  input: { tokenId: z.string().min(1).describe("id of the API token to revoke"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client.api(ApiTokensApi).deleteApiToken({ teamId, tokenId: input.tokenId })
    return undefined
  }
})
