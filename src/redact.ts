// Best-effort secret redaction applied to every turn before indexing.
// Pattern-based: it reduces leaks, it does not guarantee none.

const PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
