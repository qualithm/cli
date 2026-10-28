import { EnrollmentsApi, SpacesApi } from "@qualithm/platform"
import { describe, expect, it } from "vitest"

import { CliError } from "../../envelope.ts"
import type { Session } from "../../platform.ts"
import {
  type Ask,
  keychainWifi,
  makeSetup,
  pickNetwork,
  pickSpace,
  terminalWifi,
  type WifiLookup
} from "../../tools/provision.ts"

const lookup = (networks: string[], saved: Record<string, string> = {}): WifiLookup => ({
  networks: async () => Promise.resolve(networks),
  passphrase: async (ssid) => Promise.resolve(saved[ssid])
})

/** Answers each question from `answers` in turn, recording what was asked. */
function asker(answers: string[]): Ask & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    line: async (question, fallback) => {
      asked.push(question)
      const answer = answers.shift() ?? ""
      return Promise.resolve(answer === "" ? fallback : answer)
    },
    secret: async (question) => {
      asked.push(question)
      return Promise.resolve(answers.shift() ?? "")
    }
  }
}

/** A session whose spaces and enrollments come from fixtures. */
export function fakeSession(
  spaces: { id: string; name: string }[],
  created: unknown[] = []
): Session {
  return {
    baseUrl: "https://api.example.com",
    teamId: async () => Promise.resolve("team_1"),
    client: {
      api: (api: unknown) => {
        if (api === SpacesApi) {
          return { listSpaces: async () => Promise.resolve({ data: { items: spaces } }) }
        }
        if (api === EnrollmentsApi) {
          return {
            createEnrollment: async (request: unknown) => {
              created.push(request)
              return Promise.resolve({ data: { code: "qmc_new.code" } })
            }
          }
        }
        throw new Error("unexpected api")
      }
    }
  } as unknown as Session
}

describe("pickNetwork", () => {
  it("takes the named network, else the likeliest", async () => {
    expect(await pickNetwork("Named", lookup(["Home"]))).toBe("Named")
    expect(await pickNetwork(undefined, lookup(["Home", "Cafe"]))).toBe("Home")
  })

  it("names the terminal step when the computer knows no network", async () => {
    await expect(pickNetwork(undefined, lookup([]))).rejects.toThrow(
      /run `qualithm deploy` once in a terminal/
    )
  })
})

describe("keychainWifi", () => {
  it("reads the passphrase from the keychain alone", async () => {
    expect(await keychainWifi(lookup(["Home"], { Home: "pw" }))(undefined)).toEqual({
      ssid: "Home",
      passphrase: "pw"
    })
  })

  it("fails, naming the terminal step, when the keychain has none", async () => {
    await expect(keychainWifi(lookup(["Home"]))(undefined)).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining(
        "keychain has no passphrase for the Wi-Fi network Home"
      ) as unknown
    })
  })
})

describe("terminalWifi", () => {
  it("offers the likeliest network and uses its saved passphrase", async () => {
    const ask = asker([""])
    expect(await terminalWifi(ask, lookup(["Home"], { Home: "pw" }))(undefined)).toEqual({
      ssid: "Home",
      passphrase: "pw"
    })
    expect(ask.asked).toEqual(["Wi-Fi network for the board [Home]: "])
  })

  it("takes a typed network and asks for an unsaved passphrase", async () => {
    const ask = asker(["Cafe", "typed"])
    expect(await terminalWifi(ask, lookup(["Home"]))(undefined)).toEqual({
      ssid: "Cafe",
      passphrase: "typed"
    })
    expect(ask.asked).toEqual(["Wi-Fi network for the board [Home]: ", "Passphrase for Cafe: "])
  })

  it("skips the network question when one is named", async () => {
    const ask = asker(["pw"])
    expect(await terminalWifi(ask, lookup([]))("Named")).toEqual({
      ssid: "Named",
      passphrase: "pw"
    })
    expect(ask.asked).toEqual(["Passphrase for Named: "])
  })

  it("refuses an empty network name", async () => {
    await expect(terminalWifi(asker([""]), lookup([]))(undefined)).rejects.toEqual(
      new CliError("the board needs a Wi-Fi network to join", "usage")
    )
  })
})

describe("pickSpace", () => {
  it("takes the named space, else the team's only one", async () => {
    expect(await pickSpace(fakeSession([]), "spc_named")).toBe("spc_named")
    expect(await pickSpace(fakeSession([{ id: "spc_1", name: "Lab" }]), undefined)).toBe("spc_1")
  })

  it("asks for a space when the team has several", async () => {
    const session = fakeSession([
      { id: "spc_1", name: "Lab" },
      { id: "spc_2", name: "Home" }
    ])
    await expect(pickSpace(session, undefined)).rejects.toMatchObject({
      code: "usage",
      message: "your team has several spaces: name one with --space, from Lab (spc_1), Home (spc_2)"
    })
  })

  it("says to create a space when the team has none", async () => {
    await expect(pickSpace(fakeSession([]), undefined)).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("makeSetup", () => {
  it("creates a claim code and puts the setup together", async () => {
    const created: unknown[] = []
    const setup = await makeSetup(fakeSession([], created), "spc_1", {
      ssid: "Home",
      passphrase: "pw"
    })
    expect(setup).toEqual({
      provisioningUrl: "https://api.example.com",
      claimCode: "qmc_new.code",
      wifi: { ssid: "Home", passphrase: "pw" }
    })
    expect(created).toEqual([
      { teamId: "team_1", createEnrollmentRequest: { spaceId: "spc_1", label: "qualithm deploy" } }
    ])
  })

  it("leaves Wi-Fi out to keep the board's own", async () => {
    expect(await makeSetup(fakeSession([]), "spc_1", undefined)).not.toHaveProperty("wifi")
  })
})
