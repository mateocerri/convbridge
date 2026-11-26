import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultPaths, type Paths } from "./config.ts";
import { redact } from "./redact.ts";
import { dayOf, MAX_TURN_CHARS, truncate, type Role, type Turn } from "./text.ts";
import { listClaudeFiles, parseClaudeChunk } from "./sources/claude.ts";
import {
  listOpencodeSessions,
  openOpencode,
  opencodeMessagesAfter,
  type OpencodeDb,
} from "./sources/opencode.ts";
import { isLive, localReadable } from "./snapshot.ts";

/** Wait for another process's write lock on index.db instead of failing with SQLITE_BUSY. */
const BUSY_MS = 60_000;

export type Source = "opencode" | "claude";

const RESYNC_MS = 30_000;
const SEARCH_CHAR_BUDGET = 6000;
const GET_CHAR_BUDGET = 4000;

export interface SyncReport {
  opencodeSessions: number;
  opencodeTurns: number;
  claudeFiles: number;
  claudeTurns: number;
  errors: string[];
  /** Databases another process has open right now; they are read in place, read-only. */
  warnings: string[];
}

export interface SearchOptions {
  source?: Source | "any";
  cwd?: string;
  since?: string;
  limit?: number;
}

export class Index {
  readonly db: Database;
  readonly paths: Paths;
  private lastSync = 0;
  private liveWarned = new Set<string>();

