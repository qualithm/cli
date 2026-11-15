import { EnrollmentsApi } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, dryRunInput, pageInput } from "./tool.ts"

/** Lists the team's one-time enrollment claim codes. */
export const listEnrollments = defineTool({
  name: "list_enrollments",
  description: "List one-time device enrollment claim codes for the token's team.",
  mutating: false,
  operations: ["listEnrollments"],
  input: pageInput,
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(EnrollmentsApi).listEnrollments({ teamId, ...input })
    return data
  }
})

/** Creates a one-time claim code a device uses to enroll into a scope. */
export const createEnrollment = defineTool({
  name: "create_enrollment",
  description:
    "Create a one-time device enrollment claim code. The plaintext code is returned once.",
  mutating: true,
  operations: ["createEnrollment"],
  input: {
    scopeId: z.string().min(1).describe("id of the scope the device will enroll into"),
    label: z.string().optional().describe("human-readable label for the enrollment"),
    expiresInMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("lifetime in minutes; the server default is 1440"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(EnrollmentsApi).createEnrollment({
      teamId,
      createEnrollmentRequest: {
        scopeId: input.scopeId,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.expiresInMinutes === undefined
          ? {}
          : { expiresInMinutes: input.expiresInMinutes })
      }
    })
    return data
  }
})

/** Revokes one enrollment claim code. */
export const revokeEnrollment = defineTool({
  name: "revoke_enrollment",
  description: "Revoke a device enrollment claim code by id.",
  mutating: true,
  operations: ["deleteEnrollment"],
  input: {
    enrollmentId: z.string().min(1).describe("id of the enrollment to revoke"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client
      .api(EnrollmentsApi)
      .deleteEnrollment({ teamId, enrollmentId: input.enrollmentId })
    return undefined
  }
})
