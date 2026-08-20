/**
 * Redaction tests.
 *
 * The threat model these encode: a capture of a streaming LLM request contains a
 * bearer token in a header and often an API key in the body, and the user may
 * export that capture into a bug report. So the assertions are mostly about
 * *not* leaking — including through the paths an attacker-shaped input would
 * take, like malformed JSON, mixed header casing, and secrets with no key at all.
 *
 * The negative cases matter just as much: over-masking `token_count` or
 * `content-type` would break the tool's actual job.
 */

import { describe, expect, it } from 'vitest'
import {
  ALWAYS_REDACTED_HEADERS,
  isSensitiveKey,
  maskValue,
  redactBody,
  redactHeaders,
} from '../src/lib/redact'

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'

describe('maskValue', () => {
  it('keeps four characters at each end of a long value', () => {
    expect(maskValue(SECRET)).toBe('sk-a••••••6789')
  })

  it('hides a short value entirely', () => {
    // Showing 4+4 of a 12-char secret would reveal most of it.
    expect(maskValue('short-secret')).toBe('••••••')
  })

  it('hides a value one character below the reveal threshold', () => {
    expect(maskValue('x'.repeat(15))).toBe('••••••')
    expect(maskValue('x'.repeat(16))).toBe('xxxx••••••xxxx')
  })

  it('leaves an empty value empty rather than inventing a mask', () => {
    expect(maskValue('')).toBe('')
  })

  it('never returns the original value for anything non-empty', () => {
    for (const value of ['a', 'ab'.repeat(50), SECRET, 'Bearer ' + SECRET]) {
      expect(maskValue(value)).not.toBe(value)
    }
  })
})

describe('redactHeaders', () => {
  it('masks every always-redacted header', () => {
    const headers: Record<string, string> = {}
    for (const name of ALWAYS_REDACTED_HEADERS) headers[name] = SECRET
    const result = redactHeaders(headers)
    for (const name of ALWAYS_REDACTED_HEADERS) {
      expect(result[name], name).not.toBe(SECRET)
      expect(result[name], name).toContain('••••••')
    }
  })

  it('is case-insensitive on header names', () => {
    // HTTP header names are case-insensitive, so a case-sensitive deny list
    // would mask `Authorization` and pass `AUTHORIZATION` straight through.
    const result = redactHeaders({
      Authorization: SECRET,
      AUTHORIZATION: SECRET,
      'X-Api-Key': SECRET,
      cOoKiE: SECRET,
    })
    for (const value of Object.values(result)) {
      expect(value).not.toBe(SECRET)
    }
  })

  it('preserves the headers needed to debug framing', () => {
    const kept = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'x-request-id': 'req_123',
    }
    expect(redactHeaders(kept)).toEqual(kept)
  })

  it('masks extra user-configured names', () => {
    const result = redactHeaders({ 'x-tenant-secret': SECRET }, ['X-Tenant-Secret'])
    expect(result['x-tenant-secret']).not.toBe(SECRET)
  })

  it('ignores blank entries in the user list', () => {
    const result = redactHeaders({ 'content-type': 'text/plain' }, ['', '   '])
    expect(result['content-type']).toBe('text/plain')
  })

  it('preserves the original header name casing', () => {
    // The panel shows what the server actually sent.
    const result = redactHeaders({ 'Content-Type': 'text/event-stream' })
    expect(Object.keys(result)).toEqual(['Content-Type'])
  })

  it('handles an empty map', () => {
    expect(redactHeaders({})).toEqual({})
  })
})

