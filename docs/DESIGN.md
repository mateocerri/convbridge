# convbridge design

This document describes the architecture, data model, tool contracts and verification plan for `convbridge`.

## 1. Goals and non-goals

**Goals**

- Let an agent in either tool find and read relevant turns from sessions in the other tool.
- Keep every tool response small by default and progressive in detail (`search` -> `get`).
- Never write to the source stores.
- Work offline with a single runtime dependency (Bun).

**Non-goals (v1)**

- Semantic / embedding search.
- Editing or deleting sessions.
- Syncing between machines.
- Indexing tool outputs or reasoning blocks.

## 2. Source formats

### 2.1 opencode

Location: `~/.local/share/opencode/opencode.db` (SQLite, WAL mode). Opened with `readonly` access.

Relevant tables:

| Table | Use | Key columns |
| --- | --- | --- |
| `session_v2` | Session metadata | `id`, `directory`, `title`, `time_created`, `time_updated`, `model` |
| `session_message` | One row per message | `id`, `session_id`, `type`, `seq`, `time_created`, `data` (JSON) |

`session_part` exists but is empty in the tested version and is not used.

Message types:

| `type` | Indexed | Content |
| --- | --- | --- |
| `user` | yes | `data.text` |
| `assistant` | yes (text blocks only) | `data.content[]`, blocks of type `text`, `reasoning` or `tool` |
| `compaction` | no | Auto-generated summary |
| `system`, `synthetic` | no | Harness notices and injected instructions |
| `agent-switched`, `model-switched`, `idle` | no | Metadata |

Tool blocks are reduced to a single line (`tool: <name>`). Reasoning blocks are skipped.

### 2.2 Claude Code

Location: `~/.claude/projects/<project-slug>/<session-id>.jsonl`. One JSON object per line.

Relevant line types:

| `type` | Indexed | Notes |
| --- | --- | --- |
| `user` | yes | `message.content` is a string or an array of blocks |
| `assistant` | yes (text blocks only) | Same block handling as opencode |
| `ai-title` | used for titles | Generated session title |

Only `user` and `assistant` lines are turns; every other type (API request blobs, file history snapshots, attachments, mode and cost state, system lines) is ignored. Lines flagged `isMeta` are skipped, as are turns whose text starts with `<system-reminder>`, `<command-` or `<local-command-`. Tool use blocks become `[tool: <name>]`; tool results and thinking blocks are dropped. Each line carries `sessionId`, `timestamp` and `cwd`, which are used for filtering.

## 3. Index

Location: `~/.convbridge/index.db` (overridable with `CONVBRIDGE_HOME`).

```sql
CREATE TABLE sessions (
  source     TEXT NOT NULL,      -- 'opencode' | 'claude'
  id         TEXT NOT NULL,
  title      TEXT,
  cwd        TEXT,
  started    INTEGER,            -- unix ms
  updated    INTEGER,            -- unix ms
  last_seq   INTEGER NOT NULL DEFAULT 0,  -- highest seq indexed so far
  PRIMARY KEY (source, id)
);

CREATE TABLE files (             -- Claude JSONL read progress
  path       TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  session_id TEXT,
  offset     INTEGER NOT NULL DEFAULT 0   -- byte offset past the last parsed line
);

CREATE TABLE turns (
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,   -- order within the session
  role       TEXT NOT NULL,      -- 'user' | 'assistant'
  ts         INTEGER,
  text       TEXT NOT NULL,      -- cleaned, redacted, truncated
  PRIMARY KEY (source, session_id, seq)
);

CREATE VIRTUAL TABLE turns_fts USING fts5(
  text, source UNINDEXED, session_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);   -- rowid matches turns.rowid
```

Notes:

- `remove_diacritics` lets queries without accents match accented Spanish and other text.
- Each turn's text is truncated to 1500 characters at index time (after redaction). `get` can only return the truncated text.

### 3.1 Incremental indexing

- **opencode:** a session is re-read when `session_v2.time_updated` is newer than the stored `updated`. Only messages with `seq` greater than the stored maximum are inserted.
- **Claude Code:** each JSONL file is tracked by the byte offset of the last fully parsed line (`files` table). Only appended bytes are read. A partial last line (no trailing newline) is left for the next pass. If a file becomes smaller than its stored offset, the session is deleted from the index and reparsed from zero.
- A sync pass that adds no turns does not change a session's `updated`, so snapshot-only writes do not reorder `recent`.
- **Freshness:** the server reindexes on startup and before a search if the last reindex is older than 30 seconds.
- Sources are never modified. The opencode database is opened read-only.

### 3.2 Redaction

