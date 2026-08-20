/**
 * Arm-controller and settings tests.
 *
 * The arm policy is the privacy boundary of this extension: a page keeps its hook
 * installed forever, so "capture only the current tab" is enforced entirely by
 * these transitions. The cases below therefore focus on the ways a tab could stay
 * armed when it should not — a tab switch, a panel close, a tab that closes while
 * armed — because each of those is a page quietly recording traffic nobody asked
 * for.
 */

import { describe, expect, it } from 'vitest'
import { ArmController, armMessage, isInjectablePage } from '../src/background/arm'
import { normalizeSettings } from '../src/background/settings'
import { DEFAULT_SETTINGS } from '../src/lib/types'

describe('isInjectablePage', () => {
  it('accepts ordinary http and https pages', () => {
    expect(isInjectablePage('https://example.com/app')).toBe(true)
    expect(isInjectablePage('http://localhost:3000/')).toBe(true)
  })

  it('rejects browser-internal schemes where no content script can run', () => {
    for (const url of [
      'chrome://extensions',
      'chrome-extension://abcdef/panel.html',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'edge://settings',
      'view-source:https://example.com',
    ]) {
      expect(isInjectablePage(url), url).toBe(false)
    }
  })

  it('rejects file URLs, which need a separate opt-in permission', () => {
    expect(isInjectablePage('file:///C:/tmp/page.html')).toBe(false)
  })

  it('rejects both Web Store domains', () => {
    expect(isInjectablePage('https://chrome.google.com/webstore/category/extensions')).toBe(false)
    expect(isInjectablePage('https://chromewebstore.google.com/detail/abc')).toBe(false)
  })

  it('accepts a non-webstore path on the same Google host', () => {
    expect(isInjectablePage('https://chrome.google.com/something-else')).toBe(true)
  })

  it('rejects undefined and unparseable input', () => {
    expect(isInjectablePage(undefined)).toBe(false)
    expect(isInjectablePage('not a url')).toBe(false)
  })
})

describe('ArmController', () => {
  it('starts with nothing armed', () => {
    const controller = new ArmController()
    expect(controller.tabId).toBeNull()
    expect(controller.accepts(1)).toBe(false)
  })

  it('arms the tab the panel opened over', () => {
    const controller = new ArmController()
    const transition = controller.openPanel(5)
    expect(transition.armed).toBe(5)
    expect(transition.disarmed).toEqual([])
    expect(controller.accepts(5)).toBe(true)
  })

  it('accepts only the armed tab', () => {
    const controller = new ArmController()
    controller.openPanel(5)
    expect(controller.accepts(5)).toBe(true)
    expect(controller.accepts(6)).toBe(false)
    expect(controller.accepts(undefined)).toBe(false)
  })

  it('disarms the previous tab when the user switches', () => {
    // The old tab's hook keeps capturing until told otherwise, so an explicit
    // disarm is what stops an unwatched page from buffering.
    const controller = new ArmController()
    controller.openPanel(5)
    const transition = controller.activateTab(6)
    expect(transition.armed).toBe(6)
    expect(transition.disarmed).toEqual([5])
    expect(controller.accepts(5)).toBe(false)
  })

  it('ignores a tab switch while the panel is closed', () => {
    // With nothing watching, arming would record traffic nobody asked for.
    const controller = new ArmController()
    const transition = controller.activateTab(6)
    expect(transition.armed).toBeNull()
    expect(controller.accepts(6)).toBe(false)
  })

  it('disarms everything when the panel closes', () => {
    const controller = new ArmController()
    controller.openPanel(5)
    const transition = controller.closePanel()
    expect(transition.armed).toBeNull()
    expect(transition.disarmed).toEqual([5])
    expect(controller.accepts(5)).toBe(false)
  })

  it('reports no transition when the same tab is re-armed', () => {
    // Otherwise every panel refresh would emit a redundant disarm/arm pair.
    const controller = new ArmController()
    controller.openPanel(5)
    const transition = controller.openPanel(5)
    expect(transition.disarmed).toEqual([])
  })

  it('clears the armed tab when that tab closes', () => {
    const controller = new ArmController()
    controller.openPanel(5)
    expect(controller.removeTab(5)).toBe(true)
    expect(controller.tabId).toBeNull()
  })

  it('ignores the close of an unrelated tab', () => {
    const controller = new ArmController()
    controller.openPanel(5)
    expect(controller.removeTab(9)).toBe(false)
    expect(controller.accepts(5)).toBe(true)
  })

  it('resumes arming after the panel reopens', () => {
    const controller = new ArmController()
    controller.openPanel(5)
    controller.closePanel()
    controller.openPanel(7)
    expect(controller.accepts(7)).toBe(true)
  })

  it('tracks panel state for the caller', () => {
    const controller = new ArmController()
    expect(controller.isPanelOpen).toBe(false)
    controller.openPanel(1)
    expect(controller.isPanelOpen).toBe(true)
    controller.closePanel()
    expect(controller.isPanelOpen).toBe(false)
  })
})