describe('isSensitiveKey', () => {
  it('matches exact secret names', () => {
    for (const key of ['password', 'token', 'api_key', 'secret', 'authorization']) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('is case-insensitive', () => {
    expect(isSensitiveKey('API_KEY')).toBe(true)
    expect(isSensitiveKey('Password')).toBe(true)
  })

  it('matches a secret name after a separator', () => {
    for (const key of ['openai_api_key', 'x-api-key', 'auth.token', 'user-password']) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('does not match a name that merely contains a secret word', () => {
    // These are exactly the fields someone debugging a stream wants to read.
    for (const key of ['tokens_used', 'token_count', 'max_tokens', 'completion_tokens']) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })

  it('does not match ordinary payload fields', () => {
    for (const key of ['model', 'messages', 'stream', 'content', 'role', 'delta']) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })
})

describe('redactBody · JSON', () => {
  it('masks a secret value and keeps the rest readable', () => {
    const body = JSON.stringify({ model: 'gpt-4', api_key: SECRET, stream: true })
    const { body: result } = redactBody(body, 10_000)
    expect(result).not.toContain(SECRET)
    expect(result).toContain('gpt-4')
    expect(result).toContain('true')
  })

  it('masks nested secrets', () => {
    const body = JSON.stringify({ auth: { token: SECRET }, list: [{ password: 'hunter2hunter2hunter2' }] })
    const { body: result } = redactBody(body, 10_000)
    expect(result).not.toContain(SECRET)
    expect(result).not.toContain('hunter2hunter2hunter2')
  })

  it('keeps token counts intact', () => {
    const body = JSON.stringify({ usage: { total_tokens: 1234, max_tokens: 4096 } })
    const { body: result } = redactBody(body, 10_000)
    expect(result).toContain('1234')
    expect(result).toContain('4096')
  })

  it('pretty-prints so a long body is readable in a narrow panel', () => {
    const { body: result } = redactBody(JSON.stringify({ a: 1, b: 2 }), 10_000)
    expect(result).toContain('\n')
  })

  it('does not mask a non-string value under a secret key', () => {
    // `"token": null` masked to a string would misrepresent the request.
    const { body: result } = redactBody(JSON.stringify({ token: null, secret: 42 }), 10_000)
    expect(result).toContain('null')
    expect(result).toContain('42')
  })

  it('survives deeply nested input without hanging', () => {
    let nested: unknown = { token: SECRET }
    for (let depth = 0; depth < 200; depth += 1) nested = { child: nested }
    const { body: result } = redactBody(JSON.stringify(nested), 100_000)
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('redactBody · malformed input', () => {
  it('still scrubs a body that looks like JSON but does not parse', () => {
    // Malformed JSON must not be a bypass: the textual pass has to catch it.
    const body = `{"api_key": "${SECRET}", oops`
    const { body: result } = redactBody(body, 10_000)
    expect(result).not.toContain(SECRET)
  })

  it('scrubs a bare Bearer token in a text body', () => {
    const { body: result } = redactBody(`Authorization: Bearer ${SECRET}`, 10_000)
    expect(result).not.toContain(SECRET)
  })

  it('scrubs a recognisable key literal with no key name at all', () => {
    const { body: result } = redactBody(`please use ${SECRET} today`, 10_000)
    expect(result).not.toContain(SECRET)
  })

  it('scrubs a key=value line', () => {
    const { body: result } = redactBody(`model=gpt-4\napi_key=${SECRET}`, 10_000)
    expect(result).not.toContain(SECRET)
    expect(result).toContain('gpt-4')
  })
})

describe('redactBody · form encoding', () => {
  it('masks a secret form field and keeps the others', () => {
    const { body: result } = redactBody(`model=gpt-4&token=${SECRET}&stream=true`, 10_000)
    expect(result).not.toContain(SECRET)
    expect(result).toContain('model=gpt-4')
    expect(result).toContain('stream=true')
  })

  it('handles a percent-encoded key name', () => {
    const { body: result } = redactBody(`api%5Fkey=${SECRET}`, 10_000)
    expect(result).not.toContain(SECRET)
  })
})

describe('redactBody · truncation', () => {
  it('truncates after redacting, so a cut cannot expose a masked value', () => {
    // The secret sits past the cut point; if truncation ran first the textual
    // pass would never see it, and the visible half would leak.
    const body = `${'a'.repeat(40)}${SECRET}`
    const { body: result, truncated } = redactBody(body, 50)
    expect(truncated).toBe(true)
    expect(result).not.toContain(SECRET.slice(0, 20))
  })

  it('reports a short body as untruncated', () => {
    const { body: result, truncated } = redactBody('model=gpt-4', 10_000)
    expect(truncated).toBe(false)
    expect(result).toBe('model=gpt-4')
  })

  it('respects the limit exactly', () => {
    const { body: result } = redactBody('x'.repeat(100), 10)
    expect(result).toHaveLength(10)
  })

  it('handles an empty body', () => {
    expect(redactBody('', 100)).toEqual({ body: '', truncated: false })
  })
})
