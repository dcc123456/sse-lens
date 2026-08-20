/**
 * Reassembling streamed text from delta frames.
 *
 * This is the feature that makes the difference between "a log of 400 frames" and
 * "the answer the model gave". Every streaming LLM API sends text in increments,
 * but each one nests it differently:
 *
 * | Shape                                    | Seen in                        |
 * | ---------------------------------------- | ------------------------------ |
 * | `choices[0].delta.content`               | OpenAI chat completions        |
 * | `choices[0].delta.reasoning_content`     | DeepSeek / reasoning models    |
 * | `delta.text`                             | Anthropic content-block deltas |
 * | `candidates[0].content.parts[0].text`    | Google Gemini                  |
 * | `response`, `token`, `text`, `output`    | Ollama, HF TGI, various proxies|
 *
 * Rather than hard-coding a table of vendors — which would silently produce
 * nothing for the next API, and for any in-house gateway — the merge works by
 * *discovering* which leaf path carries the increments. The insight it relies on:
 * across a stream, an incremental text field appears at the same path in most
 * frames and its values are short. A field that appears once (an id, a model
 * name) or holds the same value every time (a role, a finish reason) is not a
 * delta.
 *
 * A cumulative style, where each frame repeats the whole text so far, is detected
 * separately and handled by taking the last value rather than concatenating —
 * concatenating those would produce quadratic garbage.
 *
 * @module lib/deltas
 */

import type { SseEvent } from './types'

/** How the values at a path relate to each other across frames. */
export type MergeStyle = 'incremental' | 'cumulative'

export interface MergeResult {
  /** The assembled text. */
  text: string
  /** Dotted path the text came from, e.g. `choices[].delta.content`. */
  path: string
  style: MergeStyle
  /** Frames that contributed. */
  contributingEvents: number
  /** Frames whose data was not JSON, so plain text was used instead. */
  plainTextEvents: number
}

/**
 * Paths that outrank a discovered one when both are present.
 *
 * Discovery alone is not quite enough: a reasoning model emits *two* incremental
 * fields (`reasoning_content` and `content`) and picking whichever appeared in
 * more frames would show the model's scratchpad as the answer. So known answer
 * fields are preferred, and discovery handles everything else.
 */
const PREFERRED_SUFFIXES = [
  'delta.content',
  'delta.text',
  'message.content',
  'content.parts[].text',
  'delta.reasoning_content',
  'response',
  'text',
  'content',
  'token',
  'output',
  'chunk',
]

/** Keys that are metadata, never content, however text-like their values. */
const IGNORED_KEYS = new Set([
  'id',
  'object',
  'model',
  'role',
  'created',
  'created_at',
  'finish_reason',
  'stop_reason',
  'index',
  'type',
  'event',
  'system_fingerprint',
  'service_tier',
  'logprobs',
  'usage',
  'citations',
  'refusal',
])

/** Depth guard: deep enough for every real API, shallow enough to stay cheap. */
const MAX_DEPTH = 8

/**
 * A leaf string found in a frame.
 *
 * Array indices collapse to `[]` so `choices[0]` and `choices[1]` are recognised
 * as the same field. This is what lets a stream that switches between parallel
 * choices still merge — and it is why the path shown in the UI reads
 * `choices[].delta.content` rather than naming an index that varied.
 */
interface Leaf {
  path: string
  value: string
}

function collectLeaves(value: unknown, path: string, depth: number, out: Leaf[]): void {
  if (depth > MAX_DEPTH || out.length > 200) return

  if (typeof value === 'string') {
    if (path !== '') out.push({ path, value })
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, `${path}[]`, depth + 1, out)
    return
  }
  if (value === null || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (IGNORED_KEYS.has(key)) continue
    collectLeaves(child, path === '' ? key : `${path}.${key}`, depth + 1, out)
  }
}

/** Per-path statistics gathered across the whole stream. */
interface PathStats {
  values: string[]
  /** Frames in which this path appeared. */
  frames: number
  /** True while every value so far extends the previous one. */
  cumulative: boolean
  totalLength: number
}