  constructor(paths: Paths = defaultPaths(), indexFile = "index.db") {
    this.paths = paths;
    mkdirSync(paths.indexDir, { recursive: true });
    this.db = new Database(join(paths.indexDir, indexFile));
    this.db.exec(`pragma busy_timeout = ${BUSY_MS}`);
    this.db.exec("pragma journal_mode = wal");
    this.db.exec(`
      create table if not exists sessions (
        source   text not null,
        id       text not null,
        title    text,
        cwd      text,
        started  integer,
        updated  integer,
        last_seq integer not null default 0,
        primary key (source, id)
      );
      create table if not exists turns (
        source     text not null,
        session_id text not null,
        seq        integer not null,
        role       text not null,
        ts         integer,
        text       text not null,
        primary key (source, session_id, seq)
      );
      create virtual table if not exists turns_fts using fts5(
        text, source unindexed, session_id unindexed,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      create table if not exists files (
        path       text primary key,
        source     text not null,
        session_id text,
        offset     integer not null default 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Incremental sync. Skips work if the last sync was recent, unless `force`. Syncs run one
   * at a time in this process, and each one is a single write transaction on index.db, so
   * other convbridge processes wait for the lock instead of interleaving writes.
   */
  sync(force = false): Promise<SyncReport> {
    const run = this.queue.then(() => this.syncOnce(force));
    this.queue = run.catch(() => {});
    return run;
  }

  private async syncOnce(force: boolean): Promise<SyncReport> {
    const report: SyncReport = {
      opencodeSessions: 0,
      opencodeTurns: 0,
      claudeFiles: 0,
      claudeTurns: 0,
      errors: [],
      warnings: [],
    };
    if (!force && Date.now() - this.lastSync < RESYNC_MS) return report;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.syncOpencode(report);
      await this.syncClaude(report);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    this.lastSync = Date.now();
    return report;
  }

  // ---------- opencode ----------

  private syncOpencode(report: SyncReport): void {
    for (const path of this.paths.opencodeDbs) {
      if (isLive(path)) {
        const msg = `${path}: en uso por otro proceso (hay -shm/-wal); leído en solo lectura, sin copia`;
        report.warnings.push(msg);
        // stderr, not stdout: stdout is the MCP channel. Logged once per path, not on every resync.
        if (!this.liveWarned.has(path)) {
          this.liveWarned.add(path);
          console.error("convbridge:", msg);
        }
      } else {
        this.liveWarned.delete(path);
      }
      const local = localReadable(path);
      if (!local || !existsSync(local)) continue;
      let src;
      try {
        src = openOpencode(local);
      } catch (e) {
        report.errors.push(`${path}: ${(e as Error).message}`);
        continue;
      }
      if (!src) continue;
      try {
        this.syncOpencodeDb(src, report);
      } finally {
        src.db.close();
      }
    }
  }

  private syncOpencodeDb(src: OpencodeDb, report: SyncReport): void {
    const getSession = this.db.query(
      "select updated, last_seq from sessions where source = 'opencode' and id = ?",
    );
    for (const s of listOpencodeSessions(src)) {
      const existing = getSession.get(s.id) as { updated: number; last_seq: number } | null;
      if (existing && existing.updated >= s.updated) continue;

      const { turns, lastSeq } = opencodeMessagesAfter(src, s.id, existing?.last_seq ?? 0);
      this.upsertSession("opencode", s.id, {
        title: s.title,
        cwd: s.cwd,
        started: s.started,
        updated: s.updated,
        lastSeq: Math.max(lastSeq, existing?.last_seq ?? 0),
      });
      report.opencodeTurns += this.addTurns("opencode", s.id, turns);
      report.opencodeSessions += 1;
    }
  }

  // ---------- Claude Code ----------

  private async syncClaude(report: SyncReport): Promise<void> {
    const files = [];
    for (const dir of this.paths.claudeDirs) {
      if (!existsSync(dir)) continue;
      files.push(...(await listClaudeFiles(dir)));
    }
    const getFile = this.db.query("select session_id, offset from files where path = ?");

    for (const f of files) {
      report.claudeFiles += 1;
      const prev = getFile.get(f.path) as { session_id: string | null; offset: number } | null;

      // File shrank (rewritten or truncated): drop what we had and reparse from zero.
      let offset = prev?.offset ?? 0;
      if (prev && f.size < offset) {
        if (prev.session_id) this.deleteSession("claude", prev.session_id);
        this.db.run("delete from files where path = ?", [f.path]);
        offset = 0;
      }
      if (f.size <= offset) continue;

      const bytes = new Uint8Array(await Bun.file(f.path).slice(offset, f.size).arrayBuffer());
      const fallbackId = f.path.split(/[\\/]/).pop()!.replace(/\.jsonl$/, "");
      const sessionId = prev?.session_id ?? null;
      const knownLast = sessionId
        ? ((this.db
            .query("select last_seq from sessions where source = 'claude' and id = ?")
            .get(sessionId) as { last_seq: number } | null)?.last_seq ?? 0)
        : 0;

      const chunk = parseClaudeChunk(bytes, knownLast);
      if (chunk.consumed === 0) continue; // only a partial line so far

      const id = sessionId ?? chunk.sessionId ?? fallbackId;
      const lastSeq = chunk.turns.at(-1)?.seq ?? knownLast;
      const existing = this.db
        .query("select title, cwd, started, updated from sessions where source = 'claude' and id = ?")
        .get(id) as
        | { title: string | null; cwd: string | null; started: number | null; updated: number | null }
        | null;
      // reduce, not Math.max(...spread): a long session has enough turns to
      // overflow the argument limit. A chunk with no turns (snapshots, titles)
      // must not bump `updated` to now, or it jumps to the top of `recent`.
      const turnStamp = chunk.turns.reduce((m, t) => Math.max(m, t.ts ?? 0), 0);
      const stamp = turnStamp || existing?.updated || Date.now();

      this.upsertSession("claude", id, {
        title: chunk.title ?? existing?.title ?? null,
        cwd: existing?.cwd ?? chunk.cwd,
        started: existing?.started ?? chunk.turns[0]?.ts ?? stamp,
        updated: stamp,
        lastSeq,
      });
      report.claudeTurns += this.addTurns("claude", id, chunk.turns);

      this.db.run(
        `insert into files (path, source, session_id, offset) values (?, 'claude', ?, ?)
         on conflict(path) do update set session_id = excluded.session_id, offset = excluded.offset`,
        [f.path, id, offset + chunk.consumed],
      );
    }
  }

  // ---------- writes ----------

  private upsertSession(
    source: Source,
    id: string,
    s: { title: string | null; cwd: string | null; started: number | null; updated: number; lastSeq: number },
  ): void {
    this.db.run(
      `insert into sessions (source, id, title, cwd, started, updated, last_seq)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(source, id) do update set
         title = excluded.title, cwd = excluded.cwd, started = excluded.started,
         updated = excluded.updated, last_seq = excluded.last_seq`,
      [source, id, s.title, s.cwd, s.started, s.updated, s.lastSeq],
    );
  }

  private addTurns(source: Source, sessionId: string, turns: Turn[]): number {
    if (turns.length === 0) return 0;
    const insTurn = this.db.query(
      "insert or replace into turns (source, session_id, seq, role, ts, text) values (?, ?, ?, ?, ?, ?)",
    );
    const insFts = this.db.query(
      "insert into turns_fts (rowid, text, source, session_id) values (?, ?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const t of turns) {
        const text = truncate(redact(t.text), MAX_TURN_CHARS);
        const res = insTurn.run(source, sessionId, t.seq, t.role, t.ts, text);
        insFts.run(res.lastInsertRowid, text, source, sessionId);
      }
    });
    tx();
    return turns.length;
  }

  private deleteSession(source: Source, id: string): void {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .query("select rowid from turns where source = ? and session_id = ?")
        .all(source, id) as { rowid: number }[];
      const delFts = this.db.query("delete from turns_fts where rowid = ?");
      for (const r of rows) delFts.run(r.rowid);
      this.db.run("delete from turns where source = ? and session_id = ?", [source, id]);
      this.db.run("delete from sessions where source = ? and id = ?", [source, id]);
    });
    tx();
  }

  // ---------- tools ----------

  search(query: string, opts: SearchOptions = {}): string {
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (terms.length === 0) return "No searchable terms in query.";

    const matchOf = (joiner: string) => terms.map((t) => `"${t}"*`).join(joiner);
    const where: string[] = ["turns_fts match ?"];
    const args: (string | number)[] = [matchOf(" AND ")];
    if (opts.source && opts.source !== "any") {
      where.push("t.source = ?");
      args.push(opts.source);
    }
    if (opts.cwd) {
      where.push("s.cwd like ?");
      args.push(`%${opts.cwd}%`);
    }
    if (opts.since) {
      const ms = Date.parse(opts.since);
      if (Number.isNaN(ms)) return `Invalid since: ${opts.since} (use ISO date, e.g. 2026-01-01).`;
      where.push("t.ts >= ?");
      args.push(ms);
    }
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
    args.push(limit);

    let rows: any[];
    let relaxed = false;
    try {
      const stmt = this.db.query(
        `select t.source, t.session_id, t.seq, t.role, t.ts, s.title, s.cwd,
                snippet(turns_fts, 0, '[', ']', '…', 24) as snip
         from turns_fts
         join turns t on t.rowid = turns_fts.rowid
         join sessions s on s.source = t.source and s.id = t.session_id
         where ${where.join(" and ")}
         order by bm25(turns_fts)
         limit ?`,
      );
      rows = stmt.all(...args);
      // Agents tend to send whole sentences, and requiring every word to
      // appear in one turn finds nothing. Retry with any-word matching;
      // bm25 still ranks turns containing more of the terms first.
      if (rows.length === 0 && terms.length > 1) {
        args[0] = matchOf(" OR ");
        rows = stmt.all(...args);
        relaxed = rows.length > 0;
      }
    } catch (e) {
      return `Search error: ${(e as Error).message}`;
    }
    if (rows.length === 0) return `No matches for "${query}".`;

    const out: string[] = [];
    if (relaxed) out.push("(no turn contains every term; showing partial matches)");
    let used = 0;
    let shown = 0;
    for (const r of rows) {
      const block =
        `${r.source}:${r.session_id}#${r.seq}  ${dayOf(r.ts)}  ${r.title ?? "(untitled)"}` +
        (r.cwd ? `  ${r.cwd}` : "") +
        `\n    ${String(r.snip).replace(/\n/g, " ")}`;
      if (used + block.length > SEARCH_CHAR_BUDGET) break;
      out.push(block);
      used += block.length;
      shown += 1;
    }
    if (shown < rows.length) out.push(`(${rows.length - shown} more hits omitted; narrow the query or raise limit)`);
    return out.join("\n");
  }

