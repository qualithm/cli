import { parse } from "yaml"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import { dash, table } from "../table.ts"
import { applyManifest, type ApplyResult } from "../tools/apply.ts"
import { type Command, type ParsedArgs, readFileArg } from "./command.ts"

/** A manifest's shape as written; emptiness is checked after, with clearer messages. */
const manifestShape = z
  .object({
    scopes: z
      .array(
        z.object({
          id: z.string().nullish(),
          devices: z.array(z.object({ name: z.string().nullish() })).nullish()
        })
      )
      .nullish()
  })
  .nullish()

/**
 * Reads and checks a device-as-code manifest. YAML is a superset of JSON, so either parses.
 *
 * @param path - the manifest file
 * @returns the scopes it declares, each with its devices
 * @throws {CliError} when the file can't be read (`error`), or is malformed or empty (`usage`)
 */
function readManifest(path: string): { id: string; devices: { name: string }[] }[] {
  const text = readFileArg(path, "manifest")
  let doc: unknown
  try {
    doc = parse(text)
  } catch (error) {
    throw new CliError(`parse manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  const shaped = manifestShape.safeParse(doc)
  if (!shaped.success) {
    const issue = shaped.error.issues[0]
    const where = issue?.path.join(".") ?? ""
    const detail = (issue?.message ?? "invalid manifest").toLowerCase()
    throw new CliError(`parse manifest: ${where === "" ? detail : `${where}: ${detail}`}`)
  }
  const scopes = shaped.data?.scopes ?? []
  if (scopes.length === 0) {
    throw new CliError("manifest declares no scopes")
  }
  return scopes.map((scope) => {
    if (scope.id === undefined || scope.id === null || scope.id === "") {
      throw new CliError("manifest scope is missing an id")
    }
    const devices = (scope.devices ?? []).map(({ name }) => {
      if (name === undefined || name === null || name === "") {
        throw new CliError("manifest device is missing a name")
      }
      return { name }
    })
    return { id: scope.id, devices }
  })
}

/** `qualithm apply`: reconcile a device-as-code manifest. */
export const applyCommands: readonly Command[] = [
  {
    path: ["apply"],
    tool: applyManifest,
    options: {},
    toInput: ({ positionals }: ParsedArgs): Record<string, unknown> => {
      const path = positionals[0]
      if (path === undefined || path === "") {
        throw new CliError("a manifest path is required")
      }
      return { scopes: readManifest(path) }
    },
    human: (data: unknown): string =>
      table([
        ["SCOPE", "DEVICE", "ACTION", "ID"],
        ...(data as ApplyResult[]).map((r) => [r.scope, r.device, r.action, dash(r.id)])
      ])
  }
]
