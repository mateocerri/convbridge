#!/usr/bin/env bun
// convbridge CLI: same core as the MCP server, for debugging or use outside an agent.
import { Index } from "./index.ts";

const USAGE = `Usage:
  convbridge reindex
  convbridge search <query> [--source opencode|claude|any] [--cwd <substr>] [--since <ISO>] [--limit <n>]
  convbridge get <ref> [--around <n>] [--max-chars <n>] [--after <seq>]
  convbridge recent [--source ...] [--cwd <substr>] [--limit <n>]`;

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[++i] ?? "";
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseFlags(rest);
const index = new Index();

try {
  switch (cmd) {
    case "reindex": {
      const r = await index.sync(true);
      console.log(
        `opencode: ${r.opencodeSessions} sessions updated, ${r.opencodeTurns} turns added\n` +
          `claude:   ${r.claudeFiles} files scanned, ${r.claudeTurns} turns added` +
          (r.errors.length ? `\nerrors:\n  ${r.errors.join("\n  ")}` : ""),
      );
      break;
    }
    case "search": {
      await index.sync();
      console.log(
        index.search(positional.join(" "), {
          source: flags.source as any,
          cwd: flags.cwd,
          since: flags.since,
          limit: flags.limit ? Number(flags.limit) : undefined,
        }),
      );
      break;
    }
    case "get": {
      await index.sync();
      console.log(
        index.get(
          positional[0] ?? "",
          flags.around ? Number(flags.around) : undefined,
          flags["max-chars"] ? Number(flags["max-chars"]) : undefined,
          flags.after ? Number(flags.after) : undefined,
        ),
      );
      break;
    }
    case "recent": {
      await index.sync();
      console.log(
        index.recent({
          source: flags.source as any,
          cwd: flags.cwd,
          limit: flags.limit ? Number(flags.limit) : undefined,
        }),
      );
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
} finally {
  index.close();
}
