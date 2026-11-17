import type { AutomationRun } from "@qualithm/platform"

import { table, when } from "../table.ts"
import { listAutomationRuns } from "../tools/automations.ts"
import type { Decision } from "../tools/receipt.ts"
import {
  type Command,
  intOption,
  type ParsedArgs,
  requirePositional,
  stringOption
} from "./command.ts"
import { decisionLines } from "./devices.ts"

type RunWithDecisions = AutomationRun & { decisions?: Decision[] }

/** `qualithm automation …`: an automation's run history. */
export const automationCommands: readonly Command[] = [
  {
    path: ["automation", "runs"],
    tool: listAutomationRuns,
    options: { cursor: { type: "string" }, limit: { type: "string" } },
    toInput: ({ values, positionals }: ParsedArgs): Record<string, unknown> => ({
      automationId: requirePositional(positionals, 0, "automation id"),
      cursor: stringOption(values, "cursor"),
      limit: intOption(values, "limit")
    }),
    human: (data: unknown): string => {
      const runs = (data as { items: RunWithDecisions[] }).items
      return (
        table([
          ["ID", "OUTCOME", "TRIGGER", "TRIGGERED"],
          ...runs.map((run) => [run.id, run.status, run.triggerType, when(run.triggeredAt)])
        ]) + runs.map((run) => decisionLines(run, `Decided for run ${run.id}`)).join("")
      )
    }
  }
]
