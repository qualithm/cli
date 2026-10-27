import { readFileSync } from "node:fs"

import { CliError } from "../envelope.ts"
import type { Tool } from "../tools/tool.ts"

/** A flag a command adds to the common ones; values are parsed as strings or booleans. */
export type OptionSpec = { type: "string" | "boolean" }

/** What a command's argument mapping receives. */
export type ParsedArgs = {
  values: Readonly<Record<string, string | boolean | undefined>>
  positionals: readonly string[]
}

/** A `qualithm <resource> <verb>` command that runs a tool. */
export type ToolCommand = {
  /** The resource and verb, e.g. `["token", "list"]`. */
  path: readonly [string, string]
  /** Other names for the verb. */
  aliases?: readonly string[]
  /** The tool it runs. */
  tool: Tool
  /** Flags beyond the common ones. */
  options: Readonly<Record<string, OptionSpec>>
  /**
   * Maps flags and positionals to the tool's input; `dryRun` is added for mutating tools.
   *
   * @throws {CliError} when a required argument is missing or malformed
   */
  toInput: (args: ParsedArgs) => Record<string, unknown>
  /** Renders a successful payload for a person. */
  human: (data: unknown, input: Record<string, unknown>) => string
}

/** A verb the CLI recognises only to say where the action lives instead. */
export type RefusedCommand = {
  path: readonly [string, string]
  aliases?: readonly string[]
  /** Why, and where to go. */
  refuse: string
}

/** One CLI command. */
export type Command = ToolCommand | RefusedCommand

/**
 * Reads an optional integer flag.
 *
 * @param values - the parsed flags
 * @param name - the flag
 * @returns the integer, or `undefined` when the flag is absent
 * @throws {CliError} when the flag isn't a whole number
 */
export function intOption(values: ParsedArgs["values"], name: string): number | undefined {
  const raw = values[name]
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (typeof raw !== "string" || !Number.isInteger(value)) {
    throw new CliError(`--${name} must be a whole number`)
  }
  return value
}

/**
 * Reads an optional string flag.
 *
 * @param values - the parsed flags
 * @param name - the flag
 * @returns the value, or `undefined` when the flag is absent or empty
 */
export function stringOption(values: ParsedArgs["values"], name: string): string | undefined {
  const raw = values[name]
  return typeof raw === "string" && raw !== "" ? raw : undefined
}

/**
 * Reads a required positional argument.
 *
 * @param positionals - the positionals after the verb
 * @param index - which one
 * @param label - what it is, for the error
 * @returns the argument
 * @throws {CliError} when it's missing
 */
export function requirePositional(
  positionals: readonly string[],
  index: number,
  label: string
): string {
  const value = positionals[index]
  if (value === undefined || value === "") {
    throw new CliError(`${label} is required`)
  }
  return value
}

/**
 * Reads a file a flag names.
 *
 * @param path - the path
 * @param what - what the file holds, for the error
 * @returns the file's text
 * @throws {CliError} with code `error` when the file can't be read
 */
export function readFileArg(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(`read ${what}: ${reason}`, "error")
  }
}
