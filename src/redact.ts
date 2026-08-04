/**
 * Secret redaction for indexed message text.
 *
 * Session logs routinely contain pasted credentials; the index must not become
 * a second place they leak from. Redaction runs at ingest time BEFORE the
 * message hash is computed (the hash covers the stored text), so redacted
 * messages stay stable across incremental re-ingests.
 *
 * Each match is replaced with its first 6 characters + a `[REDACTED:<kind>]`
 * marker — enough to recognize which credential it was without keeping it.
 */

interface SecretPattern {
  kind: string;
  re: RegExp;
}

/** Order matters: specific prefixes (sk-ant-) before generic ones (sk-). */
const PATTERNS: SecretPattern[] = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { kind: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[bpoas]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // token following "Bearer " — variable-length lookbehind is fine in V8
  { kind: 'bearer-token', re: /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g },
];

const KEEP_PREFIX = 6;

/** Replace credential-shaped substrings with `<first6>…[REDACTED:<kind>]`.
 * Idempotent: markers never re-match any pattern. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (m) => `${m.slice(0, KEEP_PREFIX)}…[REDACTED:${kind}]`);
  }
  return out;
}
