import { AutomationsApi } from "@qualithm/platform"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import { automationPayload } from "./definition.ts"
import { defineTool, dryRunInput, pageInput, type Tool } from "./tool.ts"

const automationId = (what: string): z.ZodString =>
  z.string().min(1).describe(`id of the automation ${what}`)

const scopeId = (description: string): z.ZodOptional<z.ZodString> =>
  z.string().min(1).optional().describe(description)

// The SDK's models check the trigger and chain's fields; the platform validates their values.
const payload = (
  description: string
): z.ZodOptional<
  z.ZodObject<{
    trigger: z.ZodRecord<z.ZodString, z.ZodUnknown>
    chain: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>
  }>
> =>
  z
    .looseObject({
      trigger: z.record(z.string(), z.unknown()),
      chain: z.array(z.record(z.string(), z.unknown()))
    })
    .optional()
    .describe(description)

const params = (description: string): z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>> =>
  z.record(z.string(), z.unknown()).optional().describe(description)

/**
 * Refuses a payload and a template together: the template expands into the chain server-side.
 *
 * @param input - the tool input
 * @param input.payload - the trigger and chain document, if given
 * @param input.template - the template id, if given
 * @throws {CliError} when both are given
 */
function exclusive(input: { payload?: unknown; template?: string }): void {
  if (input.payload !== undefined && input.template !== undefined) {
    throw new CliError("payload and template are mutually exclusive")
  }
}

/** Lists the team's automations. */
export const listAutomations = defineTool({
  name: "list_automations",
  description: "List automations for the token's team.",
  mutating: false,
  input: { ...pageInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(AutomationsApi).listAutomations({
      teamId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    })
    return data
  }
})

/** Creates an automation from a full payload or from a catalogue template. */
export const createAutomation = defineTool({
  name: "create_automation",
  description:
    "Create an automation from a full trigger+chain payload, or from a catalogue template with slot values.",
  mutating: true,
  input: {
    name: z.string().min(1).describe("automation name"),
    scopeId: scopeId("id of the scope to bind the automation to; omit for team-wide"),
    payload: payload(
      "automation document: trigger plus ordered condition/action chain; exclusive with template"
    ),
    template: z
      .string()
      .min(1)
      .optional()
      .describe("id of the catalogue template to expand; exclusive with payload"),
    params: params("template slot values, used with template"),
    ...dryRunInput
  },
  run: async (session, input) => {
    exclusive(input)
    if (input.payload === undefined && input.template === undefined) {
      throw new CliError("one of payload or template is required")
    }
    const payload = input.payload === undefined ? undefined : automationPayload(input.payload)
    const teamId = await session.teamId()
    const { data } = await session.client.api(AutomationsApi).createAutomation({
      teamId,
      createAutomationRequest: {
        name: input.name,
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
        ...(payload === undefined ? {} : { payload }),
        ...(input.template === undefined ? {} : { template: input.template }),
        ...(input.params === undefined ? {} : { params: input.params })
      }
    })
    return data
  }
})

/** Fetches one automation with its chain. */
export const getAutomation = defineTool({
  name: "get_automation",
  description: "Fetch a single automation by id, including its chain.",
  mutating: false,
  input: { automationId: automationId("to fetch") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(AutomationsApi)
      .getAutomation({ teamId, automationId: input.automationId })
    return data
  }
})

/** Updates an automation; unset fields stay unchanged. */
export const updateAutomation = defineTool({
  name: "update_automation",
  description:
    "Update an automation's name, scope, chain or template params, or enable or disable it.",
  mutating: true,
  input: {
    automationId: automationId("to update"),
    name: z.string().min(1).optional().describe("new automation name"),
    enabled: z
      .boolean()
      .optional()
      .describe("true so its trigger fires, false to pause it without deleting it"),
    scopeId: scopeId("new scope id to bind the automation to"),
    payload: payload("new trigger+chain document"),
    template: z.string().min(1).optional().describe("template id to re-expand the chain from"),
    params: params("template slot values, required with template"),
    ...dryRunInput
  },
  run: async (session, input) => {
    exclusive(input)
    const payload = input.payload === undefined ? undefined : automationPayload(input.payload)
    const teamId = await session.teamId()
    const { data } = await session.client.api(AutomationsApi).updateAutomation({
      teamId,
      automationId: input.automationId,
      updateAutomationRequest: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
        ...(payload === undefined ? {} : { payload }),
        ...(input.template === undefined ? {} : { template: input.template }),
        ...(input.params === undefined ? {} : { params: input.params })
      }
    })
    return data
  }
})

/** Deletes one automation. */
export const deleteAutomation = defineTool({
  name: "delete_automation",
  description: "Delete an automation by id.",
  mutating: true,
  input: { automationId: automationId("to delete"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client
      .api(AutomationsApi)
      .deleteAutomation({ teamId, automationId: input.automationId })
    return undefined
  }
})

/** Queues a manual run of an automation. */
export const runAutomation = defineTool({
  name: "run_automation",
  description: "Queue a manual run of an automation.",
  mutating: true,
  input: { automationId: automationId("to run"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(AutomationsApi)
      .createAutomationRun({ teamId, automationId: input.automationId })
    return data
  }
})

/** Lists an automation's execution summaries. */
export const listAutomationRuns = defineTool({
  name: "list_automation_runs",
  description: "List execution summaries for an automation.",
  mutating: false,
  input: { automationId: automationId("to list runs for"), ...pageInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(AutomationsApi).listAutomationRuns({
      teamId,
      automationId: input.automationId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    })
    return data
  }
})

/** Lists the template catalogue a device's declared capabilities allow. */
export const listAutomationTemplates = defineTool({
  name: "list_automation_templates",
  description:
    "List the automation template catalogue filtered to what a device declared it can do.",
  mutating: false,
  input: {
    deviceId: z
      .string()
      .min(1)
      .describe("id of the device whose declared capabilities filter the catalogue")
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(AutomationsApi)
      .listDeviceAutomationTemplates({ teamId, deviceId: input.deviceId })
    return data
  }
})

/** Fires an automation's webhook trigger, authenticated by its trigger secret. */
export const triggerAutomation = defineTool({
  name: "trigger_automation",
  description: "Fire an automation's webhook trigger, authenticated by its trigger secret.",
  mutating: true,
  input: {
    secret: z.string().min(1).describe("webhook trigger secret for the automation"),
    context: params("optional context object passed to the chain"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const context = input.context ?? {}
    // The trigger route authenticates with the trigger secret, not the member API token.
    const { data } = await session.client
      .api(AutomationsApi)
      .triggerAutomation(
        Object.keys(context).length === 0 ? {} : { body: context },
        async ({ init }) =>
          Promise.resolve({
            headers: { ...init.headers, Authorization: `Bearer ${input.secret}` }
          })
      )
    return data
  }
})

/** Creates a webhook trigger secret for an automation; it is returned once. */
export const createAutomationTriggerSecret = defineTool({
  name: "create_automation_trigger_secret",
  description:
    "Create a webhook trigger secret for an automation. The URL and secret are returned once.",
  mutating: true,
  input: { automationId: automationId("to create a trigger secret for"), ...dryRunInput },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(AutomationsApi)
      .createAutomationTriggerSecret({ teamId, automationId: input.automationId })
    return data
  }
})

/** Automation tools. */
export const automationTools: readonly Tool[] = [
  listAutomations,
  createAutomation,
  getAutomation,
  updateAutomation,
  deleteAutomation,
  runAutomation,
  listAutomationRuns,
  listAutomationTemplates,
  triggerAutomation,
  createAutomationTriggerSecret
]