/**
 * Surviving worker eviction.
 *
 * These exist because their absence hid a real, user-visible bug. MV3 evicts an
 * idle worker after ~30s, and an SSE stream is idle between frames far longer than
 * that. A controller rebuilt from scratch after eviction had `panelOpen === false`,
 * so `activateTab` deliberately refused to arm — and switching tabs left the panel
 * stuck on "no page selected" until it was closed and reopened.
 *
 * The old suite could not catch this: every test above builds a controller and
 * drives it in one continuous life. Eviction is precisely the case where that
 * assumption does not hold, so it has to be simulated explicitly.
 */
describe('ArmController persistence across worker eviction', () => {
  /** Serialises through JSON, as `chrome.storage.session` really does. */
  const evict = (controller: ArmController): ArmController => {
    const stored = JSON.parse(JSON.stringify(controller.snapshot())) as unknown
    const revived = new ArmController()
    revived.hydrate(stored)
    return revived
  }

  it('remembers that the panel was open', () => {
    const before = new ArmController()
    before.openPanel(5)
    const after = evict(before)
    expect(after.isPanelOpen).toBe(true)
    expect(after.tabId).toBe(5)
    expect(after.accepts(5)).toBe(true)
  })

  it('arms the next tab after an eviction — the reported bug', () => {
    const before = new ArmController()
    before.openPanel(5)

    const after = evict(before)
    const transition = after.activateTab(9)

    expect(transition.armed).toBe(9)
    expect(transition.disarmed).toEqual([5])
    expect(after.accepts(9)).toBe(true)
    expect(after.accepts(5)).toBe(false)
  })

  it('still refuses to arm when the panel was closed before eviction', () => {
    // The privacy rule must survive a restart as well: a restored controller
    // that wrongly believed a panel was open would capture unwatched traffic.
    const before = new ArmController()
    before.openPanel(5)
    before.closePanel()

    const after = evict(before)
    expect(after.isPanelOpen).toBe(false)
    expect(after.activateTab(9)).toEqual({ armed: null, disarmed: [] })
    expect(after.accepts(9)).toBe(false)
  })

  it('treats a missing or malformed snapshot as a closed panel', () => {
    // Storage may hold nothing, or a value from an older version. Neither may
    // leave the controller believing it armed something it did not.
    for (const bad of [undefined, null, 'nonsense', 42, [], {}, { panelOpen: 'yes' }]) {
      const controller = new ArmController()
      controller.hydrate(bad)
      expect(controller.isPanelOpen, JSON.stringify(bad) ?? 'undefined').toBe(false)
      expect(controller.tabId).toBeNull()
    }
  })

  it('ignores a non-integer tab id', () => {
    const controller = new ArmController()
    controller.hydrate({ panelOpen: true, armedTabId: 1.5 })
    expect(controller.tabId).toBeNull()
    // The panel flag is still honoured, so the worker can re-arm the active tab.
    expect(controller.isPanelOpen).toBe(true)
  })

  it('round-trips repeatedly without drifting', () => {
    // Eviction can happen many times in one session; state must not decay.
    let controller = new ArmController()
    controller.openPanel(1)
    for (let index = 2; index <= 6; index += 1) {
      controller = evict(controller)
      controller.activateTab(index)
    }
    expect(controller.tabId).toBe(6)
    expect(controller.isPanelOpen).toBe(true)
  })

  it('keeps a snapshot that is plain JSON data', () => {
    // A snapshot containing a function or a Map would silently become `{}` in
    // storage, which is the sort of failure that only shows up in production.
    const controller = new ArmController()
    controller.openPanel(3)
    const snapshot = controller.snapshot()
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    expect(snapshot).toEqual({ panelOpen: true, armedTabId: 3 })
  })
})

