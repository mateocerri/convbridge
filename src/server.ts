// convbridge MCP server: JSON-RPC 2.0 over stdio, no external SDK.
import { createInterface } from "node:readline";
import { Index } from "./index.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SOURCE_SCHEMA = { type: "string", enum: ["opencode", "claude", "any"] };

const TOOLS = [
  {
    name: "search",
    description:
      "Full-text search over user and assistant turns from opencode and Claude Code sessions. " +
      "Returns ranked hits with a ref (<source>:<session>#<seq>) you can pass to get.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for. Accents are ignored." },
        source: SOURCE_SCHEMA,
        cwd: { type: "string", description: "Substring of the session working directory." },
        since: { type: "string", description: "ISO date, e.g. 2026-01-01." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get",
    description: "Read turns around a search hit. Use after/around to page.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "<source>:<session_id>#<seq> from search." },
        around: { type: "integer", minimum: 0, maximum: 20, default: 3 },
        max_chars: { type: "integer", minimum: 500, maximum: 20000, default: 4000 },
        after: { type: "integer", description: "Return turns with seq greater than this (paging)." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "recent",
    description: "List the most recently updated sessions (title, id, date, cwd). No turn text.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_SCHEMA,
        cwd: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
  },
];

const index = new Index();

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function text(s: string, isError = false) {
  return { content: [{ type: "text", text: s }], isError };
}

async function callTool(name: string, args: any): Promise<ReturnType<typeof text>> {
  await index.sync(); // no-op if synced in the last 30s
  switch (name) {
    case "search":
      return text(
        index.search(String(args.query ?? ""), {
          source: args.source,
          cwd: args.cwd,
          since: args.since,
          limit: args.limit,
        }),
      );
    case "get":
      return text(
        index.get(String(args.ref ?? ""), args.around, args.max_chars, args.after),
      );
    case "recent":
      return text(index.recent({ source: args.source, cwd: args.cwd, limit: args.limit }));
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const isRequest = id !== undefined;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "convbridge", version: "0.1.0" },
      });
    case "ping":
      return isRequest && reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      try {
        const result = await callTool(params?.name, params?.arguments ?? {});
        return reply(id, result);
      } catch (e) {
        return reply(id, text(`Error: ${(e as Error).message}`, true));
      }
    }
    default:
      // Notifications (no id) such as notifications/initialized need no response.
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

const pending = new Set<Promise<void>>();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "Parse error");
  }
  const p = handle(msg).catch((e) => console.error("convbridge:", e));
  pending.add(p);
  p.finally(() => pending.delete(p));
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
  index.close();
  process.exit(0);
});

// Warm the index in the background so the first tool call is fast.
index.sync(true).catch((e) => console.error("convbridge sync:", e));