Applied to every turn before insertion (see `src/redact.ts` for the exact patterns):

- PEM private key blocks.
- `sk-` keys, GitHub tokens (`ghp_`, `github_pat_`, ...), AWS access key ids, Slack tokens, Google API keys.
- JWTs and `Bearer <token>` headers.
- Credentials embedded in URLs (`scheme://user:pass@host`).
- `api_key` / `token` / `secret` / `password` assignments with `:` or `=`, including quoted JSON values.

Redaction is pattern-based and best-effort. Users should not rely on it as a security control.

## 4. Tool contracts

### 4.1 `search`

```
search(query: string, source?: "opencode" | "claude" | "any" = "any",
       cwd?: string, since?: string, limit?: number = 8)
```

- Query words are extracted (letters and digits) and each is matched as a prefix. All words must appear in the same turn.
- If that finds nothing and the query has several words, the search retries with any-word matching and says so in the output.
- Uses FTS5 `bm25()` ranking. At most `limit` hits (1 to 50).
- Each hit: `ref` (`<source>:<session_id>#<seq>`), date, title, cwd, and a snippet of up to 24 tokens with matched terms in `[brackets]`.
- Output cap: 6000 characters. Excess hits are dropped and the response says how many were omitted.

### 4.2 `get`

```
get(ref: string, around?: number = 3, max_chars?: number = 4000,
    after?: number)
```

- Returns turns from the same session in the window `[seq - around, seq + around]`, or, with `after`, the next `2 * around + 1` turns after that sequence number.
- Output is plain text with a header line and one block per turn (`[seq] role date`).
- Stops at `max_chars`. A turn cut by the cap is marked, and when more turns exist the output ends with `next page: get with after=<seq>`.

### 4.3 `recent`

```
recent(source?: "opencode" | "claude" | "any" = "any", cwd?: string, limit?: number = 10)
```

- Lists sessions ordered by `updated`, with title, id and date. No turn text.

### 4.4 Errors

Tool errors are returned as short plain-text messages (bad ref, unknown session, invalid `since`, search syntax error). Unexpected exceptions come back as `Error: <message>` with `isError` set. A schema mismatch in opencode (for example after an upgrade) skips only the opencode source and is reported by `reindex`; Claude results are still returned.

## 5. Architecture

```
convbridge/
  src/
    server.ts             MCP over stdio (JSON-RPC 2.0, no external MCP SDK required)
    cli.ts                same core as CLI: reindex | search | get | recent
    index.ts              index schema, incremental sync, search / get / recent, output budgets
    config.ts             default paths and CONVBRIDGE_* environment variables
    text.ts               cleaning, truncation, harness-noise filter
    redact.ts             secret redaction
    sources/
      opencode.ts         read-only reader for opencode.db (checks table shape first)
      claude.ts           JSONL reader with byte-offset tracking
  test/
    convbridge.test.ts    fixtures are generated in temp directories
  docs/
    DESIGN.md
```

The MCP server and the CLI share one core. The CLI exists for debugging and for use outside an agent.

## 6. Client integration

- **Claude Code:** registered with `claude mcp add --scope user`.
- **opencode:** registered under `mcp.servers` in the opencode configuration, using the same local-server format as other MCP servers in that file.

Optional: a one-line instruction in each tool's global agent instructions telling the agent to use `convbridge.search` before reading any session store directly. This is left to the user.

## 7. Verification

1. **Unit tests (`bun test`)**
   - Fixture opencode database created in a temp directory with the same table definitions. Checks: message filtering by type, block reduction, read-only opening.
   - Fixture JSONL with noise lines. Checks: noise types are dropped, title is taken from `ai-title`.
   - FTS: a query without accents matches accented text.
   - Incremental: reindexing an unchanged source inserts zero rows; appending lines to a JSONL inserts only the new turns; a partial last line is deferred.
   - Redaction: each pattern is replaced.
   - Output budgets: `search` and `get` never exceed their caps.
2. **Real data (manual)**
   - `bun run reindex` completes; session counts are reported per source.
   - A known opencode session title is found by `search`.
   - A known Claude session is found by `search` on a distinctive term.
3. **Integration (manual)**
   - `claude mcp list` shows `convbridge` as connected.
   - opencode lists the `convbridge` tools.
   - A cross-tool query works from each side.
4. **Store integrity**
   - Source file modification times are unchanged after indexing.

## 8. Open decisions

- Whether to ship a Claude Code plugin package instead of the `claude mcp add` instruction.
- Whether to support additional source tools later. The source layer is isolated to make this possible.
- Schema drift: opencode's table layout may change between versions. The reader validates expected columns at startup and degrades gracefully.
