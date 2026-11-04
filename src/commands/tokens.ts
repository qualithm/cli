import type { ApiTokenPage } from "@qualithm/platform"

import { dash, table, when } from "../table.ts"
import { listApiTokens, revokeApiToken } from "../tools/tokens.ts"
import { type Command, intOption, requirePositional, stringOption } from "./command.ts"

/** `qualithm token …`: list and revoke member API tokens. */
export const tokenCommands: readonly Command[] = [
  {
    path: ["token", "list"],
    aliases: ["ls"],
    tool: listApiTokens,
    options: { cursor: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values }) => ({
      cursor: stringOption(values, "cursor"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string => {
      const page = data as ApiTokenPage
      return table([
        ["ID", "NAME", "ROLE", "STATUS", "EXPIRES", "LAST-USED"],
        ...page.items.map((t) => [
          t.id,
          dash(t.name),
          t.role ?? "your role",
          t.status,
          when(t.expiresAt),
          when(t.lastUsedAt)
        ])
      ])
    }
  },
  {
    path: ["token", "revoke"],
    aliases: ["delete", "rm"],
    tool: revokeApiToken,
    options: {},
    toInput: ({ positionals }) => ({ tokenId: requirePositional(positionals, 0, "token id") }),
    human: (_data, input) => `api token ${String(input.tokenId)} revoked\n`
  },
  {
    path: ["token", "create"],
    aliases: ["new"],
    refuse: "create API tokens in the app, on your team page"
  }
]
