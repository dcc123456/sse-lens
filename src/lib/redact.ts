/**
 * Masking secrets before they are stored.
 *
 * This runs **in the page, before any capture leaves it**, and again in the
 * worker for defence in depth. The reason is a specific hazard: a streaming LLM
 * request carries a bearer token in a header, and often an API key in the body.
 * A debugging tool that quietly accumulates those into extension storage — which
 * the user may then export and paste into a bug report — is a credential leak
 * wearing a helpful UI.
 *
 * The policy is deliberately conservative: mask by default, keep enough of the
 * value to recognise it (`sk-a1b2…f9c0`), and never mask a header the user needs
 * to debug framing (`content-type`, `cache-control`, `transfer-encoding`).
 *
 * @module lib/redact
 */

/**
 * Headers whose values are always masked.
 *
 * Not user-configurable *off*: a setting that lets someone accidentally record
 * their own bearer tokens is a footgun, and the recognisable prefix/suffix is
 * enough to confirm "yes, that is the key I expected".
 */
export const ALWAYS_REDACTED_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-token',
  'x-goog-api-key',
  'x-amz-security-token',
  'openai-api-key',
  'anthropic-api-key',
] as const

/** Replacement for a value that is present but too short to show partially. */
const MASK = '••••••'

/**
 * Masks a value while keeping it identifiable.
 *
 * Shows the first 4 and last 4 characters when the value is long enough to make
 * that non-revealing (>= 16 chars, so at least 8 characters stay hidden). Below
 * that the whole value is replaced, because `sk-…abc` from a 12-character secret
 * gives away most of it.
 */
export function maskValue(value: string): string {
  if (value.length === 0) return ''
  if (value.length < 16) return MASK
  return `${value.slice(0, 4)}${MASK}${value.slice(-4)}`
}

/**
 * Redacts a header map.
 *
 * Comparison is lower-cased on both sides: HTTP header names are
 * case-insensitive, and a capture that masked `Authorization` but not
 * `authorization` would be worse than useless — it would look safe.
 */
export function redactHeaders(
  headers: Record<string, string>,
  extraNames: readonly string[] = [],
): Record<string, string> {
  const deny = new Set<string>(ALWAYS_REDACTED_HEADERS)
  for (const name of extraNames) {
    const trimmed = name.trim().toLowerCase()
    if (trimmed.length > 0) deny.add(trimmed)
  }

  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = deny.has(name.toLowerCase()) ? maskValue(value) : value
  }
  return out
}

/**
 * Key names whose values are masked inside a JSON or form body.
 *
 * Matched case-insensitively against the whole key, and also as a suffix after
 * `_`/`-`/`.` so `openai_api_key` and `auth.token` are caught. Substring
 * matching was rejected: it masks `tokens_used` and `token_count`, which are
 * exactly the numbers someone debugging a stream wants to read.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'private_key',
  'client_secret',
  'session',
  'cookie',
  'signature',
  'sign',
]

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS)

/** True when a JSON/form key names a secret. */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (SENSITIVE_KEY_SET.has(lower)) return true
  // Suffix after a separator: `x-api-key`, `openai_api_key`, `auth.token`.
  const tail = lower.split(/[_\-.]/).slice(1).join('_')
  if (tail.length > 0 && SENSITIVE_KEY_SET.has(tail)) return true
  const lastSegment = lower.split(/[_\-.]/).pop()
  return lastSegment !== undefined && lastSegment !== lower && SENSITIVE_KEY_SET.has(lastSegment)
}

/** Depth cap, so a self-referential or absurdly nested body cannot hang this. */
const MAX_DEPTH = 12

function redactJsonValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && typeof item === 'string') {
        out[key] = maskValue(item)
      } else {
        out[key] = redactJsonValue(item, depth + 1)
      }
    }
    return out
  }
  return value
}

/**
 * Redacts a request body, whatever shape it is in.
 *
 * Tries JSON first (the overwhelmingly common case for streaming APIs), then
 * `application/x-www-form-urlencoded`, then falls back to a line-oriented
 * `key: value` / `key=value` pass. The fallback matters because an unparseable
 * body must still be scrubbed — returning it verbatim on a parse failure would
 * make malformed JSON a bypass.
 *
 * Truncation happens after redaction, so a cut cannot expose a value that
 * scrubbing would have masked.
 */
export function redactBody(body: string, maxChars: number): { body: string; truncated: boolean } {
  const scrubbed = scrub(body)
  if (scrubbed.length <= maxChars) return { body: scrubbed, truncated: false }
  return { body: scrubbed.slice(0, maxChars), truncated: true }
}

function scrub(body: string): string {
  if (body.length === 0) return body

  const trimmed = body.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(body)
      // Re-serialised with indentation: the body is about to be read by a human
      // in a narrow panel, and a one-line 4KB payload is unreadable.
      return JSON.stringify(redactJsonValue(parsed, 0), null, 2)
    } catch {
      // Fall through to the textual pass rather than trusting the raw body.
    }
  }

  /**
   * Form encoding: `a=1&token=xyz`.
   *
   * The value class excludes newlines deliberately. With `[^&]*` — which allows
   * them — a two-line body like `model=gpt-4\napi_key=SECRET` matches as a
   * *single* pair whose key is `model`, so the whole thing is judged
   * non-sensitive and returned verbatim, leaking the key on the second line.
   * Requiring a single line means a multi-line body correctly falls through to
   * the line-oriented pass below. Covered by a regression test.
   */
  if (/^[^=&\s]+=[^&\r\n]*(&[^=&\s]+=[^&\r\n]*)*$/.test(body.trim())) {
    return body
      .trim()
      .split('&')
      .map((pair) => {
        const equals = pair.indexOf('=')
        if (equals === -1) return pair
        const key = pair.slice(0, equals)
        const value = pair.slice(equals + 1)
        if (!isSensitiveKey(decodeURIComponentSafe(key))) return pair
        return `${key}=${maskValue(value)}`
      })
      .join('&')
  }

  // Last resort: mask `key: value` and `key=value` on any line, and any
  // recognisable standalone secret literal.
  return body
    .split('\n')
    .map((line) => {
      const match = /^(\s*["']?)([A-Za-z0-9_.\-]+)(["']?\s*[:=]\s*)(.*)$/.exec(line)
      if (match) {
        const [, lead, key, sep, value] = match
        if (key !== undefined && isSensitiveKey(key)) {
          return `${lead ?? ''}${key}${sep ?? ''}${maskValue((value ?? '').trim())}`
        }
      }
      return maskSecretLiterals(line)
    })
    .join('\n')
}

/**
 * Masks values that are self-evidently credentials regardless of their key.
 *
 * Covers the case where a secret appears with no key at all — a bare token in a
 * text body, or a `Bearer` prefix inside a non-JSON payload.
 */
function maskSecretLiterals(line: string): string {
  return line
    .replace(/\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=\-]{8,})/gi, (_m, scheme: string, value: string) =>
      `${scheme} ${maskValue(value)}`,
    )
    .replace(/\b(sk|pk|rk|ak|xoxb|xoxp|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}\b/g, (match) =>
      maskValue(match),
    )
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
