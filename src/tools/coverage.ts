import type { Tool } from "./tool.ts"

/** The audience whose every operation needs a tool; `device` and `infra` need none. */
const TOOLED_AUDIENCE = "management"

type SpecOperation = { operationId?: unknown; "x-qualithm-audience"?: unknown }

/**
 * Every operation in an OpenAPI document, by `operationId`, with its `x-qualithm-audience`.
 *
 * @param spec - the parsed document
 * @returns each operation's audience, or `undefined` when it has none
 */
export function specOperations(spec: unknown): Map<string, string | undefined> {
  const operations = new Map<string, string | undefined>()
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> } | null)?.paths ?? {}
  for (const item of Object.values(paths)) {
    for (const value of Object.values(item)) {
      const operation = value as SpecOperation | null
      if (
        operation !== null &&
        typeof operation === "object" &&
        typeof operation.operationId === "string"
      ) {
        const audience = operation["x-qualithm-audience"]
        operations.set(operation.operationId, typeof audience === "string" ? audience : undefined)
      }
    }
  }
  return operations
}

/**
 * Checks the tools against the platform's spec: every `management` operation is called by a tool
 * or tracked as untooled, every operation a tool names exists, and every untooled entry is still
 * a `management` operation no tool calls.
 *
 * @param spec - the platform's parsed OpenAPI document
 * @param tools - every tool `qualithm mcp` serves
 * @param untooled - `management` operations with no tool yet, each with its tracking issue
 * @returns one line per problem; empty when the tools cover the spec
 */
export function routeCoverage(
  spec: unknown,
  tools: readonly Tool[],
  untooled: Readonly<Record<string, string>>
): string[] {
  const operations = specOperations(spec)
  if (operations.size === 0) {
    return ["the spec has no operations"]
  }
  const problems: string[] = []
  const called = new Set<string>()
  for (const tool of tools) {
    for (const operationId of tool.operations) {
      called.add(operationId)
      if (!operations.has(operationId)) {
        problems.push(`${tool.name} names ${operationId}, which the spec doesn't have`)
      }
    }
  }
  for (const [operationId, audience] of [...operations].sort(([a], [b]) => a.localeCompare(b))) {
    if (audience === TOOLED_AUDIENCE && !called.has(operationId) && !(operationId in untooled)) {
      problems.push(
        `${operationId} is a management operation with no tool: add one, or list it in UNTOOLED_OPERATIONS with its issue`
      )
    }
  }
  for (const [operationId, issue] of Object.entries(untooled)) {
    if (called.has(operationId)) {
      problems.push(`${operationId} has a tool now: drop it from UNTOOLED_OPERATIONS (${issue})`)
    } else if (operations.get(operationId) !== TOOLED_AUDIENCE) {
      problems.push(`${operationId} is untooled but isn't a management operation in the spec`)
    }
  }
  return problems
}
