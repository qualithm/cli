import { EventEmitter } from "node:events"

import { describe, expect, it } from "vitest"

import { type Terminal, terminalAsk } from "../../commands/ask.ts"

/** A terminal that types `keys` once a question is asked, recording what is shown. */
function terminal(keys: string[]): Terminal & { shown: () => string; raw: boolean[] } {
  let shown = ""
  const raw: boolean[] = []
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      raw.push(mode)
      return input
    },
    resume: () => {
      setTimeout(() => {
        const next = keys.shift()
        if (next !== undefined) {
          input.emit("data", Buffer.from(next))
        }
      }, 0)
      return input
    },
    pause: () => input
  })
  return {
    input: input as unknown as Terminal["input"],
    output: (text) => {
      shown += text
    },
    shown: () => shown,
    raw
  }
}

describe("terminalAsk", () => {
  it("echoes a line, with backspace, and falls back on an empty answer", async () => {
    const t = terminal(["Caff\x7fe\r", "\r"])
    const ask = terminalAsk(t)
    expect(await ask.line("Network: ", "Home")).toBe("Cafe")
    expect(await ask.line("Network: ", "Home")).toBe("Home")
    expect(t.shown()).toBe("Network: Caff\b \be\nNetwork: \n")
    expect(t.raw).toEqual([true, false, true, false])
  })

  it("never shows a secret's keys", async () => {
    const t = terminal(["s3cr\x7f\x7fcret\n"])
    expect(await terminalAsk(t).secret("Passphrase: ")).toBe("s3cret")
    expect(t.shown()).toBe("Passphrase: \n")
  })

  it("cancels on Ctrl-C", async () => {
    const t = terminal(["ab\x03"])
    await expect(terminalAsk(t).secret("Passphrase: ")).rejects.toThrow("cancelled")
  })
})
