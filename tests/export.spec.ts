/**
 * Export and i18n tests.
 *
 * The curl builder gets the most attention because it produces something a user
 * will paste into a shell: a quoting bug there is a command that mangles a
 * payload or, with the wrong quoting style, executes part of it. The other axis is
 * honesty — an export that looks complete but silently omits masked credentials
 * or dropped frames leads to wrong conclusions later, when the reader no longer
 * has the session to check against.
 */

import { describe, expect, it } from 'vitest'
import {
  exportAllAsJson,
  exportAsCurl,
  exportAsJson,
  exportAsNdjson,
  suggestFilename,
  toExportedStream,
} from '../src/lib/export'
import { browserLanguages, createTranslate, messagesFor, resolveLocale } from '../src/lib/i18n'
import type { Messages } from '../src/lib/i18n'
import type { StreamRecord } from '../src/lib/types'

function makeRecord(overrides: Partial<StreamRecord> = {}): StreamRecord {
  return {
    id: '1:0:0',
    tabId: 1,
    frameId: 0,
    frameUrl: 'https://example.test/app',
    kind: 'fetch',
    method: 'POST',
    url: 'https://api.test/v1/chat/completions',
    startedAt: Date.parse('2026-01-01T10:00:00.000Z'),
    firstByteAt: Date.parse('2026-01-01T10:00:00.250Z'),
    endedAt: Date.parse('2026-01-01T10:00:02.000Z'),
    state: 'closed',
    status: 200,
    statusText: 'OK',
    contentType: 'text/event-stream',
    bytes: 120,
    eventCount: 2,
    droppedEvents: 0,
    events: [
      { seq: 0, at: Date.parse('2026-01-01T10:00:00.500Z'), event: 'message', data: '{"a":1}' },
      { seq: 1, at: Date.parse('2026-01-01T10:00:01.500Z'), event: 'message', data: '[DONE]' },
    ],
    ...overrides,
  }
}

describe('toExportedStream', () => {
  it('converts timestamps to ISO strings', () => {
    const exported = toExportedStream(makeRecord())
    expect(exported.startedAt).toBe('2026-01-01T10:00:00.000Z')
    expect(exported.endedAt).toBe('2026-01-01T10:00:02.000Z')
  })

  it('computes the duration', () => {
    expect(toExportedStream(makeRecord()).durationMs).toBe(2000)
  })

  it('makes event times relative to the stream start', () => {
    // Absolute timestamps are unreadable when the question is "how long between
    // these two frames".
    expect(toExportedStream(makeRecord()).events.map((event) => event.offsetMs)).toEqual([500, 1500])
  })

  it('omits absent optional fields rather than emitting null', () => {
    const exported = toExportedStream(
      makeRecord({ status: undefined, endedAt: undefined, requestBody: undefined }),
    )
    expect('status' in exported).toBe(false)
    expect('endedAt' in exported).toBe(false)
    expect('durationMs' in exported).toBe(false)
  })

  it('always carries a note explaining that values were masked', () => {
    // The export outlives the session, so the reader has no other way to know.
    expect(toExportedStream(makeRecord()).note).toContain('masked')
  })

  it('warns that an EventSource capture cannot include comments', () => {
    const note = toExportedStream(makeRecord({ kind: 'eventsource' })).note
    expect(note).toContain('EventSource')
    expect(note).toContain('comments')
  })

  it('discloses dropped events in the note', () => {
    const note = toExportedStream(makeRecord({ droppedEvents: 12 })).note
    expect(note).toContain('12')
    expect(note).toContain('dropped')
  })

  it('discloses an unterminated tail', () => {
    expect(toExportedStream(makeRecord({ tail: 'data: cut' })).note).toContain('mid-event')
  })

  it('preserves the truncated flag on an event', () => {
    const record = makeRecord({
      events: [{ seq: 0, at: 1, event: 'message', data: 'x', truncated: true }],
    })
    expect(toExportedStream(record).events[0]?.truncated).toBe(true)
  })
})

describe('exportAsJson', () => {
  it('produces parseable, indented JSON', () => {
    const text = exportAsJson(makeRecord())
    expect(text).toContain('\n  ')
    expect(() => JSON.parse(text)).not.toThrow()
  })

  it('round-trips the event payloads exactly', () => {
    const parsed = JSON.parse(exportAsJson(makeRecord())) as { events: { data: string }[] }
    expect(parsed.events.map((event) => event.data)).toEqual(['{"a":1}', '[DONE]'])
  })
})

