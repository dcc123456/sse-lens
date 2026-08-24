/**
 * Attaching to a tab that has no hook.
 *
 * ## The case this exists for
 *
 * Chrome does **not** retroactively inject content scripts. A tab that was open
 * when the extension was installed, updated, or reloaded from
 * `chrome://extensions` therefore has no hook and no relay, and nothing in the
 * normal lifecycle will ever give it one. The panel showed an empty stream list,
 * which is indistinguishable from "this page simply has not streamed yet" — so
 * the user is left guessing, and reasonably concludes capture is broken.
 *
 * `chrome.scripting.executeScript` can place the scripts into such a tab on
 * demand. That is the whole purpose of the `scripting` permission; nothing is
 * injected during normal operation.
 *
 * ## What attaching can and cannot recover
 *
 * This boundary was established by running a real browser, not by reasoning:
 *
 * | Situation | Attach helps? |
 * | --- | --- |
 * | Tab predates the extension; no hook present | **Yes** — the hook installs and later requests are captured |
 * | Hook present, page calls `window.fetch` | Already captured; attach is unnecessary |
 * | Hook present, page aliased `fetch` before `document_start` | **No** — see below |
 * | Restricted URL (`chrome://`, Web Store, `file://`) | **No** — Chrome forbids injection outright |
 *
 * The third row is the important one, and it is why this module reports honestly
 * rather than promising success. A page that did `const f = window.fetch` at
 * module scope holds the *original* function. Patching `window.fetch` afterwards
 * cannot reach that reference, so requests made through it are invisible no matter
 * how many times the script is injected. Verified against a page doing exactly
 * that: the stream was missed, while a `window.fetch` call from the same page in
 * the same session was captured.
 *
 * A request already in flight is likewise unrecoverable — its response body is
 * being consumed by the page as it arrives, and the bytes already delivered are
 * simply gone.
 *
 * So attaching is described to the user as taking effect for *subsequent*
 * requests, and reloading remains the reliable route. Presenting attach as a
 * general fix would be the more appealing lie: it would appear to work on most
 * pages and fail silently on exactly the bundled applications that are hardest to
 * debug.
 *
 * @module background/attach
 */

/**
 * Files to inject, and the world each belongs in.
 *
 * These must stay in step with `content_scripts` in `manifest.config.ts`. The
 * paths are the *built* ones, which differ from the source paths: the bundler
 * rewrites the ISOLATED relay into a loader plus a dynamically imported chunk.
 * Rather than hard-code a hashed filename, the manifest is read at runtime — a
 * hash changes on every content change, and a stale literal here would fail only
 * in production, where it is hardest to notice.
 */
export interface InjectionTarget {
  world: 'MAIN' | 'ISOLATED'
  files: string[]
}

/**
 * Reads the content-script list out of the running extension's own manifest.
 *
 * Deriving this rather than duplicating it means the injected scripts are by
 * construction the same ones Chrome injects normally, including any future change
 * to their number or order.
 */
export function injectionTargets(manifest: chrome.runtime.ManifestV3): InjectionTarget[] {
  const scripts = manifest.content_scripts ?? []
  const targets: InjectionTarget[] = []
  for (const entry of scripts) {
    const files = entry.js ?? []
    if (files.length === 0) continue
    // `world` is optional in the type and defaults to ISOLATED, matching Chrome.
    const world = (entry as { world?: 'MAIN' | 'ISOLATED' }).world ?? 'ISOLATED'
    targets.push({ world, files: [...files] })
  }
  return targets
}

/** Why an attach attempt could not proceed, in terms the panel can explain. */
export type AttachFailure =
  /** Chrome forbids content scripts on this URL; nothing can change that. */
  | 'restricted'
  /** No such tab, or it closed mid-attach. */
  | 'noTab'
  /** `executeScript` rejected — most often a page whose CSP or state blocks it. */
  | 'injectionFailed'

/** The minimal slice of `chrome` this module needs, so it can be tested. */
export interface FrameInfo {
  frameId: number
  url?: string
}

export interface AttachDeps {
  getManifest(): chrome.runtime.ManifestV3
  isInjectable(url: string | undefined): boolean
  getTab(tabId: number): Promise<{ url?: string } | undefined>
  /**
   * Frames in the tab, top frame first (frameId 0), with whatever URLs Chrome
   * reports. A frame whose URL is absent or non-injectable is skipped rather
   * than allowed to fail the whole attach.
   */
  listFrames(tabId: number): Promise<FrameInfo[]>
  /** Resolves true when a relay answers in the given frame, i.e. it is ready. */
  pingRelay(tabId: number, frameId?: number): Promise<boolean>
  /**
   * Injects files into one frame. This is deliberately *not* `allFrames: true`:
   * a single inaccessible subframe would make `executeScript` reject and fail
   * the entire attach, even though the top frame — where SSE almost always
   * originates — is perfectly injectable. Each frame is attempted on its own,
   * so one frame's CSP or origin can never block another's.
   */
  executeScript(injection: {
    tabId: number
    frameId: number
    world: 'MAIN' | 'ISOLATED'
    files: string[]
  }): Promise<void>
  /** Waits, briefly, for a freshly injected relay to become ready. */
  waitForRelay(tabId: number, frameId: number, timeoutMs?: number): Promise<boolean>
}

