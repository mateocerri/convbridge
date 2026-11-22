# convbridge

Search conversations from **opencode** and **Claude Code** from either tool, without letting one agent read the other's raw storage.

`convbridge` is a small local [MCP](https://modelcontextprotocol.io) server. It builds its own full-text index from both tools' session data and exposes three compact tools: `search`, `get` and `recent`. An agent asks a question, receives a few ranked snippets, and reads more only when needed. Nothing is dumped into context by default.

- Local only: no network access, no external services.
- Read-only on the source stores. It only writes its own index.
- One runtime dependency: [Bun](https://bun.sh). No npm packages, no MCP SDK.
- Best-effort secret redaction before anything is indexed.

> Status: v0.1.0. Working MCP server and CLI, covered by unit tests. See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.

## Why

- opencode stores sessions in SQLite (`opencode.db`), with many message parts per turn.
- Claude Code stores sessions as JSONL files, with a lot of non-conversational noise (file snapshots, API request blobs, attachments).
- An agent that needs to recall a discussion held in the other tool would have to open these stores directly. That fills the context window with mostly irrelevant data.

| Without convbridge | With convbridge |
| --- | --- |
| Agent opens raw SQLite / JSONL | Agent calls `search` with a query |
| Thousands of rows enter context | A few ranked snippets enter context |
| Agent guesses the schema | Schema is handled once, inside the server |

## Requirements

- [Bun](https://bun.sh) >= 1.1 (uses the built-in `bun:sqlite` module with FTS5). Node is not supported.
- opencode and/or Claude Code installed locally with existing sessions. Either one alone is enough.

## Installation

```sh
git clone https://github.com/mateocerri/convbridge.git
cd convbridge
bun run reindex        # optional: build the index now instead of on first use
```

### Claude Code

```sh
claude mcp add --scope user convbridge -- bun run /absolute/path/to/convbridge/src/server.ts
```

Check it with `claude mcp list`. `convbridge` should show as connected.

### opencode

Add an entry under `mcp.servers` in your opencode config:

```json
{
  "mcp": {
    "servers": {
      "convbridge": {
        "type": "local",
        "command": ["bun", "run", "/absolute/path/to/convbridge/src/server.ts"]
      }
    }
  }
}
```

On Windows use the full path with escaped backslashes (`C:\\Users\\you\\convbridge\\src\\server.ts`).

### Optional: tell your agent to use it

Add one line to each tool's global agent instructions, for example:

> To recall past conversations from opencode or Claude Code, use the `convbridge` tools (`search`, then `get`) instead of reading session files directly.

## Tools

| Tool | Purpose | Output |
| --- | --- | --- |
| `search(query, source?, cwd?, since?, limit?)` | Full-text (BM25) search over user and assistant text | Ranked hits, each with a `ref`, date, title, working directory and a short snippet |
| `get(ref, around?, max_chars?, after?)` | Read the turns around a hit | A bounded window of cleaned text, with a paging hint |
| `recent(source?, cwd?, limit?)` | List the latest sessions | `ref`-style id, date, title, working directory |

Typical flow: `search` or `recent` to locate a session, then `get` on the one hit that matters.

### `search`

| Parameter | Default | Notes |
| --- | --- | --- |
| `query` | required | Words to look for. Accents are ignored, and each word matches as a prefix. |
| `source` | `any` | `opencode`, `claude` or `any`. |
| `cwd` | none | Substring of the session's working directory. |
| `since` | none | ISO date, for example `2026-01-01`. |
| `limit` | `8` | 1 to 50. |

All words must appear in the same turn. If no turn contains every word, the search retries with any-word matching, ranks turns with more matching words first, and says so in the output. Output is capped at about 6000 characters; omitted hits are counted.

Example output:

```
claude:3f2a9c1e-...#14  2026-03-02  Release plan  /home/me/projects/app
    ...agreed to cut the [release] on Friday after the [plan] review...
```

### `get`

| Parameter | Default | Notes |
| --- | --- | --- |
| `ref` | required | `<source>:<session_id>#<seq>`, as returned by `search`. |
| `around` | `3` | Turns before and after the hit (0 to 20). |
| `max_chars` | `4000` | Output cap (500 to 20000). A turn cut by the cap is marked. |
| `after` | none | Return turns with `seq` greater than this. Use it to page forward. |

When more turns are available, the output ends with `next page: get with after=<seq>`.

### `recent`

Lists sessions ordered by last update. Same `source` and `cwd` filters as `search`; `limit` defaults to 10 (max 50). It returns no turn text.

## CLI

The CLI uses the same core as the server. It is useful for debugging and for use outside an agent.

```sh
bun run src/cli.ts reindex
bun run src/cli.ts search "release plan" --source claude --limit 5
bun run src/cli.ts get "claude:<session-id>#26" --around 2 --max-chars 2000
bun run src/cli.ts recent --source opencode --limit 10
```

`bun run reindex` is a shortcut for the first command. `reindex` forces a full incremental pass and reports how many sessions and turns were added per source.

## How it works

- **Sources.** All opencode databases found on the machine are read: the Windows one (`~/.local/share/opencode/opencode.db`) and one per WSL distro home (`//wsl.localhost/<distro>/home/<user>/.local/share/opencode/opencode.db`). Claude Code sessions come from every `.claude/projects` directory found the same way, as `<project-slug>/<session-id>.jsonl`. WSL distros are discovered with `wsl.exe -l -q`.
- **opencode layouts.** Both the 1.x layout (`session`, `message`, `part`) and the 2.x layout (`session_v2`, `session_message`) are supported, detected from the tables present.
- **Databases on WSL.** While opencode runs in WSL, its database cannot be opened in place from Windows (`database is locked`). convbridge keeps a verified copy in `~/.convbridge/snapshots/` and refreshes it at most every 10 minutes, so WSL sessions can be up to about 10 minutes behind.
- **What is indexed.** User and assistant text. Tool calls are reduced to a line like `[tool: Bash]`. Tool results, reasoning blocks, system, hook and synthetic messages are skipped. Each turn is truncated to about 1500 characters.
- **Index.** A SQLite database with an FTS5 table (`unicode61`, diacritics removed), stored at `~/.convbridge/index.db`.
- **Incremental.** opencode sessions are re-read only when their `time_updated` changes. Claude files are read from the last parsed byte offset, and a partial last line waits for the next pass. A Claude file that shrinks is dropped and reparsed.
- **Freshness.** The server indexes in the background on startup and re-syncs before a tool call if the last sync is older than 30 seconds.
- **Schema drift.** The opencode reader checks the expected tables and columns first. If they do not match, that source is skipped and the error is reported; Claude Code results still work.

## Configuration

All settings are optional environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONVBRIDGE_HOME` | `~/.convbridge` | Directory for the index database |
| `CONVBRIDGE_OPENCODE_DB` | Windows db plus each WSL distro home | opencode database paths, separated by `;`. Replaces the default list when set. |
| `CONVBRIDGE_CLAUDE_DIR` | Windows `~/.claude/projects` plus each WSL distro home | Claude Code projects directories, separated by `;`. Replaces the default list when set. |

## Privacy and security

- All processing is local. Nothing is sent anywhere.
- **The index contains your conversation text.** Treat `~/.convbridge/index.db` as sensitive, and keep it out of repositories and backups you share.
- Redaction runs on every turn before indexing and covers private key blocks, `sk-` keys, GitHub tokens, AWS access key ids, Slack tokens, Google API keys, JWTs, `Bearer` tokens, credentials inside URLs, and `api_key` / `token` / `secret` / `password` assignments (including JSON).
- Redaction is pattern-based and **best-effort**. It reduces leaks; it does not guarantee that no secret is indexed. Do not use it as a security control.
- Any agent that has the `convbridge` tools can read indexed text from all your sessions, across projects. Only register it in tools you trust with that history.

## Limitations

- Keyword search only (BM25). No semantic or embedding search.
- Only opencode and Claude Code are supported. The source layer is isolated in `src/sources/` to make adding more possible.
- The opencode schema is not a public contract and may change between versions.
- Turn text is truncated at index time, so `get` cannot return the full original text of a long turn.

## Development

```sh
bun test
```

Tests use fixture databases and JSONL files and do not touch real session data.

```
src/
  server.ts        MCP server over stdio (JSON-RPC 2.0)
  cli.ts           CLI entry point
  index.ts         index schema, incremental sync, search / get / recent
  config.ts        paths and environment variables
  redact.ts        secret redaction
  text.ts          cleaning, truncation, noise filtering
  sources/
    opencode.ts    read-only opencode.db reader
    claude.ts      JSONL reader with byte-offset tracking
test/
  convbridge.test.ts
docs/
  DESIGN.md
```

## License

MIT. See [LICENSE](LICENSE).
