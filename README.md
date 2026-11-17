# convbridge

Search across conversations from **opencode** and **Claude Code** without letting one agent read the other's raw storage.

`convbridge` is a small local [MCP](https://modelcontextprotocol.io) server. It builds its own search index from both tools' session data and exposes three compact tools (`search`, `get`, `recent`). Agents query it the way they query a code graph: ask a narrow question, receive only the relevant snippets, and drill down only when needed. Nothing is dumped into context by default.

> Status: v0.1.0, working MCP server and CLI, unit-tested. See [docs/DESIGN.md](docs/DESIGN.md) for the full specification.

## CLI

```sh
bun run src/cli.ts reindex
bun run src/cli.ts search "release plan" --source claude --limit 5
bun run src/cli.ts get "claude:<session-id>#26" --around 2 --max-chars 2000
bun run src/cli.ts recent --source opencode --limit 10
```

## Why

- opencode stores sessions in SQLite (`opencode.db`), with many message parts per turn.
- Claude Code stores sessions as JSONL files, with a lot of non-conversational noise (file history snapshots, API request blobs, attachments).
- An agent that needs to recall a previous discussion in the other tool currently has to open these stores directly. That fills the context window and spends tokens on data that is mostly irrelevant.

`convbridge` puts a search layer in between:

| Without convbridge | With convbridge |
| --- | --- |
| Agent opens raw SQLite / JSONL | Agent calls `search` with a query |
| Thousands of rows enter context | A few ranked snippets enter context |
| Agent guesses the schema | Schema is handled once, inside the server |

## Tools

| Tool | Purpose | Typical output |
| --- | --- | --- |
| `search(query, source?, cwd?, since?, limit?)` | Full-text (BM25) search over user and assistant text | Ranked hits grouped by session, each with a short snippet and a `ref` |
| `get(ref, around?, max_chars?)` | Read the turns around a hit | A bounded window of cleaned text |
| `recent(source?, cwd?, limit?)` | List the latest sessions | Titles, ids, dates, working directories |

Typical flow: `recent` or `search` to locate a session, then `get` on the one hit that matters.

Default budgets keep a single call small (target: about 1.5k tokens for `search`, about 1k for `get`). All limits are configurable.

## Requirements

- [Bun](https://bun.sh) (uses the built-in `bun:sqlite` module with FTS5).
- opencode and/or Claude Code installed locally with existing sessions.

No network access and no external services are used.

## Installation (planned)

```sh
git clone https://github.com/<your-user>/convbridge.git
cd convbridge
bun install
bun run reindex            # build the local index once
```

Register the server in Claude Code:

```sh
claude mcp add --scope user convbridge -- bun run /absolute/path/to/convbridge/src/server.ts
```

Register it in opencode by adding an entry under `mcp.servers` in your opencode config:

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

Paths are placeholders; use your own absolute paths.

## Data locations

`convbridge` reads from these defaults and never writes to them:

| Source | Default location |
| --- | --- |
| opencode | `~/.local/share/opencode/opencode.db` (opened read-only) |
| Claude Code | `~/.claude/projects/<project-slug>/<session-id>.jsonl` |

The `convbridge` index is stored at `~/.convbridge/index.db`. It contains conversation text, so keep it out of repositories. Override the locations with environment variables (documented in the design doc).

## Privacy and security

- All processing is local.
- Conversation text is indexed. Treat the index file as sensitive.
- Obvious secrets (API keys, bearer tokens, `password=`-style assignments) are redacted before indexing. Redaction is best-effort, not a guarantee.
- System, hook, and synthetic messages are excluded from the index to reduce noise.

## Development

```sh
bun test
```

Tests use fixture databases and JSONL files; they do not touch real session data.

## License

MIT. See [LICENSE](LICENSE).
