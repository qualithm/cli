import { execFile } from "node:child_process"

import { CliError } from "../envelope.ts"

/** A sign-in as the CLI keeps it: never written to a file, a log or the envelope. */
export type StoredLogin = {
  /** The `qmat_…` access token. */
  accessToken: string
  /** The `qmrt_…` refresh token; replaced on every refresh. */
  refreshToken: string
  /** When the access token lapses, in milliseconds since the epoch. */
  expiresAt: number
  /** The role granted at consent. */
  scope: string
}

/** Where sign-ins live, one per API origin; the OS secret store by default, tests pass their own. */
export type CredentialStore = {
  /** The sign-in for an API origin, or undefined when there is none. */
  read: (origin: string) => Promise<StoredLogin | undefined>
  /** Saves the sign-in for an API origin, replacing any earlier one. */
  write: (origin: string, login: StoredLogin) => Promise<void>
  /** Removes the sign-in for an API origin; a missing one is not an error. */
  clear: (origin: string) => Promise<void>
}

/** What the secret store runs on; the real OS by default. */
export type SecretHost = {
  platform: NodeJS.Platform
  /**
   * Runs a command, writing `input` to its stdin, and returns its stdout. Rejects with the
   * process's exit `code` (a number, or `ENOENT` when the command is missing).
   */
  run: (command: string, args: readonly string[], input?: string) => Promise<string>
}

export const defaultSecretHost: SecretHost = {
  platform: process.platform,
  run: async (command, args, input) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        command,
        [...args],
        { maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error === null) {
            resolve(stdout)
          } else {
            reject(Object.assign(new Error(error.message), { code: error.code }))
          }
        }
      )
      // A command that exits before reading its stdin closes the pipe; its exit code says why.
      child.stdin?.on("error", () => undefined)
      child.stdin?.end(input ?? "")
    })
}

/** The secret store's service name; the account is the API origin. */
export const SERVICE = "qualithm"
const LABEL = "Qualithm CLI sign-in"

function exitOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

function parse(text: string): StoredLogin | undefined {
  const trimmed = text.trim()
  if (trimmed === "") {
    return undefined
  }
  try {
    const value = JSON.parse(trimmed) as Partial<StoredLogin>
    if (
      typeof value.accessToken === "string" &&
      typeof value.refreshToken === "string" &&
      typeof value.expiresAt === "number" &&
      typeof value.scope === "string"
    ) {
      return {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
        scope: value.scope
      }
    }
  } catch {
    // An entry this CLI didn't write reads as no sign-in; logging in again replaces it.
  }
  return undefined
}

function serialize(login: StoredLogin): string {
  return JSON.stringify({
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    expiresAt: login.expiresAt,
    scope: login.scope
  })
}

/** An origin is only ever a URL origin; refusing anything else keeps it safe inside a command. */
function checkedOrigin(origin: string): string {
  if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(origin)) {
    throw new CliError(`not an API origin: ${origin}`)
  }
  return origin
}

const keychainError =
  (verb: string) =>
  (error: unknown): CliError =>
    new CliError(
      `could not ${verb} the sign-in ${verb === "save" ? "to" : "from"} this computer's keychain: ${String(error instanceof Error ? error.message : error).toLowerCase()}`,
      "error"
    )
const unreadable = keychainError("read")
const unwritable = keychainError("save")
const uncleared = keychainError("clear")

/** macOS: the login keychain, through `security`. Writes go over stdin, never argv. */
function macStore(host: SecretHost): CredentialStore {
  const item = (origin: string): string[] => ["-s", SERVICE, "-a", checkedOrigin(origin)]
  return {
    read: async (origin) => {
      try {
        return parse(await host.run("security", ["find-generic-password", ...item(origin), "-w"]))
      } catch (error) {
        // 44 is "not found"; a missing `security` means nothing was ever stored.
        if (exitOf(error) === 44 || exitOf(error) === "ENOENT") {
          return undefined
        }
        throw unreadable(error)
      }
    },
    write: async (origin, login) => {
      const hex = Buffer.from(serialize(login), "utf8").toString("hex")
      const line = `add-generic-password -U -s ${SERVICE} -a "${checkedOrigin(origin)}" -l "${LABEL}" -X ${hex}\n`
      try {
        await host.run("security", ["-i"], line)
      } catch (error) {
        throw unwritable(error)
      }
    },
    clear: async (origin) => {
      try {
        await host.run("security", ["delete-generic-password", ...item(origin)])
      } catch (error) {
        if (exitOf(error) !== 44) {
          throw uncleared(error)
        }
      }
    }
  }
}

