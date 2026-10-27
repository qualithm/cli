#!/usr/bin/env node
import { runAgentEval } from "./main.ts"

process.exitCode = await runAgentEval(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env
})
