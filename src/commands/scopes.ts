import type { Scope, ScopePage } from "@qualithm/platform"

import { CliError } from "../envelope.ts"
import { dash, table, when } from "../table.ts"
import { createScope, deleteScope, getScope, listScopes, updateScope } from "../tools/scopes.ts"
import {
  type Command,
  intOption,
  type ParsedArgs,
  requirePositional,
  stringOption
} from "./command.ts"

/** `qualithm scope …`: list, inspect, create, rename and delete scopes. */
export const scopeCommands: readonly Command[] = [
  {
    path: ["scope", "list"],
    aliases: ["ls"],
    tool: listScopes,
    options: {
      zone: { type: "string" },
      parent: { type: "string" },
      page: { type: "string" },
      limit: { type: "string" }
    },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => ({
      zone: stringOption(values, "zone"),
      parentId: stringOption(values, "parent"),
      page: intOption(values, "page"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string =>
      table([
        ["ID", "NAME", "ZONE", "PARENT", "DEVICES"],
        ...(data as ScopePage).items.map((s) => [
          s.id,
          s.name,
          s.zone,
          dash(s.parentId),
          String(s.deviceTotal ?? 0)
        ])
      ])
  },
  {
    path: ["scope", "get"],
    aliases: ["show"],
    tool: getScope,
    options: {},
    toInput: ({ positionals }: ParsedArgs): Record<string, unknown> => ({
      scopeId: requirePositional(positionals, 0, "scope id")
    }),
    human: (data: unknown): string => {
      const scope = data as Scope
      return table([
        ["id", scope.id],
        ["name", scope.name],
        ["zone", scope.zone],
        ["parentId", dash(scope.parentId)],
        ["deviceTotal", String(scope.deviceTotal ?? 0)],
        ["createdAt", when(scope.createdAt)]
      ])
    }
  },
  {
    path: ["scope", "create"],
    aliases: ["new"],
    tool: createScope,
    options: { name: { type: "string" }, zone: { type: "string" }, parent: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const name = stringOption(values, "name")
      if (name === undefined) {
        throw new CliError("--name is required")
      }
      const zone = stringOption(values, "zone")
      const parentId = stringOption(values, "parent")
      if ((zone === undefined) === (parentId === undefined)) {
        throw new CliError("set --zone for a top-level scope or --parent for a child scope")
      }
      return { name, zone, parentId }
    },
    human: (data: unknown): string => {
      const scope = data as Scope
      return `scope ${scope.id} (${scope.name}) created in zone ${scope.zone}\n`
    }
  },
  {
    path: ["scope", "update"],
    aliases: ["patch"],
    tool: updateScope,
    options: { name: { type: "string" } },
    toInput: ({ values, positionals }: ParsedArgs): Record<string, unknown> => {
      const scopeId = requirePositional(positionals, 0, "scope id")
      const name = stringOption(values, "name")
      if (name === undefined) {
        throw new CliError("--name is required")
      }
      return { scopeId, name }
    },
    human: (_data, input) => `scope ${String(input.scopeId)} renamed to ${String(input.name)}\n`
  },
  {
    path: ["scope", "delete"],
    aliases: ["rm"],
    tool: deleteScope,
    options: {},
    toInput: ({ positionals }: ParsedArgs): Record<string, unknown> => ({
      scopeId: requirePositional(positionals, 0, "scope id")
    }),
    human: (_data, input) => `scope ${String(input.scopeId)} deleted\n`
  }
]
