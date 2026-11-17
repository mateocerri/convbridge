import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  /** Directory holding the convbridge index. */
  indexDir: string;
  /** opencode SQLite database (opened read-only). */
  opencodeDb: string;
  /** Directory containing Claude Code project folders with *.jsonl sessions. */
  claudeDir: string;
}

export function defaultPaths(): Paths {
  return {
    indexDir: process.env.CONVBRIDGE_HOME ?? join(homedir(), ".convbridge"),
    opencodeDb:
      process.env.CONVBRIDGE_OPENCODE_DB ??
      join(homedir(), ".local", "share", "opencode", "opencode.db"),
    claudeDir: process.env.CONVBRIDGE_CLAUDE_DIR ?? join(homedir(), ".claude", "projects"),
  };
}