/** Linux: the Secret Service, through libsecret's `secret-tool`, which reads the secret on stdin. */
function linuxStore(host: SecretHost): CredentialStore {
  const attributes = (origin: string): string[] => ["service", SERVICE, "account", origin]
  return {
    read: async (origin) => {
      try {
        return parse(await host.run("secret-tool", ["lookup", ...attributes(origin)]))
      } catch (error) {
        // 1 is "not found"; no `secret-tool` means nothing was ever stored.
        if (exitOf(error) === 1 || exitOf(error) === "ENOENT") {
          return undefined
        }
        throw unreadable(error)
      }
    },
    write: async (origin, login) => {
      try {
        await host.run(
          "secret-tool",
          ["store", `--label=${LABEL}`, ...attributes(origin)],
          serialize(login)
        )
      } catch (error) {
        if (exitOf(error) === "ENOENT") {
          throw new CliError(
            "this computer has no keychain the CLI can use: install secret-tool (libsecret), or set QUALITHM_API_TOKEN",
            "error"
          )
        }
        throw unwritable(error)
      }
    },
    clear: async (origin) => {
      try {
        await host.run("secret-tool", ["clear", ...attributes(origin)])
      } catch (error) {
        if (exitOf(error) !== "ENOENT") {
          throw uncleared(error)
        }
      }
    }
  }
}

const WINDOWS_CREDENTIALS = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class QualithmCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) return "";
      throw new Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Encoding.UTF8.GetString(b);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string secret) {
    byte[] b = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = "qualithm"; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWriteW(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, 1, 0)) {
      int e = Marshal.GetLastWin32Error();
      if (e != 1168) throw new Win32Exception(e);
    }
  }
}
`

/**
 * The PowerShell that reads, writes or deletes one Credential Manager entry. The secret
 * arrives on stdin, never in the script, so it never shows on a command line.
 *
 * @param action - what to do
 * @param origin - the API origin the entry is for
 * @returns the arguments for `powershell.exe`
 */
export function windowsArgs(action: "Read" | "Write" | "Delete", origin: string): string[] {
  const target = `${SERVICE}:${checkedOrigin(origin)}`
  const call =
    action === "Read"
      ? `[Console]::Out.Write([QualithmCredential]::Read('${target}'))`
      : action === "Write"
        ? `[QualithmCredential]::Write('${target}', [Console]::In.ReadToEnd())`
        : `[QualithmCredential]::Delete('${target}')`
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${WINDOWS_CREDENTIALS}\n'@\n${call}\n`
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
}

/** Windows: Credential Manager, through PowerShell calling `CredWriteW`/`CredReadW`. */
function windowsStore(host: SecretHost): CredentialStore {
  return {
    read: async (origin) => {
      try {
        return parse(await host.run("powershell.exe", windowsArgs("Read", origin)))
      } catch (error) {
        throw unreadable(error)
      }
    },
    write: async (origin, login) => {
      try {
        await host.run("powershell.exe", windowsArgs("Write", origin), serialize(login))
      } catch (error) {
        throw unwritable(error)
      }
    },
    clear: async (origin) => {
      try {
        await host.run("powershell.exe", windowsArgs("Delete", origin))
      } catch (error) {
        throw uncleared(error)
      }
    }
  }
}

/**
 * The OS secret store: the macOS keychain, the Secret Service on Linux, or Windows Credential
 * Manager. Shared by `qualithm` and `qualithm mcp`.
 *
 * @param host - the OS
 * @returns the store; on another OS, one that holds nothing and refuses to save
 */
export function keychainStore(host: SecretHost = defaultSecretHost): CredentialStore {
  switch (host.platform) {
    case "darwin":
      return macStore(host)
    case "linux":
      return linuxStore(host)
    case "win32":
      return windowsStore(host)
    case "aix":
    case "android":
    case "freebsd":
    case "haiku":
    case "openbsd":
    case "sunos":
    case "cygwin":
    case "netbsd":
      return {
        read: async () => Promise.resolve(undefined),
        write: async () =>
          Promise.reject(
            new CliError(
              "this computer has no keychain the CLI can use: set QUALITHM_API_TOKEN",
              "error"
            )
          ),
        clear: async () => Promise.resolve()
      }
  }
}
