import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "../src/index.ts";
import { localReadable, isRemote } from "../src/snapshot.ts";

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
    expect(isRemote(p)).toBe(false);
    expect(localReadable(p, join(root, "snap"))).toBe(p);
  });

  test("UNC paths are detected as remote", () => {
    expect(isRemote("\\\\wsl.localhost\\Debian\\home\\x\\opencode.db")).toBe(true);
  });
});
