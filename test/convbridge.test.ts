import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../src/index.ts";
import { redact } from "../src/redact.ts";
import { parseClaudeChunk } from "../src/sources/claude.ts";

let root: string;
let opencodeDb: string;
let claudeDir: string;
let projDir: string;

function makeOpencodeDb(path: string) {
  const db = new Database(path);
  db.exec(`
    create table session_v2 (id text primary key, directory text, title text,
      time_created integer, time_updated integer);
    create table session_message (id text primary key, session_id text, type text,
      seq integer, time_created integer, data text);
    create table session_part (message_id text, ordinal integer);
  `);
  db.run("insert into session_v2 values ('ses_1', '/work/morph', 'Lanzamiento Morph', 1000, 2000)");
  const ins = db.query("insert into session_message values (?, ?, ?, ?, ?, ?)");
  ins.run("m1", "ses_1", "user", 1, 1000, JSON.stringify({ text: "Revisemos la renderización a 1080p" }));
  ins.run(
    "m2",
    "ses_1",
    "assistant",
    2,
    1100,
    JSON.stringify({
      content: [
        { type: "reasoning", text: "PRIVATE CHAIN OF THOUGHT" },
        { type: "text", text: "Usar DRS con blit fullscreen." },
        { type: "tool", name: "execute" },
      ],
    }),
  );
  ins.run("m3", "ses_1", "compaction", 3, 1200, JSON.stringify({ text: "auto summary" }));
  ins.run("m4", "ses_1", "system", 4, 1300, JSON.stringify({ text: "Today's date is now" }));
  db.close();
}

function claudeLine(obj: object): string {
  return JSON.stringify(obj) + "\n";
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "convbridge-"));
  opencodeDb = join(root, "opencode.db");
  claudeDir = join(root, "claude");
  projDir = join(claudeDir, "C--work");
  mkdirSync(projDir, { recursive: true });
  makeOpencodeDb(opencodeDb);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function newIndex(): Index {
  return new Index({ indexDir: join(root, "idx"), opencodeDb, claudeDir });
}

describe("opencode source", () => {
  test("indexes user and assistant text only, drops reasoning and noise", async () => {
    const idx = newIndex();
    const r = await idx.sync(true);
    expect(r.errors).toEqual([]);
    expect(r.opencodeTurns).toBe(2);

    const rows = idx.db.query("select role, text from turns order by seq").all() as any[];
    expect(rows.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(rows[1].text).toContain("[tool: execute]");
    expect(idx.search("PRIVATE chain")).toMatch(/No matches/);
    idx.close();
  });

  test("schema mismatch disables the source without throwing", async () => {
    const bad = join(root, "bad.db");
    const db = new Database(bad);
    db.exec("create table session_v2 (id text);");
    db.close();
    const idx = new Index({ indexDir: join(root, "idx2"), opencodeDb: bad, claudeDir });
    const r = await idx.sync(true);
    expect(r.errors[0]).toContain("SCHEMA_MISMATCH");
    idx.close();
  });
});

describe("search", () => {
  test("matches words without accents", async () => {
    const idx = newIndex();
    await idx.sync(true);
    const out = idx.search("renderizacion");
    expect(out).toContain("opencode:ses_1#1");
    expect(out).toContain("Lanzamiento Morph");
    idx.close();
  });

  test("source filter excludes other tool", async () => {
    const idx = newIndex();
    await idx.sync(true);
    expect(idx.search("renderizacion", { source: "claude" })).toMatch(/No matches/);
    idx.close();
  });
});

describe("get", () => {
  test("returns window around a ref", async () => {
    const idx = newIndex();
    await idx.sync(true);
    const out = idx.get("opencode:ses_1#1", 3);
    expect(out).toContain("[1] user");
    expect(out).toContain("[2] assistant");
    idx.close();
  });

  test("rejects malformed refs", () => {
    const idx = newIndex();
    expect(idx.get("nope")).toMatch(/Bad ref/);
    idx.close();
  });
});

describe("claude source", () => {
  function writeClaudeSession(name: string, lines: string[]) {
    writeFileSync(join(projDir, `${name}.jsonl`), lines.join(""));
  }

  test("drops noise types, takes ai-title, reads text blocks", async () => {
    const sid = "11111111-aaaa-bbbb-cccc-000000000001";
    writeClaudeSession(sid, [
      claudeLine({ type: "file-history-snapshot", sessionId: sid }),
      claudeLine({ type: "api-request-blob", sessionId: sid, blob: "x".repeat(50) }),
      claudeLine({
        type: "user", sessionId: sid, cwd: "C:\\work", timestamp: "2026-11-01T10:00:00Z",
        message: { role: "user", content: "Buscar el bug de tokens" },
      }),
      claudeLine({
        type: "assistant", sessionId: sid, timestamp: "2026-11-01T10:00:05Z",
        message: { role: "assistant", content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "El bug está en el refresh." },
          { type: "tool_use", name: "Read" },
        ] },
      }),
      claudeLine({ type: "ai-title", sessionId: sid, aiTitle: "Bug de tokens" }),
    ]);
    const idx = newIndex();
    const r = await idx.sync(true);
    expect(r.claudeTurns).toBe(2);
    expect(idx.search("refresh")).toContain(`claude:${sid}#2`);
    expect(idx.search("hidden")).toMatch(/No matches/);
    expect(idx.recent({ source: "claude" })).toContain("Bug de tokens");
    idx.close();
  });

  test("incremental: no-op when unchanged, appends only new turns", async () => {
    const sid = "22222222-aaaa-bbbb-cccc-000000000002";
    const file = join(projDir, `${sid}.jsonl`);
    writeFileSync(file, claudeLine({ type: "user", sessionId: sid, message: { content: "primera" } }));
    const idx = newIndex();
    expect((await idx.sync(true)).claudeTurns).toBe(1);
    expect((await idx.sync(true)).claudeTurns).toBe(0);

    appendFileSync(file, claudeLine({ type: "user", sessionId: sid, message: { content: "segunda" } }));
    expect((await idx.sync(true)).claudeTurns).toBe(1);
    expect(idx.search("segunda")).toContain(`claude:${sid}#2`);
    idx.close();
  });

  test("partial trailing line is deferred until newline arrives", () => {
    const full = new TextEncoder().encode(
      claudeLine({ type: "user", message: { content: "uno" } }) + '{"type":"user","message":{"content":"do',
    );
    const first = parseClaudeChunk(full, 0);
    expect(first.turns.map((t) => t.text)).toEqual(["uno"]);
    expect(first.consumed).toBeLessThan(full.length);
  });
});

