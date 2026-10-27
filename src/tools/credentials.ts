import { CredentialsApi } from "@qualithm/platform"
import { z } from "zod"

import { defineTool, dryRunInput } from "./tool.ts"

const deviceId = (what: string): z.ZodString =>
  z.string().min(1).describe(`id of the device ${what}`)

const expiresAt = z.iso
  .datetime({ offset: true })
  .optional()
  .describe("optional expiry time in the future, RFC 3339")

/** Lists one device's credentials: tokens and certificates. */
export const listCredentials = defineTool({
  name: "list_credentials",
  description: "List the credentials (tokens and certificates) for a device.",
  mutating: false,
  input: { deviceId: deviceId("whose credentials to list") },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client
      .api(CredentialsApi)
      .listDeviceCredentials({ teamId, deviceId: input.deviceId })
    return data
  }
})

/** Mints a token credential for a device; its secret is returned once. */
export const mintCredential = defineTool({
  name: "mint_credential",
  description: "Mint a token credential for a device. The plaintext secret is returned once.",
  mutating: true,
  input: {
    deviceId: deviceId("to mint a credential for"),
    label: z.string().optional().describe("human-readable credential label"),
    expiresAt,
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(CredentialsApi).createDeviceCredential({
      teamId,
      deviceId: input.deviceId,
      createDeviceCredentialRequest: {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) })
      }
    })
    return data
  }
})

/** Issues an mTLS certificate credential for a device from its CSR. */
export const issueCert = defineTool({
  name: "issue_cert",
  description:
    "Issue an mTLS certificate credential for a device from a CSR. The certificate is returned once.",
  mutating: true,
  input: {
    deviceId: deviceId("to issue a certificate for"),
    csrPem: z.string().min(1).describe("PEM-encoded certificate signing request"),
    label: z.string().optional().describe("human-readable credential label"),
    expiresInDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("certificate lifetime in days; the server default is 30"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(CredentialsApi).createDeviceCertificate({
      teamId,
      deviceId: input.deviceId,
      createDeviceCertificateRequest: {
        csrPem: input.csrPem,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.expiresInDays === undefined ? {} : { expiresInDays: input.expiresInDays })
      }
    })
    return data
  }
})

/** Rotates a device credential, optionally revoking the old one at once. */
export const rotateCredential = defineTool({
  name: "rotate_credential",
  description:
    "Rotate a device credential, optionally revoking the old one. The new secret is returned once.",
  mutating: true,
  input: {
    deviceId: deviceId("that owns the credential"),
    credentialId: z.string().min(1).describe("id of the credential to rotate"),
    expiresAt,
    revoke: z.boolean().optional().describe("revoke the old credential immediately after rotating"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    const { data } = await session.client.api(CredentialsApi).rotateDeviceCredential({
      teamId,
      deviceId: input.deviceId,
      credentialId: input.credentialId,
      ...(input.revoke === true ? { revoke: "true" } : {}),
      rotateDeviceCredentialRequest:
        input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }
    })
    return data
  }
})

/** Revokes one device credential. */
export const revokeCredential = defineTool({
  name: "revoke_credential",
  description: "Revoke a device credential by id.",
  mutating: true,
  input: {
    deviceId: deviceId("that owns the credential"),
    credentialId: z.string().min(1).describe("id of the credential to revoke"),
    ...dryRunInput
  },
  run: async (session, input) => {
    const teamId = await session.teamId()
    await session.client.api(CredentialsApi).deleteDeviceCredential({
      teamId,
      deviceId: input.deviceId,
      credentialId: input.credentialId
    })
    return undefined
  }
})
