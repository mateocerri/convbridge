// Best-effort secret redaction applied to every turn before indexing.
// Pattern-based: it reduces leaks, it does not guarantee none.

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"],
  // GitHub (classic, OAuth, app, fine-grained), AWS access key ids, Slack, Google API keys
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED_KEY]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_KEY]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  // credentials embedded in a URL: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  // key: value / key=value, including JSON ("password": "hunter2")
  [
    /(["']?\b(?:api[_-]?key|token|secret|passw(?:or)?d)\b["']?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1$2[REDACTED]",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
