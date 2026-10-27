import type { Space, SpacePage } from "@qualithm/platform"

import { CliError } from "../envelope.ts"
import { table, when } from "../table.ts"
import { createSpace, deleteSpace, getSpace, listSpaces, updateSpace } from "../tools/spaces.ts"
import {
  type Command,
  intOption,
  type ParsedArgs,
  requirePositional,
  stringOption
} from "./command.ts"

/** `qualithm space …`: list, inspect, create, rename and delete spaces. */
export const spaceCommands: readonly Command[] = [
  {
    path: ["space", "list"],
    aliases: ["ls"],
    tool: listSpaces,
    options: { zone: { type: "string" }, page: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => ({
      zone: stringOption(values, "zone"),
      page: intOption(values, "page"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string =>
      table([
        ["ID", "NAME", "ZONE", "DEVICES"],
        ...(data as SpacePage).items.map((s) => [s.id, s.name, s.zone, String(s.deviceTotal ?? 0)])
      ])
  },
  {
    path: ["space", "get"],
    aliases: ["show"],
    tool: getSpace,
    options: {},
    toInput: ({ positionals }: ParsedArgs): Record<string, unknown> => ({
      spaceId: requirePositional(positionals, 0, "space id")
    }),
    human: (data: unknown): string => {
      const space = data as Space
      return table([
        ["id", space.id],
        ["name", space.name],
        ["zone", space.zone],
        ["deviceTotal", String(space.deviceTotal ?? 0)],
        ["createdAt", when(space.createdAt)]
      ])
    }
  },
  {
    path: ["space", "create"],
    aliases: ["new"],
    tool: createSpace,
    options: { zone: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const zone = stringOption(values, "zone")
      if (zone === undefined) {
        throw new CliError("--zone is required")
      }
      return { zone }
    },
    human: (data: unknown): string => {
      const space = data as Space
      return `space ${space.id} (${space.name}) created in zone ${space.zone}\n`
    }
  },
  {
    path: ["space", "update"],
    aliases: ["patch"],
    tool: updateSpace,
    options: { name: { type: "string" } },
    toInput: ({ values, positionals }: ParsedArgs): Record<string, unknown> => {
      const spaceId = requirePositional(positionals, 0, "space id")
      const name = stringOption(values, "name")
      if (name === undefined) {
        throw new CliError("--name is required")
      }
      return { spaceId, name }
    },
    human: (_data, input) => `space ${String(input.spaceId)} renamed to ${String(input.name)}\n`
  },
  {
    path: ["space", "delete"],
    aliases: ["rm"],
    tool: deleteSpace,
    options: {},
    toInput: ({ positionals }: ParsedArgs): Record<string, unknown> => ({
      spaceId: requirePositional(positionals, 0, "space id")
    }),
    human: (_data, input) => `space ${String(input.spaceId)} deleted\n`
  }
]
