import type { Ask } from "../tools/provision.ts"

/** A terminal to ask on: keys in, prompts out. */
export type Terminal = {
  input: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => unknown; isTTY?: boolean }
  output: (text: string) => void
}

const ENTER = new Set(["\r", "\n"])
const CTRL_C = "\x03"
const BACKSPACE = new Set(["\x7f", "\b"])

async function readLine(terminal: Terminal, echo: boolean): Promise<string> {
  const { input } = terminal
  input.setRawMode?.(true)
  input.resume()
  try {
    return await new Promise((resolve, reject) => {
      let typed = ""
      const onData = (chunk: Buffer | string): void => {
        for (const key of chunk.toString()) {
          if (ENTER.has(key)) {
            input.off("data", onData)
            terminal.output("\n")
            resolve(typed)
            return
          }
          if (key === CTRL_C) {
            input.off("data", onData)
            terminal.output("\n")
            reject(new Error("cancelled"))
            return
          }
          if (BACKSPACE.has(key)) {
            if (typed !== "" && echo) {
              terminal.output("\b \b")
            }
            typed = typed.slice(0, -1)
          } else {
            typed += key
            if (echo) {
              terminal.output(key)
            }
          }
        }
      }
      input.on("data", onData)
    })
  } finally {
    input.setRawMode?.(false)
    input.pause()
  }
}

/**
 * Asks on a terminal, hiding a secret's keys as they are typed.
 *
 * @param terminal - where to ask
 * @returns the asker
 */
export function terminalAsk(terminal: Terminal): Ask {
  return {
    line: async (question, fallback) => {
      terminal.output(question)
      const answer = await readLine(terminal, true)
      return answer === "" ? fallback : answer
    },
    secret: async (question) => {
      terminal.output(question)
      return readLine(terminal, false)
    }
  }
}
