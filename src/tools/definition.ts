import {
  AutomationPayloadChainInnerToJSON,
  type CreateAutomationRequestPayload,
  CreateAutomationRequestPayloadToJSON,
  type DashboardWidget,
  DashboardWidgetToJSON
} from "@qualithm/platform"

import { CliError } from "../envelope.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${String(key)}`
}

/**
 * Finds the first field of `input` that the SDK's serialiser left out of `sent`.
 *
 * @param input - the definition as given
 * @param sent - the same definition after the SDK serialised it
 * @param path - the dotted path of `input` within the tool input
 * @returns the dotted path of the dropped field, or undefined when nothing was dropped
 */
export function droppedField(input: unknown, sent: unknown, path: string): string | undefined {
  if (Array.isArray(input)) {
    if (!Array.isArray(sent)) {
      return path
    }
    for (const [index, item] of input.entries()) {
      const dropped = droppedField(item, sent[index], join(path, index))
      if (dropped !== undefined) {
        return dropped
      }
    }
    return undefined
  }
  if (isRecord(input)) {
    if (!isRecord(sent)) {
      return path
    }
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) {
        continue
      }
      if (sent[key] === undefined) {
        return join(path, key)
      }
      const dropped = droppedField(value, sent[key], join(path, key))
      if (dropped !== undefined) {
        return dropped
      }
    }
  }
  return undefined
}

function refuseDropped(input: unknown, sent: unknown, path: string): void {
  const dropped = droppedField(input, sent, path)
  if (dropped !== undefined) {
    throw new CliError(`${dropped}: unknown field`)
  }
}

/**
 * Checks an automation's trigger and chain against the SDK's models before anything is sent.
 *
 * @param payload - the trigger and chain document as given
 * @returns the payload, typed for the SDK
 * @throws {CliError} `usage` when a chain step matches no step type or a field would be dropped
 */
export function automationPayload(payload: {
  trigger: Record<string, unknown>
  chain: Record<string, unknown>[]
}): CreateAutomationRequestPayload {
  for (const [index, step] of payload.chain.entries()) {
    if (Object.keys(AutomationPayloadChainInnerToJSON(step) as object).length === 0) {
      throw new CliError(`payload.chain.${String(index)}: unknown step type`)
    }
  }
  refuseDropped(payload, CreateAutomationRequestPayloadToJSON(payload), "payload")
  return payload as unknown as CreateAutomationRequestPayload
}

/**
 * Checks a dashboard's widgets against the SDK's models before anything is sent.
 *
 * @param widgets - the widget array as given
 * @returns the widgets, typed for the SDK
 * @throws {CliError} `usage` when a widget field would be dropped
 */
export function dashboardWidgets(widgets: Record<string, unknown>[]): DashboardWidget[] {
  for (const [index, widget] of widgets.entries()) {
    refuseDropped(widget, DashboardWidgetToJSON(widget), `payload.${String(index)}`)
  }
  return widgets as unknown as DashboardWidget[]
}
