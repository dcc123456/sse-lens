/**
 * Settings persistence.
 *
 * Two storage areas, chosen for a specific reason each:
 *
 * - **Settings** live in `chrome.storage.local`: they are preferences and should
 *   survive a browser restart.
 * - **Captures** live in `chrome.storage.session` (see `index.ts`), which is
 *   memory-backed and cleared when the browser closes. A capture can contain a
 *   bearer token even after redaction (a token in an unexpected header, a session
 *   id in a payload), so it must not be written to disk where it would outlive
 *   the debugging session that justified collecting it.
 *
 * Reads are defensive: a settings object written by an older version of the
 * extension, or hand-edited, must not crash the worker on startup. Every field is
 * validated and falls back to its default individually, so one bad value does not
 * discard the rest.
 *
 * @module background/settings
 */

import { DEFAULT_SETTINGS, type CaptureMode, type LocaleSetting, type Settings } from '../lib/types'

const SETTINGS_KEY = 'settings'

/** Bounds that keep a hand-edited or stale value from breaking the panel. */
const LIMITS = {
  maxEventsPerStream: { min: 10, max: 100_000 },
  maxEventBytes: { min: 256, max: 4 * 1024 * 1024 },
  maxStreamsPerTab: { min: 1, max: 500 },
  maxTabBytes: { min: 64 * 1024, max: 64 * 1024 * 1024 },
} as const

function clampNumber(value: unknown, key: keyof typeof LIMITS): number {
  const fallback = DEFAULT_SETTINGS[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const { min, max } = LIMITS[key]
  return Math.min(max, Math.max(min, Math.round(value)))
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asLocale(value: unknown): LocaleSetting {
  return value === 'en' || value === 'zh-CN' || value === 'auto' ? value : DEFAULT_SETTINGS.locale
}

function asCaptureMode(value: unknown): CaptureMode {
  return value === 'strict' || value === 'loose' ? value : DEFAULT_SETTINGS.captureMode
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.redactHeaders]
  return value.filter((item): item is string => typeof item === 'string')
}

/** Normalises any input into a complete, in-range {@link Settings}. */
export function normalizeSettings(raw: unknown): Settings {
  const input = (raw ?? {}) as Record<string, unknown>
  return {
    locale: asLocale(input.locale),
    captureEnabled: asBoolean(input.captureEnabled, DEFAULT_SETTINGS.captureEnabled),
    captureMode: asCaptureMode(input.captureMode),
    urlFilter: asString(input.urlFilter, DEFAULT_SETTINGS.urlFilter),
    redactHeaders: asStringArray(input.redactHeaders),
    maxEventsPerStream: clampNumber(input.maxEventsPerStream, 'maxEventsPerStream'),
    maxEventBytes: clampNumber(input.maxEventBytes, 'maxEventBytes'),
    maxStreamsPerTab: clampNumber(input.maxStreamsPerTab, 'maxStreamsPerTab'),
    maxTabBytes: clampNumber(input.maxTabBytes, 'maxTabBytes'),
    keepAcrossNavigation: asBoolean(
      input.keepAcrossNavigation,
      DEFAULT_SETTINGS.keepAcrossNavigation,
    ),
    autoMergeDeltas: asBoolean(input.autoMergeDeltas, DEFAULT_SETTINGS.autoMergeDeltas),
  }
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY)
    return normalizeSettings(stored[SETTINGS_KEY])
  } catch {
    // A storage failure must not leave the worker without settings, or nothing
    // works at all.
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
}