describe("redact", () => {
  test("masks common secret shapes", () => {
    expect(redact("key sk-abcdefghijklmnopqrstu1234")).toBe("key [REDACTED_KEY]");
    expect(redact("Authorization: Bearer abcdefghij123456")).toContain("Bearer [REDACTED]");
    expect(redact("api_key=hunter2")).toBe("api_key=[REDACTED]");
    expect(redact("task-manager is fine")).toBe("task-manager is fine");
  });

  test("masks JSON-style, token-prefixed, PEM and URL-embedded secrets", () => {
    expect(redact('{"password": "hunter2", "user": "me"}')).toBe('{"password": [REDACTED], "user": "me"}');
    expect(redact("export TOKEN='abc def'")).toBe("export TOKEN=[REDACTED]");
    expect(redact("gh auth: ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("gh auth: [REDACTED_KEY]");
    expect(redact("id AKIAABCDEFGHIJKLMNOP here")).toBe("id [REDACTED_KEY] here");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).toBe(
      "[REDACTED_PRIVATE_KEY]",
    );
    expect(redact("git clone https://me:s3cret@github.com/x/y.git")).toBe(
      "git clone https://[REDACTED]@github.com/x/y.git",
    );
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw")).toBe("[REDACTED_JWT]");
  });
});

describe("search relaxation", () => {
  test("a sentence whose words never share one turn still finds the best partial matches", async () => {
    const idx = newIndex();
    await idx.sync(true);
    // "renderizacion" is in turn 1 and "blit" in turn 2; no single turn has both
    const out = idx.search("renderizacion blit");
    expect(out).toContain("partial matches");
    expect(out).toContain("opencode:ses_1#1");
    expect(out).toContain("opencode:ses_1#2");
    idx.close();
  });

  test("when every term matches, no relaxation note is shown", async () => {
    const idx = newIndex();
    await idx.sync(true);
    expect(idx.search("usar drs")).not.toContain("partial matches");
    idx.close();
  });
});

describe("claude sync does not fake activity", () => {
  test("appending only non-turn lines leaves the session's updated time alone", async () => {
    const sid = "22222222-aaaa-bbbb-cccc-000000000002";
    const file = join(projDir, `${sid}.jsonl`);
    writeFileSync(
      file,
      claudeLine({
        type: "user", sessionId: sid, cwd: "C:\\work", timestamp: "2026-11-01T10:00:00Z",
        message: { role: "user", content: "hola mundo" },
      }),
    );
    const idx = newIndex();
    await idx.sync(true);
    const before = (idx.db.query("select updated from sessions where id = ?").get(sid) as any).updated;
    expect(before).toBe(Date.parse("2026-11-01T10:00:00Z"));

    appendFileSync(file, claudeLine({ type: "file-history-snapshot", sessionId: sid }));
    await idx.sync(true);
    const after = (idx.db.query("select updated from sessions where id = ?").get(sid) as any).updated;
    expect(after).toBe(before);
    idx.close();
  });
});
