/**
 * Cutting the Raw view's text into frames.
 *
 * The Raw tab makes a promise the Events tab does not: these are the bytes as
 * they arrived. So this module only locates *boundaries* — it never rewrites a
 * frame — and the byte-exact view stays one click away in the UI.
 *
 * The framing rules are the capture's own: a blank line ends an SSE frame, a
 * single newline ends an NDJSON record. Each block is then handed to the
 * production parser, so the JSON tree reads a payload exactly the way the Events
 * tab does instead of through a second, subtly different implementation.
 *
 * @module panel/rawFrames
 */

import { NdjsonParser, SseParser, looksLikeNdjson } from '../lib/sse'
import type { SseEvent } from '../lib/types'

export type RawFraming = 'sse' | 'ndjson'

export interface RawFrame {
  /** The frame's text, minus the boundary that ended it. */
  text: string
  /** False for a trailing block no boundary terminated — a stream cut mid-frame. */
  complete: boolean
}

/**
 * The capture's per-frame byte cap is a storage quota, not a display one.
 *
 * The raw text is already bounded upstream, so cutting it again here would only
 * ever hide bytes the user came to this tab specifically to look at — and a
 * truncated payload cannot be parsed as JSON.
 */
const NO_CAP = Number.MAX_SAFE_INTEGER

function isBreak(char: string | undefined): boolean {
  return char === '\n' || char === '\r'
}

/** Length of the terminator at `index`; `\r\n` is one break, not two. */
function breakLength(raw: string, index: number): number {
  return raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1
}

/** Drops exactly one trailing terminator, which is the boundary rather than content. */
function trimOneBreak(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  return isBreak(text.slice(-1)) ? text.slice(0, -1) : text
}

function splitAtBlankLines(raw: string): RawFrame[] {
  const frames: RawFrame[] = []
  let frameStart = 0
  let lineStart = 0
  let index = 0

  while (index < raw.length) {
    if (!isBreak(raw[index])) {
      index += 1
      continue
    }
    const next = index + breakLength(raw, index)
    // The break is at the line's first character, so the line is empty.
    if (index === lineStart) {
      const text = trimOneBreak(raw.slice(frameStart, index))
      // Consecutive blank lines carry no frame; an empty block is not one.
      if (text.length > 0) frames.push({ text, complete: true })
      frameStart = next
    }
    lineStart = next
    index = next
  }

  const rest = raw.slice(frameStart)
  if (rest.length > 0) frames.push({ text: rest, complete: false })
  return frames
}

function splitAtLineBreaks(raw: string): RawFrame[] {
  const frames: RawFrame[] = []
  let lineStart = 0
  let index = 0

  while (index < raw.length) {
    if (!isBreak(raw[index])) {
      index += 1
      continue
    }
    const next = index + breakLength(raw, index)
    const text = raw.slice(lineStart, index)
    if (text.length > 0) frames.push({ text, complete: true })
    lineStart = next
    index = next
  }

  const rest = raw.slice(lineStart)
  if (rest.length > 0) frames.push({ text: rest, complete: false })
  return frames
}

/**
 * Which framing the text shows.
 *
 * A blank line decides it, because an NDJSON body never contains one. Only a
 * single-block text can be NDJSON, and then it has to look like it.
 *
 * The raw text is a *tail* slice, so its first line may be cut. `looksLikeNdjson`
 * parses that line, and a cut line does not parse — which is why this does not
 * ask it first.
 */
export function framingFor(raw: string): RawFraming {
  if (splitAtBlankLines(raw).length > 1) return 'sse'
  return looksLikeNdjson(raw) ? 'ndjson' : 'sse'
}

export function splitRawFrames(raw: string, framing: RawFraming): RawFrame[] {
  return framing === 'ndjson' ? splitAtLineBreaks(raw) : splitAtBlankLines(raw)
}

/**
 * The frame as the capture would have parsed it.
 *
 * Empty for a block that carries nothing the format recognises — an SSE frame of
 * only unknown fields, an NDJSON line that is not JSON, or a frame the stream cut
 * mid-way. The caller then shows the bytes and says so, rather than presenting a
 * reconstruction as something the server actually sent.
 */
export function frameEvents(frame: RawFrame, framing: RawFraming): SseEvent[] {
  if (framing === 'ndjson') {
    // A final line with no newline is usually complete, which is what the
    // capture's own parser assumes, so `flush` decides it rather than this view.
    const parser = new NdjsonParser({ maxEventBytes: NO_CAP })
    return [...parser.push(frame.text), ...parser.flush().events]
  }

  // Synthesising the blank line here would dispatch a frame the server never
  // finished, so a truncated payload would read as a valid one.
  const parser = new SseParser({ maxEventBytes: NO_CAP })
  const text = frame.complete ? `${frame.text}\n\n` : frame.text
  return [...parser.push(text), ...parser.flush().events]
}
