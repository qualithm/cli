import { describe, expect, it } from "vitest"

import { DEVICE_SDK } from "../../board/sdk.ts"
import { boardDecisions } from "../../tools/receipt.ts"

describe("boardDecisions", () => {
  it("lists what a deploy used, most consequential first", () => {
    expect(
      boardDecisions({ firmware: "1.29.0", sdk: true, scopeId: "spc_1", wifiNetwork: "Home" })
    ).toEqual([
      {
        key: "firmware",
        label: "MicroPython",
        value: "1.29.0",
        source: "cli",
        docsUrl: "https://docs.qualithm.com/devices#add-a-device"
      },
      {
        key: "sdk",
        label: "Qualithm Device SDK",
        value: DEVICE_SDK.version,
        source: "cli",
        docsUrl: "https://docs.qualithm.com/devices#add-a-device"
      },
      {
        key: "scope",
        label: "Scope",
        value: "spc_1",
        source: "team",
        docsUrl: "https://docs.qualithm.com/scopes#add-a-device-to-a-scope"
      },
      {
        key: "wifi",
        label: "Wi-Fi network",
        value: "Home",
        source: "computer",
        docsUrl: "https://docs.qualithm.com/devices#add-a-device"
      }
    ])
  })

  it("leaves off what the run didn't use", () => {
    expect(boardDecisions({})).toEqual([])
    expect(boardDecisions({ sdk: false, wifiNetwork: "" })).toEqual([])
  })
})
