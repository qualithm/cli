import type { Device, DevicePage } from "@qualithm/platform"

import { CliError } from "../envelope.ts"
import { dash, table, when } from "../table.ts"
import {
  createDevice,
  deleteDevice,
  getDevice,
  listDevices,
  updateDevice
} from "../tools/devices.ts"
import {
  type Command,
  intOption,
  type ParsedArgs,
  requirePositional,
  stringOption
} from "./command.ts"

function parkedOption(values: ParsedArgs["values"]): boolean | undefined {
  if (values.park === true && values.unpark === true) {
    throw new CliError("--park and --unpark can't be used together")
  }
  return values.park === true ? true : values.unpark === true ? false : undefined
}

/** `qualithm device …`: list, inspect, create, update and delete devices. */
export const deviceCommands: readonly Command[] = [
  {
    path: ["device", "list"],
    aliases: ["ls"],
    tool: listDevices,
    options: { space: { type: "string" }, page: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => ({
      spaceId: stringOption(values, "space"),
      page: intOption(values, "page"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string =>
      table([
        ["ID", "NAME", "SPACE", "SPACE-NAME"],
        ...(data as DevicePage).items.map((d) => [d.id, dash(d.name), d.spaceId, dash(d.spaceName)])
      ])
  },
  {
    path: ["device", "get"],
    aliases: ["show"],
    tool: getDevice,
    options: {},
    toInput: ({ positionals }: ParsedArgs): Record<string, unknown> => ({
      deviceId: requirePositional(positionals, 0, "device id")
    }),
    human: (data: unknown): string => {
      const device = data as Device
      return table([
        ["id", device.id],
        ["name", dash(device.name)],
        ["space", device.spaceId],
        ["spaceName", dash(device.spaceName)],
        ["parkedAt", when(device.parkedAt)],
        ["createdAt", when(device.createdAt)]
      ])
    }
  },
  {
    path: ["device", "create"],
    aliases: ["new"],
    tool: createDevice,
    options: { space: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const spaceId = stringOption(values, "space")
      if (spaceId === undefined) {
        throw new CliError("--space is required")
      }
      return { spaceId }
    },
    human: (data: unknown): string => {
      const device = data as Device
      return `device ${device.id} (${device.name}) created in space ${device.spaceId}\n`
    }
  },
  {
    path: ["device", "update"],
    aliases: ["patch"],
    tool: updateDevice,
    options: {
      name: { type: "string" },
      space: { type: "string" },
      park: { type: "boolean" },
      unpark: { type: "boolean" }
    },
    toInput: ({ values, positionals }: ParsedArgs): Record<string, unknown> => {
      const deviceId = requirePositional(positionals, 0, "device id")
      const input = {
        deviceId,
        name: stringOption(values, "name"),
        spaceId: stringOption(values, "space"),
        parked: parkedOption(values)
      }
      if (input.name === undefined && input.spaceId === undefined && input.parked === undefined) {
        throw new CliError("set --name, --space, --park or --unpark")
      }
      return input
    },
    human: (_data, input) => `device ${String(input.deviceId)} updated\n`
  },
  {
    path: ["device", "delete"],
    aliases: ["rm"],
    tool: deleteDevice,
    options: {},
    toInput: ({ positionals }: ParsedArgs): Record<string, unknown> => ({
      deviceId: requirePositional(positionals, 0, "device id")
    }),
    human: (_data, input) => `device ${String(input.deviceId)} deleted\n`
  }
]
