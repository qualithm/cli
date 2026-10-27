import { parse } from "yaml"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import { dash, table } from "../table.ts"
import { applyManifest, type ApplyResult } from "../tools/apply.ts"
import { type Command, type ParsedArgs, readFileArg } from "./command.ts"

/** A manifest's shape as written; emptiness is checked after, with clearer messages. */
const manifestShape = z
  .object({
    spaces: z
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
 * @returns the spaces it declares, each with its devices
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
  const spaces = shaped.data?.spaces ?? []
  if (spaces.length === 0) {
    throw new CliError("manifest declares no spaces")
  }
  return spaces.map((space) => {
    if (space.id === undefined || space.id === null || space.id === "") {
      throw new CliError("manifest space is missing an id")
    }
    const devices = (space.devices ?? []).map(({ name }) => {
      if (name === undefined || name === null || name === "") {
        throw new CliError("manifest device is missing a name")
      }
      return { name }
    })
    return { id: space.id, devices }
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
      return { spaces: readManifest(path) }
    },
    human: (data: unknown): string =>
      table([
        ["SPACE", "DEVICE", "ACTION", "ID"],
        ...(data as ApplyResult[]).map((r) => [r.space, r.device, r.action, dash(r.id)])
      ])
  }
]
