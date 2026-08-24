/**
 * Tests for attaching to a tab that has no hook.
 *
 * The behaviour under test is easy to get subtly wrong in ways that all *look*
 * like success, so most cases here assert on what the user is told rather than
 * just on whether injection happened:
 *
 * - Injecting into a restricted page cannot work, and reporting it as attached
 *   would leave someone waiting for captures that can never arrive.
 * - A hook that was already present must be reported *as such*, because it means
 *   a missed stream had another cause entirely (an early `fetch` alias) that
 *   attaching will never fix.
 * - A partial injection — relay placed, hook not — captures nothing, so it must
 *   fail loudly rather than half-succeed.
 *
 * The injection order is also load-bearing and is checked explicitly: the hook
 * announces itself through the relay, so a relay injected afterwards misses that
 * announcement and the page waits forever for arm state it will never be sent.
 */

import { describe, expect, it } from 'vitest'
import { attachToTab, injectionTargets, type AttachDeps } from '../src/background/attach'

/** A manifest shaped like the real built one: relay first, hook second. */
function manifest(): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'SSE Lens',
    version: '0.1.0',
    content_scripts: [
      { matches: ['http://*/*'], js: ['assets/relay-loader.js'], world: 'ISOLATED' },
      { matches: ['http://*/*'], js: ['src/inpage/hook.js'], world: 'MAIN' },
    ],
  } as chrome.runtime.ManifestV3
}

interface Recorder {
  deps: AttachDeps
  injected: { world: string; files: string[]; frameId: number }[]
}

/** Default tab frames: just the top frame, injectable. */
const DEFAULT_FRAMES = [{ frameId: 0, url: 'https://example.test/app' }]

function deps(overrides: Partial<AttachDeps> = {}): Recorder {
  const injected: { world: string; files: string[]; frameId: number }[] = []
  const base: AttachDeps = {
    getManifest: manifest,
    isInjectable: (url) => url !== undefined && url.startsWith('http'),
    getTab: async () => ({ url: 'https://example.test/app' }),
    listFrames: async () => DEFAULT_FRAMES,
    pingRelay: async () => false,
    executeScript: async ({ world, files, frameId }) => {
      injected.push({ world, files, frameId })
    },
    // Resolve immediately by default: the relay is treated as ready once scripts
    // have been injected, matching a fast chunk load.
    waitForRelay: async () => true,
    ...overrides,
  }
  return { deps: base, injected }
}

describe('injectionTargets', () => {
  it('derives the scripts from the manifest rather than hard-coding them', () => {
    // A hashed bundle filename changes on every content change, so a literal
    // here would break only in production.
    const targets = injectionTargets(manifest())
    expect(targets).toEqual([
      { world: 'ISOLATED', files: ['assets/relay-loader.js'] },
      { world: 'MAIN', files: ['src/inpage/hook.js'] },
    ])
  })

  it('defaults a missing world to ISOLATED, matching Chrome', () => {
    const targets = injectionTargets({
      manifest_version: 3,
      content_scripts: [{ matches: ['http://*/*'], js: ['a.js'] }],
    } as chrome.runtime.ManifestV3)
    expect(targets[0]?.world).toBe('ISOLATED')
  })

  it('skips entries with no js files', () => {
    // A css-only content script would otherwise produce an empty injection that
    // Chrome rejects.
    const targets = injectionTargets({
      manifest_version: 3,
      content_scripts: [
        { matches: ['http://*/*'], css: ['a.css'] },
        { matches: ['http://*/*'], js: ['b.js'] },
      ],
    } as chrome.runtime.ManifestV3)
    expect(targets).toHaveLength(1)
    expect(targets[0]?.files).toEqual(['b.js'])
  })

  it('tolerates a manifest with no content scripts', () => {
    const targets = injectionTargets({ manifest_version: 3 } as chrome.runtime.ManifestV3)
    expect(targets).toEqual([])
  })
})

