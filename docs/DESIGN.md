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

Skipped types include `api-request`, `api-request-blob`, `api-request-shape`, `file-history-snapshot`, `file-history-delta`, `attachment`, `mode`, `permission-mode`, `session-owner`, `atis-latch`, `last-prompt`, `cost-state`, and `system`. Each line carries `sessionId`, `timestamp`, `cwd` and `gitBranch`, which are used for filtering.

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
  n_turns    INTEGER,
  PRIMARY KEY (source, id)
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
  text,
  content='turns',
  tokenize='unicode61 remove_diacritics 2'
);
```

Notes:

- `remove_diacritics` lets queries without accents match accented Spanish and other text.
- Each turn's text is truncated to about 1500 characters at index time. Full text is still available through `get` only if it is kept; otherwise `get` returns the truncated text and says so.

### 3.1 Incremental indexing

- **opencode:** a session is re-read when `session_v2.time_updated` is newer than the stored `updated`. Only messages with `seq` greater than the stored maximum are inserted.
- **Claude Code:** each JSONL file is tracked by `(size, mtime)` plus the byte offset of the last fully parsed line. Only appended lines are parsed. A partial last line (no trailing newline) is left for the next pass.
- **Freshness:** the server reindexes on startup and before a search if the last reindex is older than 30 seconds.
- Sources are never modified. The opencode database is opened read-only.

### 3.2 Redaction

Applied to every turn before insertion:

- `sk-[A-Za-z0-9_-]{16,}` and similar API key prefixes.
- `Bearer <token>` headers.
- `(api[_-]?key|token|secret|password)\s*[:=]\s*\S+`.

Redaction is pattern-based and best-effort. Users should not rely on it as a security control.

## 4. Tool contracts

### 4.1 `search`

```
search(query: string, source?: "opencode" | "claude" | "any" = "any",
       cwd?: string, since?: string, limit?: number = 8)
```

- Uses FTS5 `bm25()` ranking.
- Groups hits by session; at most `limit` hits total.
- Each hit: `ref` (`<source>:<session_id>#<seq>`), date, title, cwd, and a snippet of about 200 characters with matched terms marked.
- Hard output cap: about 1500 tokens (roughly 6000 characters). Excess hits are dropped and the response says how many were omitted.

### 4.2 `get`

```
get(ref: string, around?: number = 3, max_chars?: number = 4000,
    after?: number, before?: number)
```

- Returns turns from the same session in the window `[seq - around, seq + around]`, or a page via `after`/`before` sequence numbers.
- Output is plain text with role labels, one turn per block.
- Stops at `max_chars` and returns a cursor for the next page.

### 4.3 `recent`

```
recent(source?: "opencode" | "claude" | "any" = "any", cwd?: string, limit?: number = 10)
```

- Lists sessions ordered by `updated`, with title, id and date. No turn text.

### 4.4 Errors

Errors are returned as short messages with a stable code, for example `SOURCE_UNAVAILABLE`, `SCHEMA_MISMATCH`, `UNKNOWN_REF`. A schema mismatch in opencode (for example after an upgrade) disables only the opencode source and reports it; Claude results are still returned.

## 5. Architecture

```
convbridge/
  src/
    server.ts             MCP over stdio (JSON-RPC 2.0, no external MCP SDK required)
    cli.ts                same core as CLI: reindex | search | get | recent
    index.ts              index creation, incremental update, FTS maintenance
    format.ts             snippets, token budgets, truncation
    redact.ts             secret redaction
    sources/
      opencode.ts         read-only reader for opencode.db (checks table shape first)
      claude.ts           JSONL reader with byte-offset tracking
  test/
    fixtures/             minimal opencode.db and JSONL samples
    *.test.ts
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

- License (required before public release).
- Whether to ship a Claude Code plugin package instead of the `claude mcp add` instruction.
- Whether to support additional source tools later. The source layer is isolated to make this possible.
- Schema drift: opencode's table layout may change between versions. The reader validates expected columns at startup and degrades gracefully.
