import { CapabilitiesApi, CommandsApi } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, dryRunInput, pageInput, type Tool } from "./tool.ts"

/** Lists command deliveries for a device. */
export const listDeviceCommands = defineTool({
  name: "list_device_commands",
  description: "List command deliveries for a device (pending, sent, failed).",
  mutating: false,
  operations: ["listDeviceCommands"],
  input: {
    deviceId: z.string().min(1).describe("id of the device to list commands for"),
    ...pageInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(CommandsApi).listDeviceCommands({ teamId, ...input })
    return data
  }
})

/** Queues a command for a device; a retried send with the same dedupKey commands it once. */
export const sendDeviceCommand = defineTool({
  name: "send_device_command",
  description: "Queue a command for a device, idempotently via dedupKey.",
  mutating: true,
  operations: ["createDeviceCommand"],
  input: {
    deviceId: z.string().min(1).describe("id of the device to command"),
    capability: z.string().min(1).describe("key of the declared capability to invoke"),
    value: z
      .unknown()
      .optional()
      .describe("command value; required for every commandable capability type except trigger"),
    dedupKey: z.string().min(1).describe("caller-owned idempotency key for the command"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const { deviceId, capability, value, dedupKey } = input
    const teamId = await session.teamId()
    const { data } = await session.client.api(CommandsApi).createDeviceCommand({
      teamId,
      deviceId,
      createDeviceCommandRequest: {
        capability,
        dedupKey,
        ...(value === undefined ? {} : { value })
      }
    })
    return data
  }
})

/** Lists the capabilities a device declared when it connected. */
export const getDeviceCapabilities = defineTool({
  name: "get_device_capabilities",
  description: "List the capabilities a device declared in its connect-time manifest.",
  mutating: false,
  operations: ["listDeviceCapabilities"],
  input: { deviceId: z.string().min(1).describe("id of the device to list capabilities for") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(CapabilitiesApi)
      .listDeviceCapabilities({ teamId, deviceId: input.deviceId })
    return data
  }
})

/** Device command tools: send commands and read capabilities. */
export const deviceCommandTools: readonly Tool[] = [
  listDeviceCommands,
  sendDeviceCommand,
  getDeviceCapabilities
]
