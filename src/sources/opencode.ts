import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { clean, isHarnessNoise, type Turn } from "../text.ts";

// Columns this reader depends on. If opencode changes the layout, the source is
// disabled with a SCHEMA_MISMATCH error instead of returning wrong data.
const REQUIRED: Record<string, string[]> = {
  session_v2: ["id", "directory", "title", "time_created", "time_updated"],
  session_message: ["session_id", "type", "seq", "time_created", "data"],
};

export interface OpencodeSession {
  id: string;
  title: string | null;
  cwd: string | null;
  started: number | null;
  updated: number;
}

export function openOpencode(path: string): Database | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const have = new Set(
      (db.query(`pragma table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
    );
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) {
      db.close();
      throw new Error(`SCHEMA_MISMATCH: ${table} missing ${missing.join(", ")}`);
    }
  }
  return db;
}

export function listOpencodeSessions(db: Database): OpencodeSession[] {
  const rows = db
    .query("select id, directory, title, time_created, time_updated from session_v2")
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    cwd: r.directory ?? null,
    started: r.time_created ?? null,
    updated: r.time_updated,
  }));
}

/** Messages with seq > afterSeq. Returns indexable turns plus the highest seq seen. */
export function opencodeMessagesAfter(
  db: Database,
  sessionId: string,
  afterSeq: number,
): { turns: Turn[]; lastSeq: number } {
  const rows = db
    .query(
      "select seq, type, time_created, data from session_message where session_id = ? and seq > ? order by seq",
    )
    .all(sessionId, afterSeq) as { seq: number; type: string; time_created: number; data: string }[];

  const turns: Turn[] = [];
  let lastSeq = afterSeq;
  for (const row of rows) {
    lastSeq = Math.max(lastSeq, row.seq);
    if (row.type !== "user" && row.type !== "assistant") continue;
    const text = extractText(row.type, JSON.parse(row.data));
    if (!text || isHarnessNoise(text)) continue;
    turns.push({ seq: row.seq, role: row.type, ts: row.time_created ?? null, text });
  }
  return { turns, lastSeq };
}

function extractText(type: string, data: any): string {
  if (type === "user") {
    return clean(typeof data.text === "string" ? data.text : "");
  }
  // assistant: content is an array of blocks: text | reasoning (skipped) | tool
  const blocks: any[] = Array.isArray(data.content) ? data.content : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "tool" && typeof b.name === "string") parts.push(`[tool: ${b.name}]`);
  }
  return clean(parts.join("\n"));
}
