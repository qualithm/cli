import type { Device, DeviceCheck, DevicePage } from "@qualithm/platform"

import { CliError } from "../envelope.ts"
import { dash, table, when } from "../table.ts"
import {
  createDevice,
  deleteDevice,
  getDevice,
  listDevices,
  updateDevice
} from "../tools/devices.ts"
import type { Decision } from "../tools/receipt.ts"
import {
  type Command,
  intOption,
  type ParsedArgs,
  requirePositional,
  stringOption
} from "./command.ts"

/**
 * A receipt as plain lines: one per decision with its value and docs page, or nothing when there
 * is none.
 *
 * @param holder - the device as the API returns it, or a flash or deploy result
 * @param heading - what the decisions were made at
 * @returns the lines, led by a blank line and the heading
 */
export function decisionLines(
  holder: { decisions?: readonly Decision[] },
  heading = "Decided at claim"
): string {
  const decisions = holder.decisions ?? []
  if (decisions.length === 0) {
    return ""
  }
  return `\n${heading}\n${table(decisions.map((d) => [d.label, d.value, d.docsUrl]))}`
}

/** How each check is named, and the one thing that makes a failing one pass, as the app says it. */
export const DEVICE_CHECKS: Record<DeviceCheck["id"], { label: string; fix: string }> = {
  "credential-certificate": {
    label: "Certificate credential",
    fix: "Connect the device with a certificate, then revoke its tokens."
  },
  "key-protected": {
    label: "Protected key",
    fix: "Provision the device so its key is generated in protected hardware."
  },
  "firmware-signed": {
    label: "Signed firmware",
    fix: "Provision the device so it runs signed firmware."
  },
  "credential-current": {
    label: "Expiring credential",
    fix: "Revoke each credential that never expires."
  }
}

/**
 * @param level - the device's level as the API returns it
 * @returns the level as a person reads it, or a dash when the API sent none
 */
export function levelName(level: string | undefined): string {
  return level === undefined ? "-" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}

/**
 * The device's level and each check behind it: its name, whether it passes, the evidence, and the
 * fix for a failing one.
 *
 * @param device - the device as the API returns it
 * @returns the lines, led by a blank line and a heading, or nothing when the API sent no level
 */
export function levelLines(device: Pick<Device, "level" | "checks">): string {
  if (device.level === undefined) {
    return ""
  }
  const lines = (device.checks ?? []).map((check) => {
    const { label, fix } = DEVICE_CHECKS[check.id]
    const evidence = `${check.evidence.charAt(0).toUpperCase()}${check.evidence.slice(1)}.`
    return [label, check.pass ? "pass" : "fail", check.pass ? evidence : `${evidence} ${fix}`]
  })
  const hint =
    device.level === "production" ? "" : "A device reaches production when every check passes.\n"
  return `\nLevel: ${levelName(device.level)}\n${hint}${lines.length > 0 ? table(lines) : ""}`
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
    options: { scope: { type: "string" }, cursor: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => ({
      scopeId: stringOption(values, "scope"),
      cursor: stringOption(values, "cursor"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string =>
      table([
        ["ID", "NAME", "SCOPE", "LEVEL"],
        ...(data as DevicePage).items.map((d) => [
          d.id,
          dash(d.name),
          d.scopeId,
          levelName(d.level)
        ])
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
        ]) +
        levelLines(device) +
        decisionLines(device)
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