describe('exportAllAsJson', () => {
  it('wraps several streams with a count and timestamp', () => {
    const parsed = JSON.parse(exportAllAsJson([makeRecord(), makeRecord()])) as {
      streamCount: number
      streams: unknown[]
      exportedAt: string
    }
    expect(parsed.streamCount).toBe(2)
    expect(parsed.streams).toHaveLength(2)
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('handles an empty list', () => {
    const parsed = JSON.parse(exportAllAsJson([])) as { streamCount: number }
    expect(parsed.streamCount).toBe(0)
  })
})

describe('exportAsNdjson', () => {
  it('emits one JSON object per line', () => {
    const lines = exportAsNdjson(makeRecord()).trimEnd().split('\n')
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('leads with a meta line, so the frames are not context-free', () => {
    const first = JSON.parse(exportAsNdjson(makeRecord()).split('\n')[0] ?? '') as {
      type: string
      url: string
    }
    expect(first.type).toBe('meta')
    expect(first.url).toBe('https://api.test/v1/chat/completions')
  })

  it('tags every frame line so a consumer can filter', () => {
    const lines = exportAsNdjson(makeRecord()).trimEnd().split('\n').slice(1)
    for (const line of lines) {
      expect((JSON.parse(line) as { type: string }).type).toBe('event')
    }
  })

  it('appends the unterminated tail as its own line', () => {
    const lines = exportAsNdjson(makeRecord({ tail: 'data: cut' })).trimEnd().split('\n')
    const last = JSON.parse(lines[lines.length - 1] ?? '') as { type: string; data: string }
    expect(last).toEqual({ type: 'tail', data: 'data: cut' })
  })

  it('ends with a newline, as NDJSON requires', () => {
    expect(exportAsNdjson(makeRecord()).endsWith('\n')).toBe(true)
  })

  it('escapes an embedded newline rather than breaking the line format', () => {
    const record = makeRecord({
      events: [{ seq: 0, at: 1, event: 'message', data: 'line one\nline two' }],
    })
    const lines = exportAsNdjson(record).trimEnd().split('\n')
    // Meta plus exactly one event line: the payload's newline must not split it.
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[1] ?? '') as { data: string }).data).toBe('line one\nline two')
  })
})

describe('exportAsCurl', () => {
  it('includes the method and URL', () => {
    const command = exportAsCurl(makeRecord())
    expect(command).toContain('-X POST')
    expect(command).toContain(`'https://api.test/v1/chat/completions'`)
  })

  it('omits -X for a GET, matching the curl default', () => {
    expect(exportAsCurl(makeRecord({ method: 'GET' }))).not.toContain('-X GET')
  })

  it('passes --no-buffer, or the stream appears to hang', () => {
    // The single most confusing thing that happens reproducing SSE on a shell.
    expect(exportAsCurl(makeRecord())).toContain('--no-buffer')
  })

  it('quotes headers with single quotes', () => {
    const command = exportAsCurl(makeRecord({ requestHeaders: { Accept: 'text/event-stream' } }))
    expect(command).toContain(`-H 'Accept: text/event-stream'`)
  })

  it('replaces a masked header with a fillable placeholder', () => {
    // The recorded value cannot work, so emitting it would send someone
    // debugging a 401 that this tool caused.
    const command = exportAsCurl(
      makeRecord({ requestHeaders: { Authorization: 'Bearer ••••••abcd' } }),
    )
    expect(command).toContain('REDACTED')
    expect(command).not.toContain('••••••')
  })

  it('warns in a comment when something was redacted', () => {
    const command = exportAsCurl(
      makeRecord({ requestHeaders: { Authorization: 'Bearer ••••••' } }),
    )
    expect(command.startsWith('#')).toBe(true)
    expect(command).toContain('filled in')
  })

  it('does not add the warning when nothing was masked', () => {
    expect(exportAsCurl(makeRecord({ requestHeaders: { Accept: 'text/event-stream' } })).startsWith('#')).toBe(false)
  })

  it('drops content-length and host, which curl must set itself', () => {
    const command = exportAsCurl(
      makeRecord({ requestHeaders: { 'Content-Length': '42', Host: 'api.test', Accept: 'x' } }),
    )
    expect(command).not.toContain('Content-Length')
    expect(command).not.toContain('Host:')
    expect(command).toContain('Accept')
  })

  it('escapes a single quote in the body', () => {
    const command = exportAsCurl(makeRecord({ requestBody: `{"q":"it's here"}` }))
    expect(command).toContain(`'\\''`)
  })

  it('neutralises shell metacharacters in the body', () => {
    // Double quoting would leave these live; `$(...)` would actually execute.
    const body = '{"q":"$(rm -rf /) `whoami` \\\\ $HOME"}'
    const command = exportAsCurl(makeRecord({ requestBody: body }))
    const quoted = command.slice(command.indexOf('--data-raw'))
    expect(quoted.startsWith(`--data-raw '`)).toBe(true)
    // Inside single quotes nothing expands, and no quote was broken out of.
    expect(quoted).toContain('$(rm -rf /)')
    expect(quoted.split(`'`).length % 2).toBe(1)
  })

  it('omits --data-raw when there is no body', () => {
    expect(exportAsCurl(makeRecord({ requestBody: undefined }))).not.toContain('--data-raw')
    expect(exportAsCurl(makeRecord({ requestBody: '' }))).not.toContain('--data-raw')
  })

  it('emits line continuations when asked', () => {
    expect(exportAsCurl(makeRecord(), { multiline: true })).toContain('\\\n')
  })
})

describe('suggestFilename', () => {
  it('includes the host and a sortable timestamp', () => {
    const name = suggestFilename(makeRecord(), 'json')
    expect(name).toBe('sse-api.test-2026-01-01T10-00-00.json')
  })

  it('contains no character a filesystem would reject', () => {
    const name = suggestFilename(makeRecord(), 'ndjson')
    expect(name).not.toMatch(/[:*?"<>|\\/]/)
  })

  it('falls back for an unparseable URL', () => {
    expect(suggestFilename(makeRecord({ url: 'not a url' }), 'json')).toContain('sse-stream-')
  })
})

// --- i18n --------------------------------------------------------------------

describe('resolveLocale', () => {
  it('honours an explicit choice over the browser', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
  })

  it('follows the browser under auto', () => {
    expect(resolveLocale('auto', ['zh-CN', 'en'])).toBe('zh-CN')
    expect(resolveLocale('auto', ['en-GB'])).toBe('en')
  })

  it('maps any Chinese variant to Simplified', () => {
    // Chinese text serves a zh-TW reader far better than English does.
    expect(resolveLocale('auto', ['zh-TW'])).toBe('zh-CN')
    expect(resolveLocale('auto', ['zh-Hant-HK'])).toBe('zh-CN')
  })

  it('respects preference order', () => {
    expect(resolveLocale('auto', ['fr', 'en', 'zh'])).toBe('en')
    expect(resolveLocale('auto', ['fr', 'zh', 'en'])).toBe('zh-CN')
  })

  it('falls back to English for an unsupported language', () => {
    expect(resolveLocale('auto', ['de-DE'])).toBe('en')
    expect(resolveLocale('auto', [])).toBe('en')
  })

  it('is case-insensitive', () => {
    expect(resolveLocale('auto', ['ZH-cn'])).toBe('zh-CN')
  })
})

describe('dictionaries', () => {
  it('define exactly the same keys in both languages', () => {
    // The Messages type is closed, so this catches a key added to one dictionary
    // and forgotten in the other before it renders as undefined for half the users.
    const english = Object.keys(messagesFor('en')).sort()
    const chinese = Object.keys(messagesFor('zh-CN')).sort()
    expect(chinese).toEqual(english)
  })

  it('leave no string empty', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      for (const [key, value] of Object.entries(messagesFor(locale))) {
        expect(value.length, `${locale}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('use the same placeholders in both languages', () => {
    // A placeholder present in one language and not the other means a number
    // silently disappears from the UI in that language.
    const english = messagesFor('en')
    const chinese = messagesFor('zh-CN')
    const placeholders = (text: string): string[] =>
      (text.match(/\{\w+\}/g) ?? []).sort()

    for (const key of Object.keys(english) as (keyof Messages)[]) {
      expect(placeholders(chinese[key]), key).toEqual(placeholders(english[key]))
    }
  })
})

describe('createTranslate', () => {
  it('returns the string for a locale', () => {
    expect(createTranslate('en')('settings')).toBe('Settings')
    expect(createTranslate('zh-CN')('settings')).toBe('设置')
  })

  it('substitutes a parameter', () => {
    expect(createTranslate('en')('streamCount', { count: 3 })).toBe('3 streams')
    expect(createTranslate('zh-CN')('streamCount', { count: 3 })).toBe('3 条流')
  })

  it('leaves an unsupplied placeholder visible rather than blank', () => {
    // A visible {count} is a bug report; an empty space is a mystery.
    expect(createTranslate('en')('streamCount')).toContain('{count}')
    expect(createTranslate('en')('streamCount', {})).toContain('{count}')
  })

  it('ignores an extra parameter', () => {
    expect(createTranslate('en')('settings', { unused: 1 })).toBe('Settings')
  })

  it('substitutes every occurrence', () => {
    expect(createTranslate('en')('droppedEvents', { count: 7 })).toBe('7 older events dropped')
  })
})

describe('browserLanguages', () => {
  it('returns an array without throwing in any environment', () => {
    expect(Array.isArray(browserLanguages())).toBe(true)
  })
})