/** Frames that are worth attempting: an http(s) URL, or a top frame we must try. */
function isAttemptable(frame: FrameInfo): boolean {
  // The top frame may briefly report no URL during navigation; it is the one
  // that matters, so it is always attempted rather than skipped on a guess.
  if (frame.frameId === 0) return true
  if (!frame.url) return false
  try {
    const protocol = new URL(frame.url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export interface AttachOutcome {
  ok: boolean
  failure?: AttachFailure
  alreadyPresent?: boolean
  /**
   * How many frames received both scripts.
   *
   * Reported so the caller can distinguish "the top frame attached" (the
   * success case for the overwhelming majority of pages) from "nothing
   * attached at all". A cross-origin iframe that refused injection is normal
   * and must not read as a failure; a top frame that refused is the failure.
   */
  attachedFrames?: number
}

/**
 * Injects the content scripts into one tab, if that is possible and needed.
 *
 * ## Per-frame, not allFrames
 *
 * `chrome.scripting.executeScript({allFrames: true})` is atomic across frames:
 * if any single subframe rejects (a cross-origin frame without host access, an
 * odd scheme, a frame detached mid-call), the whole call rejects and the top
 * frame gets nothing. Since SSE originates in the top frame in essentially every
 * case, that is the wrong trade-off. Each frame is injected independently here.
 * The top frame is required; subframes are best-effort.
 *
 * ## Order and timing
 *
 * The ISOLATED relay is injected before the MAIN hook, matching the manifest.
 * Crucially, after injecting the relay we **wait for it to answer a probe**
 * before sending any arm instruction. A programmatically injected relay is a
 * loader that dynamically imports its real code, and an arm `sendMessage` sent
 * immediately after `executeScript` resolves can arrive before that import has
 * registered the listener — the message is dropped, the page stays disarmed,
 * and subsequent requests are silently missed. That race is invisible to the
 * static-injection path (where both scripts exist from `document_start`) and was
 * only reproducible through a real attach.
 *
 * Re-injection is skipped when a relay already answers. It would be harmless —
 * the hook carries an idempotence guard — but "already present" is diagnostically
 * different from "just attached", and the caller needs to be able to say so.
 */
export async function attachToTab(deps: AttachDeps, tabId: number): Promise<AttachOutcome> {
  const tab = await deps.getTab(tabId)
  if (tab === undefined) return { ok: false, failure: 'noTab' }
  if (!deps.isInjectable(tab.url)) return { ok: false, failure: 'restricted' }

  if (await deps.pingRelay(tabId, 0)) return { ok: true, alreadyPresent: true, attachedFrames: 0 }

  const targets = injectionTargets(deps.getManifest())
  if (targets.length === 0) return { ok: false, failure: 'injectionFailed' }

  // The top frame is always attemptable; subframes only when their URL is one we
  // can actually run content scripts in. Deduplicated by frameId.
  const frames = (await deps.listFrames(tabId)).filter(isAttemptable)
  if (frames.length === 0) return { ok: false, failure: 'injectionFailed' }

  let attached = 0
  let topFrameAttached = false

  for (const frame of frames) {
    let frameOk = true
    for (const target of targets) {
      try {
        await deps.executeScript({ tabId, frameId: frame.frameId, world: target.world, files: target.files })
      } catch {
        // One inaccessible frame must not take down the others. It is recorded
        // as a miss; if the top frame itself misses, that becomes a failure.
        frameOk = false
        break
      }
    }

    if (frameOk) {
      // Wait for this frame's relay before declaring it ready, so an arm sent
      // by the caller will actually be received. A short timeout is enough:
      // the relay is a tiny local chunk, not a network fetch.
      const ready = await deps.waitForRelay(tabId, frame.frameId, 1500)
      if (ready) {
        attached += 1
        if (frame.frameId === 0) topFrameAttached = true
      } else if (frame.frameId === 0) {
        // Scripts executed but the relay never answered — treat the top frame
        // as a failure rather than silently leaving it disarmed.
        topFrameAttached = false
      }
    }
  }

  if (!topFrameAttached) return { ok: false, failure: 'injectionFailed', attachedFrames: attached }
  return { ok: true, alreadyPresent: false, attachedFrames: attached }
}
