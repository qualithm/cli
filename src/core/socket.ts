import { homedir, userInfo } from "node:os"
import { join } from "node:path"

/**
 * Where the current user's core listens: a Unix socket in a folder only they can open, or a
 * named pipe carrying their user name on Windows.
 *
 * @param platform - the OS
 * @param home - the user's home folder
 * @param user - the user's name
 * @returns the socket path
 */
export function corePath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  user: string = userInfo().username
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\qualithm-core-${user}`
  }
  return join(home, ".qualithm", "core.sock")
}

/**
 * Where a detached core writes its output.
 *
 * @param home - the user's home folder
 * @returns the log file's path
 */
export function coreLogPath(home: string = homedir()): string {
  return join(home, ".qualithm", "core.log")
}
