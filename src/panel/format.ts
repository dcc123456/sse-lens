/**
 * Formatting helpers for the panel.
 *
 * Separated from the components because these are the rules most likely to be
 * wrong in a way a screenshot will not reveal — a duration shown in the wrong
 * unit, or a byte count that reads as 8000 when it means 8 KB. Keeping them here
 * makes them testable without rendering anything.
 *
 * @module panel/format
 */

import type { Translate } from '../lib/i18n'
import type { StreamRecord } from '../lib/types'

/**
 * Formats a byte count.
 *
 * Binary units (1024), because that is what the quota settings use, and showing
 * a limit as "8 MB" while enforcing 8 MiB would make the numbers disagree.
 */
export function formatBytes(bytes: number, t: Translate): string {
  if (bytes < 1024) return `${bytes} ${t('unitBytes')}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('unitKb')}`
  return `${(bytes / (1024 * 1024)).toFixed(2)} ${t('unitMb')}`
}

/**
 * Formats a duration.
 *
 * Sub-second values stay in milliseconds because that is the resolution that
 * matters for time-to-first-byte; anything longer reads better in seconds.
 */
export function formatDuration(ms: number, t: Translate): string {
  if (ms < 1000) return `${Math.round(ms)} ${t('unitMs')}`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} ${t('unitSeconds')}`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}${t('unitSeconds')}`
}

/** Wall-clock time for a frame, to the millisecond. */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`
}

/** Offset from the stream start, which is what matters when reading a timeline. */
export function formatOffset(at: number, startedAt: number, t: Translate): string {
  return formatDuration(Math.max(0, at - startedAt), t)
}

/**
 * Shortens a URL for the list.
 *
 * The path and query identify a stream; the scheme and host rarely do, since
 * every stream in a capture usually shares them. So the host is dropped and the
 * path kept whole — the full URL is still available in the tooltip and the detail
 * view.
 */
export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const tail = `${parsed.pathname}${parsed.search}`
    return tail === '/' ? parsed.host : tail
  } catch {
    return url
  }
}

/** Host for the secondary line, so the origin is still visible somewhere. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Localised label for a stream state. */
export function stateLabel(state: StreamRecord['state'], t: Translate): string {
  switch (state) {
    case 'open':
      return t('stateOpen')
    case 'closed':
      return t('stateClosed')
    case 'error':
      return t('stateError')
    case 'aborted':
      return t('stateAborted')
    default:
      return state
  }
}

/**
 * A one-line preview of a frame for the collapsed row.
 *
 * Prefers the delta text when the payload is JSON with an obvious content field,
 * because that is the part a reader is scanning for. Falls back to the raw data,
 * with newlines collapsed so a multi-line payload cannot break the row layout.
 */
export function summariseEvent(data: string, comment: string | undefined): string {
  if (comment !== undefined) return `: ${comment}`

  const trimmed = data.trim()
  if (trimmed === '') return '(empty)'

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const preview = findContentPreview(parsed, 0)
      if (preview !== undefined && preview !== '') return preview
    } catch {
      // Fall through to the raw preview: a malformed frame is worth seeing as-is.
    }
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 200)
}

/** Depth-limited hunt for a short text field to preview. */
function findContentPreview(value: unknown, depth: number): string | undefined {
  if (depth > 6) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findContentPreview(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  // Ordered by how likely the field is to be the content someone wants to read.
  for (const key of ['content', 'text', 'reasoning_content', 'response', 'token', 'delta']) {
    if (key in record) {
      const found = findContentPreview(record[key], depth + 1)
      if (found !== undefined) return found
    }
  }
  for (const key of ['choices', 'candidates', 'parts', 'message']) {
    if (key in record) {
      const found = findContentPreview(record[key], depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Copies text, reporting success so the caller can show feedback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard access can be denied; the caller surfaces the failure rather than
    // leaving the user thinking a copy succeeded.
    return false
  }
}

/**
 * Offers text as a file download.
 *
 * An object URL with a synthetic click, because the panel has no downloads
 * permission and does not need one for its own generated content.
 */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Revoked on the next tick: revoking immediately can cancel the download in
  // some Chrome versions.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
