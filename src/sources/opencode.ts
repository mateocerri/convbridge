import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { clean, isHarnessNoise, type Turn } from "../text.ts";

// opencode has changed its SQLite layout between releases. Two layouts are supported:
//   v2 (opencode 2.x):   session_v2 + session_message (ordered by seq, data holds the blocks)
//   v1 (opencode 1.14):  session + message (role in data) + part (one row per block)
// The layout is detected from the tables present. If the expected columns are missing,
// the source is disabled with a SCHEMA_MISMATCH error instead of returning wrong data.
type Layout = "v2" | "v1";

const REQUIRED: Record<Layout, Record<string, string[]>> = {
  v2: {
    session_v2: ["id", "directory", "title", "time_created", "time_updated"],
    session_message: ["session_id", "type", "seq", "time_created", "data"],
  },
  v1: {
    session: ["id", "directory", "title", "time_created", "time_updated"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["message_id", "session_id", "time_created", "data"],
  },
};

export interface OpencodeDb {
  db: Database;
  layout: Layout;
}

export interface OpencodeSession {
  id: string;
  title: string | null;
  cwd: string | null;
  started: number | null;
  updated: number;
}

function columnsOf(db: Database, table: string): Set<string> {
  return new Set(
    (db.query(`pragma table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
  );
}

export function openOpencode(path: string): OpencodeDb | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  const tables = new Set(
    (db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const layout: Layout | null = tables.has("session_v2") ? "v2" : tables.has("session") ? "v1" : null;
  if (!layout) {
    db.close();
    throw new Error("SCHEMA_MISMATCH: no known opencode session table");
  }
  for (const [table, cols] of Object.entries(REQUIRED[layout])) {
    const have = columnsOf(db, table);
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) {
      db.close();
      throw new Error(`SCHEMA_MISMATCH: ${table} missing ${missing.join(", ")}`);
    }
  }
  return { db, layout };
}

export function listOpencodeSessions(src: OpencodeDb): OpencodeSession[] {
  const table = src.layout === "v2" ? "session_v2" : "session";
  const rows = src.db
    .query(`select id, directory, title, time_created, time_updated from ${table}`)
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    cwd: r.directory ?? null,
    started: r.time_created ?? null,
    updated: r.time_updated,
  }));
}

/**
 * Messages with seq > afterSeq. Returns indexable turns plus the highest seq seen.
 * v2 has a stored seq. v1 has none, so seq is the 1-based position of the message in
 * the session ordered by creation time; new messages are appended, so positions are stable.
 */
export function opencodeMessagesAfter(
  src: OpencodeDb,
  sessionId: string,
  afterSeq: number,
): { turns: Turn[]; lastSeq: number } {
  return src.layout === "v2" ? messagesV2(src.db, sessionId, afterSeq) : messagesV1(src.db, sessionId, afterSeq);
}

function messagesV2(db: Database, sessionId: string, afterSeq: number) {
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
    const text = extractTextV2(row.type, JSON.parse(row.data));
    if (!text || isHarnessNoise(text)) continue;
    turns.push({ seq: row.seq, role: row.type, ts: row.time_created ?? null, text });
  }
  return { turns, lastSeq };
}

function messagesV1(db: Database, sessionId: string, afterSeq: number) {
  const messages = db
    .query(
      `select seq, id, time_created, role from (
         select row_number() over (order by time_created, id) as seq,
                id, time_created, json_extract(data, '$.role') as role
         from message where session_id = ?
       ) where seq > ? order by seq`,
    )
    .all(sessionId, afterSeq) as { seq: number; id: string; time_created: number; role: string }[];

  const lastSeq = messages.reduce((m, r) => Math.max(m, r.seq), afterSeq);
  if (messages.length === 0) return { turns: [], lastSeq };

  const wanted = new Set(messages.map((m) => m.id));
  const parts = db
    .query("select message_id, data from part where session_id = ? order by time_created, id")
    .all(sessionId) as { message_id: string; data: string }[];
  const byMessage = new Map<string, any[]>();
  for (const p of parts) {
    if (!wanted.has(p.message_id)) continue;
    const list = byMessage.get(p.message_id) ?? [];
    list.push(JSON.parse(p.data));
    byMessage.set(p.message_id, list);
  }

  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = extractTextV1(m.role, byMessage.get(m.id) ?? []);
    if (!text || isHarnessNoise(text)) continue;
    turns.push({ seq: m.seq, role: m.role, ts: m.time_created ?? null, text });
  }
  return { turns, lastSeq };
}

function extractTextV2(type: string, data: any): string {
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

function extractTextV1(role: string, parts: any[]): string {
  const out: string[] = [];
  for (const p of parts) {
    // Parts flagged synthetic are generated by the harness, not written by a person or model.
    if (p.synthetic === true) continue;
    if (p.type === "text" && typeof p.text === "string") out.push(p.text);
    else if (role === "assistant" && p.type === "tool" && typeof p.tool === "string") {
      out.push(`[tool: ${p.tool}]`);
    }
    // reasoning, step-start/finish, patch, file, compaction: skipped
  }
  return clean(out.join("\n"));
}
