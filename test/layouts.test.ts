import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// (writeFileSync used by the concurrency and live-db tests)
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../src/index.ts";
import { isLive, localReadable, isRemote } from "../src/snapshot.ts";

let root: string;
let claudeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "convbridge-layouts-"));
  claudeDir = join(root, "claude");
  mkdirSync(claudeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// opencode 2.x layout, as found in WSL: session_v2 + session_message with seq.
function makeV2Db(path: string) {
  const db = new Database(path);
  db.exec(`
    create table session_v2 (id text primary key, directory text, title text,
      time_created integer, time_updated integer);
    create table session_message (id text primary key, session_id text, type text,
      seq integer, time_created integer, time_updated integer, data text);
  `);
  db.run("insert into session_v2 values ('ses_v2', '/home/mateo/app', 'Deploy en WSL', 1000, 2000)");
  const ins = db.query("insert into session_message values (?, ?, ?, ?, ?, ?, ?)");
  ins.run("a", "ses_v2", "user", 1, 1000, 1000, JSON.stringify({ text: "migrar el servicio a Postgres" }));
  ins.run(
    "b",
    "ses_v2",
    "assistant",
    2,
    1100,
    1100,
    JSON.stringify({ content: [{ type: "text", text: "Hecho con pg_dump." }, { type: "tool", name: "bash" }] }),
  );
  ins.run("c", "ses_v2", "idle", 3, 1200, 1200, JSON.stringify({}));
  db.close();
}

describe("concurrency and live databases", () => {
  test("two processes syncing the same index.db at once both succeed", async () => {
    // Separate processes, as in real use: one MCP server per session. Two Index objects in
    // one process would block each other, since busy_timeout waits on the same thread.
    const dbPath = join(root, "v2.db");
    makeV2Db(dbPath);
    const indexDir = join(root, "idx");
    const script = join(root, "sync-once.ts");
    const src = join(import.meta.dir, "..", "src", "index.ts");
    writeFileSync(
      script,
      `import { Index } from ${JSON.stringify(src)};
const idx = new Index({ indexDir: process.argv[2], opencodeDbs: [process.argv[3]], claudeDirs: [process.argv[4]] });
const r = await idx.sync(true);
console.log(JSON.stringify(r.errors));
idx.close();`,
    );
    const run = () =>
      Bun.spawn([process.execPath, "run", script, indexDir, dbPath, claudeDir], { stdout: "pipe", stderr: "pipe" });
    const procs = [run(), run()];
    const outs = await Promise.all(
      procs.map(async (p) => ({ code: await p.exited, out: (await new Response(p.stdout).text()).trim() })),
    );
    for (const o of outs) {
      expect(o.code).toBe(0);
      expect(o.out).toBe("[]");
    }
  }, 60_000);

  test("a db another process has open is read in place and reported", async () => {
    const dbPath = join(root, "live.db");
    makeV2Db(dbPath);
    const writer = new Database(dbPath);
    writer.exec("pragma journal_mode = wal");
    writer.run("insert into session_v2 values ('ses_live', '/x', 'Vivo', 3000, 4000)");
    const idx = new Index({ indexDir: join(root, "idx-live"), opencodeDbs: [dbPath], claudeDirs: [claudeDir] });
    const r = await idx.sync(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.opencodeSessions).toBeGreaterThan(0);
    idx.close();
    writer.close();
  });
});

describe("opencode layouts", () => {
  test("reads the 2.x layout (session_v2 + session_message)", async () => {
    const dbPath = join(root, "v2.db");
    makeV2Db(dbPath);
    const idx = new Index({ indexDir: join(root, "idx"), opencodeDbs: [dbPath], claudeDirs: [claudeDir] });
    const r = await idx.sync(true);
    expect(r.errors).toEqual([]);
    expect(r.opencodeTurns).toBe(2);
    expect(idx.search("Postgres")).toContain("opencode:ses_v2#1");
    expect(idx.get("opencode:ses_v2#2", 0)).toContain("[tool: bash]");
    idx.close();
  });

  test("reads several opencode databases in one sync", async () => {
    const a = join(root, "a.db");
    const b = join(root, "b.db");
    makeV2Db(a);
    makeV2Db(b);
    // Same session in both files: the index keeps one copy, nothing is duplicated.
    const idx = new Index({ indexDir: join(root, "idx"), opencodeDbs: [a, b], claudeDirs: [claudeDir] });
    await idx.sync(true);
    const n = idx.db.query("select count(*) n from sessions where source = 'opencode'").get() as { n: number };
    expect(n.n).toBe(1);
    idx.close();
  });

  test("a missing database is skipped without an error", async () => {
    const idx = new Index({
      indexDir: join(root, "idx"),
      opencodeDbs: [join(root, "does-not-exist.db")],
      claudeDirs: [claudeDir],
    });
    const r = await idx.sync(true);
    expect(r.errors).toEqual([]);
    expect(r.opencodeSessions).toBe(0);
    idx.close();
  });
});

describe("snapshot", () => {
  test("local paths are used in place", () => {
    const p = join(root, "local.db");
    writeFileSync(p, "");
    expect(isRemote(p)).toBe(false);
    expect(localReadable(p)).toBe(p);
  });

  test("UNC paths are detected as remote", () => {
    expect(isRemote("\\\\wsl.localhost\\Debian\\home\\x\\opencode.db")).toBe(true);
  });

  test("a -shm or -wal sibling means another connection is open", () => {
    const p = join(root, "live.db");
    writeFileSync(p, "");
    expect(isLive(p)).toBe(false);
    writeFileSync(p + "-shm", "");
    expect(isLive(p)).toBe(true);
  });

  test("a live local db is returned in place, never copied", () => {
    const p = join(root, "busy.db");
    writeFileSync(p, "");
    writeFileSync(p + "-wal", "");
    expect(localReadable(p)).toBe(p);
  });
});
