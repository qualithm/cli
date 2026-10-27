import { DevicesApi } from "@qualithm/platform"
import { z } from "zod"

import { failure } from "../envelope.ts"
import type { Session } from "../platform.ts"
import { defineTool, dryRunInput } from "./tool.ts"

/** One reconcile decision for one declared device. */
export type ApplyResult = {
  space: string
  device: string
  action: "create" | "exists" | "would-create"
  /** The new device's id, on `create`. */
  id?: string
}

/** A space's devices are listed this many at a time. */
const LIST_LIMIT = 100

async function deviceNames(
  session: Session,
  teamId: string,
  spaceId: string
): Promise<Set<string>> {
  const devices = session.client.api(DevicesApi)
  const names = new Set<string>()
  for (let page = 1; ; page++) {
    const { data } = await devices.listDevices({ teamId, spaceId, page, limit: LIST_LIMIT })
    for (const device of data.items) {
      names.add(device.name)
    }
    if (data.last === 0 || page >= data.last) {
      return names
    }
  }
}

/**
 * Reconciles a device-as-code manifest. Idempotent: a device whose name already exists in its
 * space is reported as `exists` and left alone; a missing one is created and named. On a dry run
 * each missing device is reported as `would-create` and nothing is sent.
 */
export const applyManifest = defineTool({
  name: "apply_manifest",
  description:
    "Reconcile a device-as-code manifest: create each declared device missing from its space, matched by name.",
  mutating: true,
  input: {
    spaces: z
      .array(
        z.object({
          id: z.string().min(1).describe("id of the space"),
          devices: z
            .array(z.object({ name: z.string().min(1).describe("the device's name") }))
            .describe("the devices the space should hold")
        })
      )
      .min(1)
      .describe("the spaces to reconcile"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const devices = session.client.api(DevicesApi)
    const results: ApplyResult[] = []
    for (const space of input.spaces) {
      const existing = await deviceNames(session, teamId, space.id)
      for (const { name } of space.devices) {
        if (existing.has(name)) {
          results.push({ space: space.id, device: name, action: "exists" })
          continue
        }
        let id: string
        try {
          ;({
            data: { id }
          } = await devices.createDevice({ teamId, createDeviceRequest: { spaceId: space.id } }))
        } catch (error) {
          if (failure(error).dryRun !== true) {
            throw error
          }
          results.push({ space: space.id, device: name, action: "would-create" })
          continue
        }
        // Name the new device after the manifest so the next reconcile is a no-op.
        await devices.updateDevice({ teamId, deviceId: id, updateDeviceRequest: { name } })
        results.push({ space: space.id, device: name, action: "create", id })
      }
    }
    return results
  }
})
