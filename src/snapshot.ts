import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** How often a database on another machine is copied again. Copies are large (opencode's WSL db is ~1 GB). */
export const SNAPSHOT_MS = 10 * 60_000;

const lastCopy = new Map<string, number>();

/** Paths on another machine, e.g. a WSL distro via \\wsl.localhost\<distro>\... */
export function isRemote(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

function intact(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true });
    const row = db.query("pragma quick_check").get() as { quick_check: string } | null;
    db.close();
    return row?.quick_check === "ok";
  } catch {
    return false;
  }
}

/**
 * Returns a path that can be opened locally for reading. Local paths are returned as is.
 * Live SQLite databases on a network share cannot be opened in place (SQLITE_BUSY while
 * the other side runs), so they are copied into snapDir, refreshed at most every
 * SNAPSHOT_MS and only replaced when the copy passes quick_check. Returns null when the
 * database is missing and no earlier copy exists.
 */
export function localReadable(path: string, snapDir: string): string | null {
  if (!isRemote(path)) return path;
  const dest = join(snapDir, createHash("sha1").update(path).digest("hex").slice(0, 16) + ".db");
  const fresh = existsSync(dest) && Date.now() - (lastCopy.get(path) ?? 0) < SNAPSHOT_MS;
  if (fresh) return dest;
  if (!existsSync(path)) return existsSync(dest) ? dest : null;

  mkdirSync(snapDir, { recursive: true });
  const tmp = dest + ".tmp";
  try {
    copyFileSync(path, tmp);
    if (!intact(tmp)) {
      rmSync(tmp, { force: true });
      return existsSync(dest) ? dest : null;
    }
    renameSync(tmp, dest);
    lastCopy.set(path, Date.now());
    return dest;
  } catch {
    rmSync(tmp, { force: true });
    return existsSync(dest) ? dest : null;
  }
}