describe('armMessage', () => {
  it('passes the capture mode and redaction list to the page', () => {
    const message = armMessage(true, {
      ...DEFAULT_SETTINGS,
      captureMode: 'strict',
      redactHeaders: ['x-secret'],
    })
    expect(message.armed).toBe(true)
    expect(message.captureMode).toBe('strict')
    expect(message.redactHeaders).toEqual(['x-secret'])
  })

  it('forces armed off when capture is globally disabled', () => {
    // The master switch has to win, or turning capture off would do nothing to
    // pages that are already armed.
    const message = armMessage(true, { ...DEFAULT_SETTINGS, captureEnabled: false })
    expect(message.armed).toBe(false)
  })

  it('stays disarmed when the tab is not the armed one', () => {
    expect(armMessage(false, DEFAULT_SETTINGS).armed).toBe(false)
  })

  it('always sends a positive body cap, since the page truncates before sending', () => {
    expect(armMessage(true, DEFAULT_SETTINGS).maxBodyChars).toBeGreaterThan(0)
  })
})

describe('normalizeSettings', () => {
  it('returns the defaults for empty input', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values', () => {
    const settings = normalizeSettings({
      locale: 'zh-CN',
      captureMode: 'strict',
      urlFilter: '/chat/',
      maxEventsPerStream: 500,
      keepAcrossNavigation: true,
    })
    expect(settings.locale).toBe('zh-CN')
    expect(settings.captureMode).toBe('strict')
    expect(settings.urlFilter).toBe('/chat/')
    expect(settings.maxEventsPerStream).toBe(500)
    expect(settings.keepAcrossNavigation).toBe(true)
  })

  it('replaces one bad field without discarding the rest', () => {
    // A settings object from an older version must not reset everything.
    const settings = normalizeSettings({ locale: 'klingon', captureMode: 'strict' })
    expect(settings.locale).toBe(DEFAULT_SETTINGS.locale)
    expect(settings.captureMode).toBe('strict')
  })

  it('clamps a number below the floor', () => {
    expect(normalizeSettings({ maxEventsPerStream: 0 }).maxEventsPerStream).toBe(10)
    expect(normalizeSettings({ maxEventsPerStream: -5 }).maxEventsPerStream).toBe(10)
  })

  it('clamps a number above the ceiling', () => {
    expect(normalizeSettings({ maxTabBytes: 1e12 }).maxTabBytes).toBe(64 * 1024 * 1024)
  })

  it('rejects a non-numeric quota', () => {
    expect(normalizeSettings({ maxEventBytes: 'lots' }).maxEventBytes).toBe(
      DEFAULT_SETTINGS.maxEventBytes,
    )
    expect(normalizeSettings({ maxEventBytes: Number.NaN }).maxEventBytes).toBe(
      DEFAULT_SETTINGS.maxEventBytes,
    )
    expect(normalizeSettings({ maxEventBytes: Infinity }).maxEventBytes).toBe(
      DEFAULT_SETTINGS.maxEventBytes,
    )
  })

  it('rounds a fractional quota', () => {
    expect(normalizeSettings({ maxStreamsPerTab: 12.7 }).maxStreamsPerTab).toBe(13)
  })

  it('drops non-string entries from the redaction list', () => {
    expect(normalizeSettings({ redactHeaders: ['x-a', 42, null, 'x-b'] }).redactHeaders).toEqual([
      'x-a',
      'x-b',
    ])
  })

  it('replaces a non-array redaction list', () => {
    expect(normalizeSettings({ redactHeaders: 'x-a' }).redactHeaders).toEqual([])
  })

  it('is idempotent', () => {
    const once = normalizeSettings({ locale: 'en', maxTabBytes: 1e12 })
    expect(normalizeSettings(once)).toEqual(once)
  })
})
