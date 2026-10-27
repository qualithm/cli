import {
  claimDevice,
  createMemoryCredentialStore,
  type CredentialStore,
  Device
} from "@qualithm/device"

import type { DeviceDriver } from "./run.ts"

/** How long connecting or publishing may take before the step fails. */
const DEVICE_TIMEOUT_MS = 20_000

async function within<T>(what: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** What the SDK driver is built from; tests replace the SDK calls. */
export type SdkDeviceConfig = {
  provisioningUrl: string
  timeoutMs?: number
  claim?: typeof claimDevice
  newDevice?: (
    store: CredentialStore,
    metric: string
  ) => Pick<Device, "connect" | "publish" | "disconnect">
}

/**
 * The device side of the eval through `@qualithm/device`, the path a builder's device takes: claim
 * with the code, then connect to the gateway the claim names and publish one reading. The
 * credential stays in memory.
 *
 * @param config - the API the claim code came from, and optional overrides for tests
 * @returns the driver
 */
export function sdkDevice(config: SdkDeviceConfig): DeviceDriver {
  const store = createMemoryCredentialStore()
  const timeoutMs = config.timeoutMs ?? DEVICE_TIMEOUT_MS
  const claim = config.claim ?? claimDevice
  const newDevice =
    config.newDevice ??
    ((credentials: CredentialStore, metric: string): Device =>
      new Device({
        provisioningUrl: config.provisioningUrl,
        store: credentials,
        capabilities: [{ key: metric, type: "sensor", metric }]
      }))
  return {
    claim: async (code, name) => {
      const credential = await claim(config.provisioningUrl, { code, name })
      await store.save(credential)
      return { deviceId: credential.deviceId }
    },
    publishTelemetry: async (metric, value, tsMs) => {
      const device = newDevice(store, metric)
      try {
        await within("mqtt connect", timeoutMs, device.connect())
        const reading = JSON.stringify({ ts: tsMs, metrics: { [metric]: value } })
        await within("mqtt publish", timeoutMs, device.publish("telemetry", reading))
      } finally {
        await device.disconnect()
      }
    }
  }
}
