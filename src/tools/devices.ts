import { DevicesApi } from "@qualithm/platform"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import { defineTool, dryRunInput, pageInput } from "./tool.ts"

/** Lists the team's devices, optionally only one space's. */
export const listDevices = defineTool({
  name: "list_devices",
  description: "List the team's devices, optionally only those in one space.",
  mutating: false,
  input: {
    spaceId: z.string().min(1).optional().describe("only the devices in this space"),
    ...pageInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(DevicesApi).listDevices({ teamId, ...input })
    return data
  }
})

/** Fetches one device. */
export const getDevice = defineTool({
  name: "get_device",
  description: "Fetch a single device by id.",
  mutating: false,
  input: { deviceId: z.string().min(1).describe("id of the device to fetch") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(DevicesApi)
      .getDevice({ teamId, deviceId: input.deviceId })
    return data
  }
})

/** Creates a device in a space. */
export const createDevice = defineTool({
  name: "create_device",
  description: "Create a device in a space.",
  mutating: true,
  input: {
    spaceId: z.string().min(1).describe("id of the space to create the device in"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(DevicesApi)
      .createDevice({ teamId, createDeviceRequest: { spaceId: input.spaceId } })
    return data
  }
})

/** Renames a device, moves it to another space, or parks or unparks it. */
export const updateDevice = defineTool({
  name: "update_device",
  description: "Update a device's name or space, or park or unpark it.",
  mutating: true,
  input: {
    deviceId: z.string().min(1).describe("id of the device to update"),
    name: z.string().min(1).optional().describe("new device name"),
    spaceId: z.string().min(1).optional().describe("new space id to move the device into"),
    parked: z
      .boolean()
      .optional()
      .describe(
        "true to park the device: it stops connecting and counting against the active-device limit, while its credentials and history survive; false to return it to active"
      ),
    ...dryRunInput
  },
  run: async (session, input) => {
    const { deviceId, name, spaceId, parked } = input
    if (name === undefined && spaceId === undefined && parked === undefined) {
      throw new CliError("set name, spaceId or parked")
    }
    const teamId = await session.teamId()
    await session.client.api(DevicesApi).updateDevice({
      teamId,
      deviceId,
      updateDeviceRequest: {
        ...(name === undefined ? {} : { name }),
        ...(spaceId === undefined ? {} : { spaceId }),
        ...(parked === undefined ? {} : { parked })
      }
    })
    return undefined
  }
})

/** Deletes a device. */
export const deleteDevice = defineTool({
  name: "delete_device",
  description: "Delete a device by id.",
  mutating: true,
  input: { deviceId: z.string().min(1).describe("id of the device to delete"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client.api(DevicesApi).deleteDevice({ teamId, deviceId: input.deviceId })
    return undefined
  }
})
