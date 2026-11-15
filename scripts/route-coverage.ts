#!/usr/bin/env bun
/**
 * Checks that every `management` operation in the platform's OpenAPI document has a
 * `qualithm mcp` tool or a tracked gap. Platform CI runs it on the spec it builds:
 *
 *   bun run route-coverage <openapi.json>
 */
import { readFileSync } from "node:fs"

import { routeCoverage, specOperations } from "../src/tools/coverage.ts"
import { TOOLS, UNTOOLED_OPERATIONS } from "../src/tools/index.ts"

const path = process.argv[2]
if (path === undefined) {
  process.stderr.write("route-coverage: usage: route-coverage <openapi.json>\n")
  process.exit(2)
}
const spec: unknown = JSON.parse(readFileSync(path, "utf8"))
const problems = routeCoverage(spec, TOOLS, UNTOOLED_OPERATIONS)
for (const problem of problems) {
  process.stderr.write(`route-coverage: ${problem}\n`)
}
if (problems.length > 0) {
  process.exit(1)
}
const management = [...specOperations(spec).values()].filter(
  (audience) => audience === "management"
)
process.stdout.write(
  `route coverage ok: ${String(management.length)} management operations, ${String(Object.keys(UNTOOLED_OPERATIONS).length)} tracked as untooled\n`
)
