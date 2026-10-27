import type { Authority, AuthorityPage } from "@qualithm/platform"

import { CliError } from "../envelope.ts"
import { dash, table } from "../table.ts"
import { createAuthority, listAuthorities, revokeAuthority } from "../tools/authorities.ts"
import {
  type Command,
  intOption,
  type ParsedArgs,
  readFileArg,
  requirePositional,
  stringOption
} from "./command.ts"

/** `qualithm authority …`: list, register and revoke device certificate authorities. */
export const authorityCommands: readonly Command[] = [
  {
    path: ["authority", "list"],
    aliases: ["ls"],
    tool: listAuthorities,
    options: { page: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values }) => ({
      page: intOption(values, "page"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string => {
      const page = data as AuthorityPage
      return table([
        ["ID", "NAME", "KIND", "STATUS", "FINGERPRINT"],
        ...page.items.map((a) => [a.id, dash(a.name), a.kind, a.status, dash(a.fingerprint)])
      ])
    }
  },
  {
    path: ["authority", "create"],
    aliases: ["new", "register"],
    tool: createAuthority,
    options: {
      name: { type: "string" },
      kind: { type: "string" },
      "cert-file": { type: "string" }
    },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const name = stringOption(values, "name")
      if (name === undefined) {
        throw new CliError("--name is required")
      }
      const kind = stringOption(values, "kind") ?? "platform"
      if (kind !== "byo") {
        return { name, kind }
      }
      const certFile = stringOption(values, "cert-file")
      if (certFile === undefined) {
        throw new CliError("--cert-file is required for byo authorities")
      }
      return { name, kind, certificatePem: readFileArg(certFile, "cert") }
    },
    human: (data: unknown): string => {
      const authority = data as Authority
      return `authority ${authority.id} (${authority.name}) registered\n`
    }
  },
  {
    path: ["authority", "revoke"],
    aliases: ["delete", "rm"],
    tool: revokeAuthority,
    options: {},
    toInput: ({ positionals }) => ({
      authorityId: requirePositional(positionals, 0, "authority id")
    }),
    human: (_data, input) => `authority ${String(input.authorityId)} revoked\n`
  }
]
