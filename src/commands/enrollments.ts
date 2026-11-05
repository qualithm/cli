import type { EnrollmentCode, EnrollmentPage } from "@qualithm/platform"

import { CliError } from "../envelope.ts"
import { dash, table, when } from "../table.ts"
import { createEnrollment, listEnrollments, revokeEnrollment } from "../tools/enrollments.ts"
import {
  type Command,
  intOption,
  type ParsedArgs,
  requirePositional,
  stringOption
} from "./command.ts"

/** `qualithm enrollment …`: list, create and revoke one-time device claim codes. */
export const enrollmentCommands: readonly Command[] = [
  {
    path: ["enrollment", "list"],
    aliases: ["ls"],
    tool: listEnrollments,
    options: { cursor: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values }) => ({
      cursor: stringOption(values, "cursor"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string => {
      const page = data as EnrollmentPage
      return table([
        ["ID", "SCOPE", "LABEL", "STATUS", "EXPIRES"],
        ...page.items.map((e) => [e.id, e.scopeId, dash(e.label), e.status, when(e.expiresAt)])
      ])
    }
  },
  {
    path: ["enrollment", "create"],
    aliases: ["new"],
    tool: createEnrollment,
    options: {
      scope: { type: "string" },
      label: { type: "string" },
      "expires-minutes": { type: "string" }
    },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const scopeId = stringOption(values, "scope")
      if (scopeId === undefined) {
        throw new CliError("--scope is required")
      }
      return {
        scopeId,
        label: stringOption(values, "label"),
        expiresInMinutes: intOption(values, "expires-minutes")
      }
    },
    human: (data: unknown): string => {
      const { enrollment, code } = data as EnrollmentCode
      return (
        `enrollment ${enrollment.id} created for scope ${enrollment.scopeId}\n` +
        `claim code (shown once): ${code}\n`
      )
    }
  },
  {
    path: ["enrollment", "revoke"],
    aliases: ["delete", "rm"],
    tool: revokeEnrollment,
    options: {},
    toInput: ({ positionals }) => ({
      enrollmentId: requirePositional(positionals, 0, "enrollment id")
    }),
    human: (_data, input) => `enrollment ${String(input.enrollmentId)} revoked\n`
  }
]
