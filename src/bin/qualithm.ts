#!/usr/bin/env node
import { run } from "../cli.ts"

const code = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
})
// `qualithm mcp` keeps serving after `run` resolves; every other command exits now.
if (process.argv[2] !== "mcp" || code !== 0) {
  process.exitCode = code
}
