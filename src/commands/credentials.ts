import type { CredentialPage, CredentialSecret, IssuedCertificate } from "@qualithm/platform"
import { z } from "zod"

import { CliError } from "../envelope.ts"
import { dash, table, when } from "../table.ts"
import {
  issueCert,
  listCredentials,
  mintCredential,
  revokeCredential,
  rotateCredential
} from "../tools/credentials.ts"
import { type Command, intOption, type ParsedArgs, readFileArg, stringOption } from "./command.ts"

const RFC_3339 = z.iso.datetime({ offset: true })

function requireOption(values: ParsedArgs["values"], ...names: string[]): string[] {
  const found = names.map((name) => stringOption(values, name))
  if (found.some((value) => value === undefined)) {
    throw new CliError(
      `${names.map((name) => `--${name}`).join(" and ")} ${names.length > 1 ? "are" : "is"} required`
    )
  }
  return found as string[]
}

function expiresAtOption(values: ParsedArgs["values"]): string | undefined {
  const value = stringOption(values, "expires-at")
  if (value !== undefined && !RFC_3339.safeParse(value).success) {
    throw new CliError("--expires-at must be an RFC 3339 time, like 2026-12-31T00:00:00Z")
  }
  return value
}

/** `qualithm credential …`: list, mint, issue, rotate and revoke device credentials. */
export const credentialCommands: readonly Command[] = [
  {
    path: ["credential", "list"],
    aliases: ["ls"],
    tool: listCredentials,
    options: { device: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const [deviceId] = requireOption(values, "device")
      return { deviceId }
    },
    human: (data: unknown): string =>
      table([
        ["ID", "KIND", "LABEL", "STATUS", "EXPIRES"],
        ...(data as CredentialPage).items.map((c) => [
          c.id,
          c.kind,
          dash(c.label),
          c.status,
          when(c.expiresAt)
        ])
      ])
  },
  {
    path: ["credential", "mint"],
    aliases: ["create"],
    tool: mintCredential,
    options: {
      device: { type: "string" },
      label: { type: "string" },
      "expires-at": { type: "string" }
    },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const [deviceId] = requireOption(values, "device")
      return { deviceId, label: stringOption(values, "label"), expiresAt: expiresAtOption(values) }
    },
    human: (data: unknown): string => {
      const { credential, secret } = data as CredentialSecret
      return (
        `credential ${credential.id} minted for device ${credential.deviceId}\n` +
        `secret (shown once): ${secret}\n`
      )
    }
  },
  {
    path: ["credential", "cert"],
    tool: issueCert,
    options: {
      device: { type: "string" },
      "csr-file": { type: "string" },
      label: { type: "string" },
      "expires-days": { type: "string" }
    },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const [deviceId, csrFile] = requireOption(values, "device", "csr-file")
      return {
        deviceId,
        csrPem: readFileArg(csrFile ?? "", "csr"),
        label: stringOption(values, "label"),
        expiresInDays: intOption(values, "expires-days")
      }
    },
    human: (data: unknown): string => {
      const issued = data as IssuedCertificate
      return (
        `certificate ${issued.credential.id} issued for device ${issued.credential.deviceId}\n` +
        `fingerprint: ${dash(issued.credential.certFingerprint)}\n${
          issued.certificatePem
        }${issued.caCertificatePem}`
      )
    }
  },
  {
    path: ["credential", "rotate"],
    tool: rotateCredential,
    options: {
      device: { type: "string" },
      credential: { type: "string" },
      "expires-at": { type: "string" },
      revoke: { type: "boolean" }
    },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const [deviceId, credentialId] = requireOption(values, "device", "credential")
      return {
        deviceId,
        credentialId,
        expiresAt: expiresAtOption(values),
        revoke: values.revoke === true
      }
    },
    human: (data: unknown): string => {
      const { credential, secret } = data as CredentialSecret
      return (
        `credential rotated: ${dash(credential.rotatedFrom)} -> ${credential.id}\n` +
        `secret (shown once): ${secret}\n`
      )
    }
  },
  {
    path: ["credential", "revoke"],
    aliases: ["delete", "rm"],
    tool: revokeCredential,
    options: { device: { type: "string" }, credential: { type: "string" } },
    toInput: ({ values }: ParsedArgs): Record<string, unknown> => {
      const [deviceId, credentialId] = requireOption(values, "device", "credential")
      return { deviceId, credentialId }
    },
    human: (_data, input) => `credential ${String(input.credentialId)} revoked\n`
  }
]
