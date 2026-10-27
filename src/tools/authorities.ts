import { AuthoritiesApi } from "@qualithm/platform"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import { defineTool, dryRunInput, pageInput } from "./tool.ts"

/** Lists the team's device certificate authorities. */
export const listAuthorities = defineTool({
  name: "list_authorities",
  description: "List device certificate authorities for the token's team.",
  mutating: false,
  input: pageInput,
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(AuthoritiesApi).listAuthorities({ teamId, ...input })
    return data
  }
})

/** Creates a certificate authority: one the platform generates, or one the builder brings. */
export const createAuthority = defineTool({
  name: "create_authority",
  description: "Create a device certificate authority (platform-generated or BYO).",
  mutating: true,
  input: {
    name: z.string().min(1).describe("human-readable authority name"),
    kind: z.enum(["platform", "byo"]).describe("authority kind: platform or byo"),
    certificatePem: z
      .string()
      .min(1)
      .optional()
      .describe("PEM certificate, required when kind is byo"),
    ...dryRunInput
  },
  run: async (session, input) => {
    if (input.kind === "byo" && input.certificatePem === undefined) {
      throw new CliError("certificatePem is required when kind is byo")
    }
    const teamId = await session.teamId()
    const { data } = await session.client.api(AuthoritiesApi).createAuthority({
      teamId,
      createAuthorityRequest: {
        name: input.name,
        kind: input.kind,
        ...(input.certificatePem === undefined ? {} : { certificatePem: input.certificatePem })
      }
    })
    return data
  }
})

/** Revokes one certificate authority. */
export const revokeAuthority = defineTool({
  name: "revoke_authority",
  description: "Revoke a device certificate authority by id.",
  mutating: true,
  input: {
    authorityId: z.string().min(1).describe("id of the authority to revoke"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client
      .api(AuthoritiesApi)
      .deleteAuthority({ teamId, authorityId: input.authorityId })
    return undefined
  }
})
