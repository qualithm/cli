import { mkdir, open, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { CliError } from "../envelope.ts"
import type { FetchAPI } from "../platform.ts"
import { type AuthServer, discover, LOG_IN_AGAIN, refresh } from "./oauth.ts"
import type { CredentialStore, StoredLogin } from "./store.ts"

/** Runs `task` while holding the lock every process sharing the sign-in takes to refresh it. */
export type RefreshLock = <T>(task: () => Promise<T>) => Promise<T>

/** Refreshes this long before the access token lapses, so a request never carries a stale one. */
const EARLY_MS = 60 * 1000
const LOCK_STALE_MS = 30 * 1000
const LOCK_WAIT_MS = 15 * 1000

/** The message when there is neither a token nor a sign-in. */
export const NOT_LOGGED_IN = "not logged in: run qualithm login, or set QUALITHM_API_TOKEN"

/**
 * A lock file under `~/.qualithm`, so two processes never present the same refresh token: the
 * server revokes the whole grant when one is reused. A lock older than its stale age is taken over.
 *
 * @param home - the home directory
 * @returns the lock
 */
export function fileLock(home: string = homedir()): RefreshLock {
  return async (task) => {
    const dir = join(home, ".qualithm")
    const path = join(dir, "login.lock")
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600)
        await handle.close()
        break
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") {
          throw error
        }
        const age = await stat(path).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0
        )
        if (age > LOCK_STALE_MS || Date.now() > deadline) {
          await rm(path, { force: true })
          continue
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    try {
      return await task()
    } finally {
      await rm(path, { force: true })
    }
  }
}

/** What a stored sign-in reaches for. */
export type LoginConfig = {
  /** The API origin the sign-in is for. */
  api: string
  store: CredentialStore
  fetch: FetchAPI
  lock: RefreshLock
  now?: () => number
}

/**
 * The access token from the stored sign-in, refreshed when it is about to lapse. Every process
 * shares the one keychain entry, so a refresh re-reads it under the lock first: another process
 * may already have rotated it.
 */
export class LoginSource {
  private readonly config: LoginConfig
  private current: StoredLogin | undefined
  private loaded = false
  private server: AuthServer | undefined
  private pending: Promise<string> | undefined

  /**
   * @param config - the API origin, store, `fetch`, lock and clock
   */
  constructor(config: LoginConfig) {
    this.config = config
  }

  private now(): number {
    return (this.config.now ?? Date.now)()
  }

  /**
   * Whether a sign-in is stored for this API.
   *
   * @returns true when one is
   */
  async present(): Promise<boolean> {
    return (await this.load()) !== undefined
  }

  private async load(): Promise<StoredLogin | undefined> {
    if (!this.loaded) {
      this.current = await this.config.store.read(this.config.api)
      this.loaded = true
    }
    return this.current
  }

  /**
   * An access token to send.
   *
   * @param rejected - the token the API just refused, to force a refresh past it
   * @returns the access token
   * @throws {CliError} when nothing is stored, or the sign-in can no longer be refreshed
   */
  async accessToken(rejected?: string): Promise<string> {
    const login = await this.load()
    if (login === undefined) {
      throw new CliError(NOT_LOGGED_IN, "usage")
    }
    if (rejected === undefined && login.expiresAt - EARLY_MS > this.now()) {
      return login.accessToken
    }
    if (rejected !== undefined && rejected !== login.accessToken) {
      return login.accessToken
    }
    // One refresh at a time within this process too, so concurrent calls share it.
    this.pending ??= this.refreshed(rejected ?? login.accessToken).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async refreshed(stale: string): Promise<string> {
    return this.config.lock(async () => {
      const latest = await this.config.store.read(this.config.api)
      if (latest === undefined) {
        this.current = undefined
        throw new CliError(NOT_LOGGED_IN, "usage")
      }
      if (latest.accessToken !== stale && latest.expiresAt - EARLY_MS > this.now()) {
        this.current = latest
        return latest.accessToken
      }
      this.server ??= await discover(this.config.api, this.config.fetch)
      let next: StoredLogin
      try {
        next = await refresh(this.server, latest.refreshToken, this.config.fetch, () => this.now())
      } catch (error) {
        if (error instanceof CliError && error.code === "auth") {
          throw new CliError(LOG_IN_AGAIN, "auth")
        }
        throw error
      }
      await this.config.store.write(this.config.api, next)
      this.current = next
      return next.accessToken
    })
  }
}