  get(ref: string, around = 3, maxChars = GET_CHAR_BUDGET, after?: number): string {
    const m = /^(opencode|claude):(.+)#(\d+)$/.exec(ref.trim());
    if (!m) return `Bad ref "${ref}". Expected <source>:<session_id>#<seq>.`;
    const [, source, sessionId, seqStr] = m as unknown as [string, Source, string, string];
    const seq = Number(seqStr);

    const session = this.db
      .query("select title, cwd from sessions where source = ? and id = ?")
      .get(source, sessionId) as { title: string | null; cwd: string | null } | null;
    if (!session) return `Unknown session ${source}:${sessionId}.`;

    const rows = (after !== undefined
      ? this.db
          .query(
            "select seq, role, ts, text from turns where source = ? and session_id = ? and seq > ? order by seq limit ?",
          )
          .all(source, sessionId, after, around * 2 + 1)
      : this.db
          .query(
            "select seq, role, ts, text from turns where source = ? and session_id = ? and seq between ? and ? order by seq",
          )
          .all(source, sessionId, Math.max(seq - around, 1), seq + around)) as {
      seq: number;
      role: Role;
      ts: number | null;
      text: string;
    }[];

    const header = `${source}:${sessionId}  ${session.title ?? "(untitled)"}${session.cwd ? `  ${session.cwd}` : ""}`;
    const lines: string[] = [header];
    let used = header.length;
    let lastShown = 0;
    let partial = false;
    for (const r of rows) {
      let block = `\n[${r.seq}] ${r.role} ${dayOf(r.ts)}\n${r.text}`;
      if (used + block.length > maxChars) {
        const room = maxChars - used - 2;
        if (room < 80) break; // not worth a fragment
        block = block.slice(0, room) + " …";
        lines.push(block);
        lastShown = r.seq; // rest of this turn is not resumable; avoids a paging loop
        partial = true;
        break;
      }
      lines.push(block);
      used += block.length;
      lastShown = r.seq;
    }
    if (partial) lines.push(`\n(turn ${lastShown} truncated by max_chars)`);
    if (lastShown && lastShown < (rows.at(-1)?.seq ?? 0)) {
      lines.push(`\n(more turns; next page: get with after=${lastShown})`);
    }
    if (rows.length === 0) lines.push("\n(no turns in window)");
    return lines.join("\n");
  }

  recent(opts: { source?: Source | "any"; cwd?: string; limit?: number } = {}): string {
    const where: string[] = ["1=1"];
    const args: (string | number)[] = [];
    if (opts.source && opts.source !== "any") {
      where.push("source = ?");
      args.push(opts.source);
    }
    if (opts.cwd) {
      where.push("cwd like ?");
      args.push(`%${opts.cwd}%`);
    }
    args.push(Math.min(Math.max(opts.limit ?? 10, 1), 50));
    const rows = this.db
      .query(
        `select source, id, title, cwd, updated from sessions where ${where.join(" and ")}
         order by updated desc limit ?`,
      )
      .all(...args) as any[];
    if (rows.length === 0) return "No sessions indexed.";
    return rows
      .map(
        (r) =>
          `${r.source}:${r.id}  ${dayOf(r.updated)}  ${r.title ?? "(untitled)"}${r.cwd ? `  ${r.cwd}` : ""}`,
      )
      .join("\n");
  }
}
