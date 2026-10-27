import { writeFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { parseArgs } from "node:util"

import { sdkDevice } from "./device.ts"
import { connectServer, type McpConnection } from "./mcp-client.ts"
import { renderReport } from "./report.ts"
import { type DeviceDriver, type EvalConfig, runEval } from "./run.ts"

/** Exit when the eval can't start for lack of configuration: nothing ran, so nothing is reported. */
export const EXIT_CONFIG = 2

/** Where the eval writes and what it starts; tests replace each part. */
export type EvalIo = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
  connect?: (command: string, args: string[], env: Record<string, string>) => Promise<McpConnection>
  device?: (provisioningUrl: string) => DeviceDriver
  writeReport?: (path: string, text: string) => Promise<void>
  config?: EvalConfig
}

/**
 * Runs the agent eval against `qualithm mcp`. Exit 0 when every step passes, 1 when one fails, and
 * 2 when the token or server is missing, so the workflow can stay green without a token.
 *
 * @param argv - `--server <path to qualithm.js>`, `--api-url`, `--zone`, `--out`
 * @param io - output, environment and the parts tests replace
 * @returns the exit code
 */
export async function runAgentEval(argv: string[], io: EvalIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      "api-url": { type: "string" },
      zone: { type: "string" },
      out: { type: "string" }
    }
  })
  const server = values.server ?? io.env.AGENT_EVAL_SERVER ?? ""
  const token = io.env.QUALITHM_API_TOKEN ?? ""
  const apiUrl = values["api-url"] ?? io.env.QUALITHM_API_URL ?? "https://api.sandbox.qualithm.com"
  if (server === "" || token === "") {
    io.stderr("agent-eval: --server and QUALITHM_API_TOKEN are required; the eval did not run\n")
    return EXIT_CONFIG
  }
  if (!isAbsolute(server)) {
    io.stderr(`agent-eval: --server must be an absolute path, got ${server}\n`)
    return EXIT_CONFIG
  }
  const connect = io.connect ?? connectServer
  let connection: McpConnection
  try {
    connection = await connect(process.execPath, [server, "mcp"], {
      PATH: io.env.PATH ?? "",
      QUALITHM_API_TOKEN: token,
      QUALITHM_API_URL: apiUrl
    })
  } catch (error) {
    io.stderr(
      `agent-eval: start qualithm mcp: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return 1
  }
  try {
    const device = (io.device ?? ((url: string) => sdkDevice({ provisioningUrl: url })))(apiUrl)
    const zone = values.zone ?? io.env.AGENT_EVAL_ZONE
    const report = await runEval(connection.call, device, {
      ...io.config,
      ...(zone === undefined ? {} : { zone })
    })
    io.stdout(renderReport(report))
    if (values.out !== undefined) {
      const write = io.writeReport ?? (async (path, text) => writeFile(path, text, { mode: 0o600 }))
      await write(values.out, `${JSON.stringify(report, null, 2)}\n`)
    }
    return report.ok ? 0 : 1
  } finally {
    await connection.close()
  }
}
