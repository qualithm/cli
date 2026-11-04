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

/** One choice Qualithm made on the builder's behalf, as the platform returns it. */
type Decision = { key: string; label: string; value: string; source: string; docsUrl: string }

/**
 * The receipt the platform kept from the device's claim, as plain lines: one per decision with
 * its value and docs page, or nothing when the device has none.
 *
 * @param device - the device as the API returns it
 * @returns the lines, led by a blank line and a heading
 */
export function decisionLines(device: { decisions?: readonly Decision[] }): string {
  const decisions = device.decisions ?? []
  if (decisions.length === 0) {
    return ""
  }
  return `\nDecided at claim\n${table(decisions.map((d) => [d.label, d.value, d.docsUrl]))}`
}

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
    options: { scope: { type: "string" }, page: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => ({
      scopeId: stringOption(values, "scope"),
      page: intOption(values, "page"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string =>
      table([
        ["ID", "NAME", "SCOPE"],
        ...(data as DevicePage).items.map((d) => [d.id, dash(d.name), d.scopeId])
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
      const device = data as Device & { decisions?: Decision[] }
      return (
        table([
          ["id", device.id],
          ["name", dash(device.name)],
          ["scope", device.scopeId],
          ["parkedAt", when(device.parkedAt)],
          ["createdAt", when(device.createdAt)]
        ]) + decisionLines(device)
      )
    }
  },
  {
    path: ["device", "create"],
    aliases: ["new"],
    tool: createDevice,
    options: { scope: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const scopeId = stringOption(values, "scope")
      if (scopeId === undefined) {
        throw new CliError("--scope is required")
      }
      return { scopeId }
    },
    human: (data: unknown): string => {
      const device = data as Device
      return `device ${device.id} (${device.name}) created in scope ${device.scopeId}\n`
    }
  },
  {
    path: ["device", "update"],
    aliases: ["patch"],
    tool: updateDevice,
    options: {
      name: { type: "string" },
      scope: { type: "string" },
      park: { type: "boolean" },
      unpark: { type: "boolean" }
    },
    toInput: ({ values, positionals }: ParsedArgs): Record<string, unknown> => {
      const deviceId = requirePositional(positionals, 0, "device id")
      const input = {
        deviceId,
        name: stringOption(values, "name"),
        scopeId: stringOption(values, "scope"),
        parked: parkedOption(values)
      }
      if (input.name === undefined && input.scopeId === undefined && input.parked === undefined) {
        throw new CliError("set --name, --scope, --park or --unpark")
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
