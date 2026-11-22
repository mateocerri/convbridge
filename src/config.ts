import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  /** Directory holding the convbridge index. */
  indexDir: string;
  /** opencode SQLite databases, one per install (Windows, each WSL distro, ...). Opened read-only. */
  opencodeDbs: string[];
  /** Claude Code projects directories: each holds <project-slug>/<session-id>.jsonl. */
  claudeDirs: string[];
}

/** Splits an env value holding several paths separated by ";". */
function splitList(value: string): string[] {
  return value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Home directories of WSL distros as seen from Windows (\\wsl.localhost\<distro>\home\<user>).
 * Returns [] when not on Windows or when WSL is not installed.
 */
export function wslHomes(): string[] {
  if (process.platform !== "win32") return [];
  let distros: string[];
  try {
    const out = Bun.spawnSync(["wsl.exe", "-l", "-q"]).stdout;
    // wsl.exe prints UTF-16LE with a BOM-less NUL between characters.
    distros = Buffer.from(out).toString("utf16le").replace(/\0/g, "").split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
  const homes: string[] = [];
  for (const distro of distros) {
    const root = `\\\\wsl.localhost\\${distro}\\home`;
    if (!existsSync(root)) continue;
    for (const user of readdirSync(root)) homes.push(join(root, user));
  }
  return homes;
}

export function defaultPaths(): Paths {
  const home = homedir();
  const winOpencode = join(home, ".local", "share", "opencode", "opencode.db");
  const winClaude = join(home, ".claude", "projects");
  const wsl = wslHomes();

  const opencodeDbs = process.env.CONVBRIDGE_OPENCODE_DB
    ? splitList(process.env.CONVBRIDGE_OPENCODE_DB)
    : [winOpencode, ...wsl.map((h) => join(h, ".local", "share", "opencode", "opencode.db"))];
  const claudeDirs = process.env.CONVBRIDGE_CLAUDE_DIR
    ? splitList(process.env.CONVBRIDGE_CLAUDE_DIR)
    : [winClaude, ...wsl.map((h) => join(h, ".claude", "projects"))];

  return {
    indexDir: process.env.CONVBRIDGE_HOME ?? join(home, ".convbridge"),
    opencodeDbs: [...new Set(opencodeDbs)],
    claudeDirs: [...new Set(claudeDirs)],
  };
}