function parseJson(data: string): unknown {
  const trimmed = data.trim()
  // Cheap prefix check first: most non-JSON frames (`[DONE]`, plain text) are
  // rejected without paying for a throw.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Frames that are protocol sentinels rather than content. */
function isSentinel(data: string): boolean {
  const trimmed = data.trim()
  // Whitespace is deliberately *not* a sentinel. A raw-text stream sends the
  // spaces between words as their own frames, so discarding them would merge
  // "Hello world" into "Helloworld". An empty frame costs nothing to keep,
  // since it contributes no characters to the concatenation either way.
  return trimmed === '[DONE]' || trimmed === 'DONE' || trimmed === '{}'
}

/**
 * Scores a candidate path.
 *
 * A *named* field leads, because the name is evidence from the API's own author:
 * a field called `delta.content` is content by declaration, whereas coverage is
 * only circumstantial. This ordering is what resolves the case that matters most
 * in practice — a reasoning model emits `reasoning_content` for many frames and
 * `content` for a few, and ranking by coverage alone would present the model's
 * scratchpad as its answer.
 *
 * Coverage then decides among unknown fields, which is what lets an in-house
 * gateway's `payload.fragment` be discovered with no table to look it up in. The
 * bonus decays down the preference list, so a low-ranked generic name like `chunk`
 * cannot beat a field that actually appears in every frame.
 */
function score(path: string, stats: PathStats, totalFrames: number): number {
  const coverage = stats.frames / Math.max(1, totalFrames)
  let value = coverage * 100

  const preferredIndex = PREFERRED_SUFFIXES.findIndex(
    (suffix) => path === suffix || path.endsWith(`.${suffix}`) || path.endsWith(suffix),
  )
  if (preferredIndex !== -1) value += 120 - preferredIndex * 12

  // A single-frame field is metadata, not a stream of increments.
  if (stats.frames < 2) value -= 60
  // A field that never changes is a constant (a role, a finish reason).
  if (new Set(stats.values).size === 1 && stats.frames > 2) value -= 80

  return value
}

/**
 * Merges the incremental text of a stream.
 *
 * @param events frames in arrival order
 * @returns the assembled text, or undefined when no field looks incremental
 */
export function mergeDeltas(events: readonly SseEvent[]): MergeResult | undefined {
  const stats = new Map<string, PathStats>()
  let jsonFrames = 0
  let plainTextFrames = 0
  const plainText: string[] = []

  for (const event of events) {
    // Comments are heartbeats and framing, never content.
    if (event.comment !== undefined) continue
    if (isSentinel(event.data)) continue

    const parsed = parseJson(event.data)
    if (parsed === undefined) {
      // Not JSON. Some servers stream raw text tokens; keep them as a fallback so
      // those streams still merge into something readable.
      plainTextFrames += 1
      plainText.push(event.data)
      continue
    }

    jsonFrames += 1
    const leaves: Leaf[] = []
    collectLeaves(parsed, '', 0, leaves)

    // De-duplicate by path within a frame, keeping the first: a frame carrying
    // two parallel choices should count as one observation, not two.
    const seen = new Set<string>()
    for (const leaf of leaves) {
      if (seen.has(leaf.path)) continue
      seen.add(leaf.path)

      let entry = stats.get(leaf.path)
      if (!entry) {
        entry = { values: [], frames: 0, cumulative: true, totalLength: 0 }
        stats.set(leaf.path, entry)
      }
      const previous = entry.values[entry.values.length - 1]
      if (
        previous !== undefined &&
        !(leaf.value.startsWith(previous) && leaf.value.length >= previous.length)
      ) {
        entry.cumulative = false
      }
      entry.values.push(leaf.value)
      entry.frames += 1
      entry.totalLength += leaf.value.length
    }
  }

  // No JSON at all: a raw-text stream. Concatenating is the only sensible reading.
  if (jsonFrames === 0) {
    if (plainText.length < 2) return undefined
    const text = plainText.join('')
    if (text.trim() === '') return undefined
    return {
      text,
      path: 'data',
      style: 'incremental',
      contributingEvents: plainTextFrames,
      plainTextEvents: plainTextFrames,
    }
  }

  let best: { path: string; stats: PathStats; score: number } | undefined
  for (const [path, entry] of stats) {
    const value = score(path, entry, jsonFrames)
    if (!best || value > best.score) best = { path, stats: entry, score: value }
  }

  // Below this, the winner is metadata that happened to recur rather than a delta.
  if (!best || best.score < 40) return undefined

  const { path, stats: winner } = best
  // Cumulative only counts when there is enough evidence: two frames where the
  // second happens to start with the first is a coincidence, not a pattern.
  const cumulative = winner.cumulative && winner.frames > 2
  const text = cumulative
    ? (winner.values[winner.values.length - 1] ?? '')
    : winner.values.join('')

  if (text === '') return undefined

  return {
    text,
    path,
    style: cumulative ? 'cumulative' : 'incremental',
    contributingEvents: winner.frames,
    plainTextEvents: plainTextFrames,
  }
}

/**
 * Formats a frame's data for display.
 *
 * Pretty-printed when it parses as JSON, verbatim otherwise. Returning the
 * original text on failure matters: a malformed frame is exactly what someone
 * opened this tool to look at, so it must be shown as the server sent it rather
 * than replaced by an error.
 */
export function formatEventData(data: string): { text: string; isJson: boolean } {
  const parsed = parseJson(data)
  if (parsed === undefined) return { text: data, isJson: false }
  try {
    return { text: JSON.stringify(parsed, null, 2), isJson: true }
  } catch {
    return { text: data, isJson: false }
  }
}

/** Parses a frame for the JSON tree view, or undefined when it is not JSON. */
export function parseEventJson(data: string): unknown {
  return parseJson(data)
}
