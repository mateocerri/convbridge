import { Glob } from "bun";
import { join } from "node:path";
import { clean, isHarnessNoise, type Turn } from "../text.ts";

export interface ClaudeFile {
  path: string;
  size: number;
}

/** All top-level session files: <claudeDir>/<project-slug>/<session-id>.jsonl */
export async function listClaudeFiles(claudeDir: string): Promise<ClaudeFile[]> {
  const out: ClaudeFile[] = [];
  const glob = new Glob("*/*.jsonl");
  for await (const rel of glob.scan({ cwd: claudeDir, onlyFiles: true })) {
    const path = join(claudeDir, rel);
    out.push({ path, size: Bun.file(path).size });
  }
  return out;
}

export interface ClaudeChunk {
  sessionId: string | null;
  title: string | null;
  cwd: string | null;
  turns: Turn[];
  /** Byte offset (relative to the read start) just past the last complete line. */
  consumed: number;
}

/**
 * Parse complete JSONL lines from `bytes`, starting at `startSeq + 1` for turn numbering.
 * A trailing partial line (no newline yet) is left unconsumed.
 */
export function parseClaudeChunk(bytes: Uint8Array, startSeq: number): ClaudeChunk {
  const lastNl = bytes.lastIndexOf(10);
  const result: ClaudeChunk = { sessionId: null, title: null, cwd: null, turns: [], consumed: 0 };
  if (lastNl < 0) return result;

  result.consumed = lastNl + 1;
  const text = new TextDecoder().decode(bytes.subarray(0, lastNl + 1));
  let seq = startSeq;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    result.sessionId ??= typeof obj.sessionId === "string" ? obj.sessionId : null;
    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") result.title = obj.aiTitle;
    if (!result.cwd && typeof obj.cwd === "string") result.cwd = obj.cwd;

    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (obj.isMeta) continue;
    const body = extractClaudeText(obj.type, obj.message?.content);
    if (!body || isHarnessNoise(body)) continue;

    seq += 1;
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    result.turns.push({
      seq,
      role: obj.type,
      ts: Number.isNaN(ts) ? null : ts,
      text: body,
    });
  }
  return result;
}

function extractClaudeText(type: "user" | "assistant", content: unknown): string {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as any[]) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (type === "assistant" && b?.type === "tool_use" && typeof b.name === "string")
      parts.push(`[tool: ${b.name}]`);
    // tool_result blocks (user side) and thinking blocks are skipped on purpose.
  }
  return clean(parts.join("\n"));
}
