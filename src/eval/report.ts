/** One step of the eval: what an agent did, whether it worked, and how long it took. */
export type Step = {
  name: string
  ok: boolean
  durationMs: number
  detail?: string
}

/** A place the agent had to supply information no surface gave it. */
export type Friction = {
  step: string
  missing: string
}

/** The eval's outcome, written as JSON and rendered for the run summary. */
export type Report = {
  ok: boolean
  startedAt: string
  steps: Step[]
  friction: Friction[]
}

/**
 * Renders a report for a person: a pass/fail line, each step, then the friction log.
 *
 * @param report - the report
 * @returns the text, one line per step and friction entry
 */
export function renderReport(report: Report): string {
  const lines = [`agent-eval ${report.ok ? "PASS" : "FAIL"} (${report.startedAt})`, "", "Steps:"]
  for (const step of report.steps) {
    const detail = step.detail === undefined || step.detail === "" ? "" : `: ${step.detail}`
    lines.push(
      `- [${step.ok ? "ok" : "FAIL"}] ${step.name} (${String(step.durationMs)}ms)${detail}`
    )
  }
  lines.push(
    "",
    "Friction log (steps the agent had to supply information the surfaces did not provide):"
  )
  if (report.friction.length === 0) {
    lines.push("- none")
  }
  for (const entry of report.friction) {
    lines.push(`- ${entry.step}: ${entry.missing}`)
  }
  return `${lines.join("\n")}\n`
}
