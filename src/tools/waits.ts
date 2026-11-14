import { DevicesApi, type DeviceState, type Enrollment, EnrollmentsApi } from "@qualithm/platform"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import type { Session } from "../platform.ts"
import { defineTool } from "./tool.ts"

const LIST_LIMIT = 100

/** How often a wait asks the platform again, and how it pauses; tests replace both. */
export const waitPacing = {
  intervalMs: 2000,
  sleep: async (ms: number): Promise<void> => {
    await new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}

const timeoutInput = {
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .optional()
    .describe("how long to wait before failing with code timeout; default 300")
}

/**
 * Asks `check` until it returns a value or the time runs out.
 *
 * @param timeoutSeconds - how long to keep asking
 * @param timedOut - the time-out message: what didn't happen, then what to do
 * @param check - one look; `undefined` means not yet
 * @returns what `check` returned
 * @throws CliError with code `timeout` once the time runs out
 */
async function until<T>(
  timeoutSeconds: number,
  timedOut: string,
  check: () => Promise<T | undefined>
): Promise<T> {
  const deadline = Date.now() + timeoutSeconds * 1000
  for (;;) {
    const found = await check()
    if (found !== undefined) {
      return found
    }
    const left = deadline - Date.now()
    if (left <= 0) {
      throw new CliError(timedOut, "timeout")
    }
    await waitPacing.sleep(Math.min(waitPacing.intervalMs, left))
  }
}

async function deviceState(session: Session, deviceId: string): Promise<DeviceState | undefined> {
  const teamId = await session.teamId()
  const devices = session.client.api(DevicesApi)
  let cursor: string | undefined
  do {
    const { data } = await devices.listTeamDeviceStates({
      teamId,
      limit: LIST_LIMIT,
      ...(cursor === undefined ? {} : { cursor })
    })
    const state = data.items.find((s) => s.deviceId === deviceId)
    if (state !== undefined) {
      return state
    }
    cursor = data.nextCursor ?? undefined
  } while (cursor !== undefined)
  return undefined
}

async function enrollment(session: Session, enrollmentId: string): Promise<Enrollment> {
  const teamId = await session.teamId()
  const enrollments = session.client.api(EnrollmentsApi)
  let cursor: string | undefined
  do {
    const { data } = await enrollments.listEnrollments({
      teamId,
      limit: LIST_LIMIT,
      ...(cursor === undefined ? {} : { cursor })
    })
    const found = data.items.find((e) => e.id === enrollmentId)
    if (found !== undefined) {
      return found
    }
    cursor = data.nextCursor ?? undefined
  } while (cursor !== undefined)
  throw new CliError(`enrollment ${enrollmentId} not found`, "not_found")
}

/** Waits until a device is online, then returns its state. */
export const waitForDevice = defineTool({
  name: "wait_for_device",
  description:
    "Wait until a device is online and return its state. Fails with code timeout if it is not online in time.",
  mutating: false,
  input: {
    deviceId: z.string().min(1).describe("id of the device to wait for"),
    ...timeoutInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    // A wrong id fails now with not_found rather than at the time-out.
    await session.client.api(DevicesApi).getDevice({ teamId, deviceId: input.deviceId })
    return until(
      input.timeoutSeconds ?? 300,
      `device ${input.deviceId} not online: check it is powered and has its credentials, then wait again`,
      async () => {
        const state = await deviceState(session, input.deviceId)
        return state?.online === true ? state : undefined
      }
    )
  }
})

/** Waits until a device uses an enrollment's claim code, then returns the enrollment and device. */
export const waitForEnrollment = defineTool({
  name: "wait_for_enrollment",
  description:
    "Wait until a device uses an enrollment's claim code and return the enrollment and the device. Fails with code timeout if no device uses it in time, and code conflict if the code is revoked or expires.",
  mutating: false,
  input: {
    enrollmentId: z.string().min(1).describe("id of the enrollment whose claim code to wait on"),
    ...timeoutInput
  },
  run: async (session, input) => {
    const claimed = await until(
      input.timeoutSeconds ?? 300,
      `no device used the claim code of enrollment ${input.enrollmentId}: check the device is powered and has the code, then wait again`,
      async () => {
        const found = await enrollment(session, input.enrollmentId)
        if (found.status === "revoked") {
          throw new CliError("claim code revoked: create an enrollment for a new code", "conflict")
        }
        if (found.status === "pending" && found.expiresAt.getTime() <= Date.now()) {
          throw new CliError("claim code expired: create an enrollment for a new code", "conflict")
        }
        return found.status === "claimed" && found.claimedDeviceId !== null ? found : undefined
      }
    )
    const teamId = await session.teamId()
    const { data: device } = await session.client
      .api(DevicesApi)
      .getDevice({ teamId, deviceId: claimed.claimedDeviceId ?? "" })
    return { enrollment: claimed, device }
  }
})

/** The wait tools, in the order `qualithm mcp` lists them. */
export const waitTools = [waitForEnrollment, waitForDevice]
