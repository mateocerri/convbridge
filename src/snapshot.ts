import { existsSync } from "node:fs";

/** Paths on another machine, e.g. a WSL distro via \\wsl.localhost\<distro>\... */
export function isRemote(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

/**
 * Path to open for reading, always in place and read-only (see openOpencode). Returns
 * null when the database does not exist. Databases another process has open are read
 * as they are; nothing is copied.
 */
export function localReadable(path: string): string | null {
  return existsSync(path) ? path : null;
}

/**
 * True when a SQLite connection to `path` is open right now. SQLite in WAL mode keeps
 * `<path>-shm` (and `<path>-wal`) beside the database while any connection is open.
 */
export function isLive(path: string): boolean {
  return existsSync(path + "-shm") || existsSync(path + "-wal");
}