describe('attachToTab', () => {
  it('injects every content script into the top frame when none is present', async () => {
    const { deps: d, injected } = deps()
    const outcome = await attachToTab(d, 7)
    expect(outcome).toEqual({ ok: true, alreadyPresent: false, attachedFrames: 1 })
    expect(injected).toHaveLength(2)
    expect(injected.every((entry) => entry.frameId === 0)).toBe(true)
  })

  it('injects the relay before the hook', async () => {
    // The hook's first act is to announce itself through the relay. Reversed,
    // that announcement is lost and the page never receives arm state.
    const { deps: d, injected } = deps()
    await attachToTab(d, 7)
    expect(injected.map((entry) => entry.world)).toEqual(['ISOLATED', 'MAIN'])
  })

  it('waits for the relay to answer before reporting success', async () => {
    // This is the race that caused "attached but later requests missed": the
    // injected relay loads its real chunk asynchronously, and arming before it
    // is ready drops the instruction. The attach must not succeed until the probe
    // answers.
    let ready = false
    let waited = false
    const { deps: d } = deps({
      waitForRelay: async () => {
        waited = true
        ready = true
        return true
      },
    })
    const outcome = await attachToTab(d, 7)
    expect(waited).toBe(true)
    expect(ready).toBe(true)
    expect(outcome.ok).toBe(true)
  })

  it('fails when the relay never becomes ready', async () => {
    // Scripts may execute but the chunk fail to load; success here would leave
    // the page with a hook but no relay, which captures nothing.
    const { deps: d } = deps({ waitForRelay: async () => false })
    const outcome = await attachToTab(d, 7)
    expect(outcome).toEqual({ ok: false, failure: 'injectionFailed', attachedFrames: 0 })
  })

  it('reports an existing hook as already present, and injects nothing', async () => {
    // Not merely an optimisation: this is the signal that a missed stream was
    // caused by something attaching cannot fix.
    const { deps: d, injected } = deps({ pingRelay: async () => true })
    const outcome = await attachToTab(d, 7)
    expect(outcome).toEqual({ ok: true, alreadyPresent: true, attachedFrames: 0 })
    expect(injected).toEqual([])
  })

  it('refuses a restricted page instead of attempting injection', async () => {
    const { deps: d, injected } = deps({
      getTab: async () => ({ url: 'chrome://settings' }),
    })
    const outcome = await attachToTab(d, 7)
    expect(outcome).toEqual({ ok: false, failure: 'restricted' })
    expect(injected).toEqual([])
  })

  it('reports a vanished tab distinctly from a restricted one', async () => {
    // Different fixes: one is "open a normal page", the other is nothing at all.
    const { deps: d } = deps({ getTab: async () => undefined })
    expect(await attachToTab(d, 7)).toEqual({ ok: false, failure: 'noTab' })
  })

  it('treats a tab with no url as restricted', async () => {
    const { deps: d } = deps({ getTab: async () => ({}) })
    expect(await attachToTab(d, 7)).toEqual({ ok: false, failure: 'restricted' })
  })

  it('fails when top-frame injection throws', async () => {
    const { deps: d } = deps({
      executeScript: async () => {
        throw new Error('Cannot access contents of the page')
      },
    })
    expect(await attachToTab(d, 7)).toEqual({
      ok: false,
      failure: 'injectionFailed',
      attachedFrames: 0,
    })
  })

  it('fails when only the relay could be injected into the top frame', async () => {
    // A relay with no hook captures nothing. Reporting success here would be
    // worse than admitting the attempt did not complete.
    let calls = 0
    const { deps: d, injected } = deps({
      executeScript: async ({ world, files, frameId }) => {
        calls += 1
        if (calls === 2) throw new Error('MAIN world injection blocked')
        injected.push({ world, files, frameId })
      },
    })
    const outcome = await attachToTab(d, 7)
    expect(outcome.failure).toBe('injectionFailed')
    expect(injected).toHaveLength(1)
  })

  it('succeeds when the top frame attaches even if a subframe fails', async () => {
    // This is why injection is per-frame rather than allFrames:true: one
    // inaccessible cross-origin subframe must not block the top frame, which is
    // where SSE originates in essentially every case.
    const { deps: d, injected } = deps({
      listFrames: async () => [
        { frameId: 0, url: 'https://app.example.test/' },
        { frameId: 5, url: 'https://ad.example.test/' },
      ],
      executeScript: async ({ frameId, world, files }) => {
        if (frameId === 5) throw new Error('blocked in subframe')
        injected.push({ frameId, world, files })
      },
    })
    const outcome = await attachToTab(d, 7)
    expect(outcome.ok).toBe(true)
    // Only the top frame's two scripts made it through.
    expect(injected.every((entry) => entry.frameId === 0)).toBe(true)
  })

  it('attaches into every attemptable subframe independently', async () => {
    const { deps: d, injected } = deps({
      listFrames: async () => [
        { frameId: 0, url: 'https://app.example.test/' },
        { frameId: 9, url: 'https://embed.example.test/stream' },
      ],
    })
    const outcome = await attachToTab(d, 7)
    expect(outcome).toEqual({ ok: true, alreadyPresent: false, attachedFrames: 2 })
    expect(injected.filter((entry) => entry.frameId === 9)).toHaveLength(2)
  })

  it('skips non-http(s) subframes without failing', async () => {
    const { deps: d, injected } = deps({
      listFrames: async () => [
        { frameId: 0, url: 'https://app.example.test/' },
        { frameId: 11, url: 'about:blank' },
        { frameId: 12, url: 'data:text/html,x' },
      ],
    })
    await attachToTab(d, 7)
    const touchedFrames = new Set(injected.map((entry) => entry.frameId))
    expect(touchedFrames.has(11)).toBe(false)
    expect(touchedFrames.has(12)).toBe(false)
  })

  it('always attempts the top frame even if its url is momentarily missing', async () => {
    // During navigation the top frame can briefly report no URL; it must still be
    // tried rather than skipped.
    const { deps: d, injected } = deps({
      listFrames: async () => [{ frameId: 0 }],
    })
    await attachToTab(d, 7)
    expect(injected.length).toBeGreaterThan(0)
  })

  it('fails when there are no frames at all', async () => {
    const { deps: d } = deps({ listFrames: async () => [] })
    expect(await attachToTab(d, 7)).toEqual({ ok: false, failure: 'injectionFailed' })
  })

  it('fails when the manifest declares no scripts to inject', async () => {
    const { deps: d } = deps({
      getManifest: () => ({ manifest_version: 3 }) as chrome.runtime.ManifestV3,
    })
    expect(await attachToTab(d, 7)).toEqual({ ok: false, failure: 'injectionFailed' })
  })

  it('passes both the tab id and frame id through to injection', async () => {
    const seen: { tabId: number; frameId: number }[] = []
    const { deps: d } = deps({
      executeScript: async (injection) => {
        seen.push({ tabId: injection.tabId, frameId: injection.frameId })
      },
    })
    await attachToTab(d, 42)
    expect(seen).toEqual([
      { tabId: 42, frameId: 0 },
      { tabId: 42, frameId: 0 },
    ])
  })

  it('checks injectability before probing the relay', async () => {
    // Probing a restricted tab is a guaranteed rejection; ordering the checks the
    // other way would make every restricted page pay for a failed message.
    let probed = false
    const { deps: d } = deps({
      getTab: async () => ({ url: 'chrome://extensions' }),
      pingRelay: async () => {
        probed = true
        return false
      },
    })
    await attachToTab(d, 7)
    expect(probed).toBe(false)
  })
})
