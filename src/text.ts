export const MAX_TURN_CHARS = 1500;

export type Role = "user" | "assistant";

export interface Turn {
  seq: number;
  role: Role;
  ts: number | null;
  text: string;
}

export function clean(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(s: string, max = MAX_TURN_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)} …`;
}

/** Turns injected by the harness rather than written by a person or the model. */
export function isHarnessNoise(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<system-reminder>") || t.startsWith("<command-") || t.startsWith("<local-command-");
}

export function dayOf(ts: number | null): string {
  return ts == null ? "----------" : new Date(ts).toISOString().slice(0, 10);
}
