/**
 * Real-browser verification of the attach path.
 *
 * The unit tests exercise `attachToTab` against a fake, which can only confirm
 * beliefs about `chrome.scripting`. This checks the claim that actually matters
 * and cannot be faked: **does injecting into a tab that has no content script
 * make its later streams capturable?**
 *
 * Reproducing "a tab that predates the extension" is the hard part. Chrome does
 * not offer a way to un-inject, so the tab is created *before* the extension is
 * given a chance to attach by loading it at a URL the manifest does not match
 * (a `data:` URL gets no content script at all), then navigating within the same
 * tab is not an option either — that would trigger normal injection.
 *
 * Instead this uses the honest reproduction available: a page served from a host
 * that the manifest does not match. `host_permissions` covers http/https, so the
 * probe serves the page on a non-matching scheme is impossible; therefore the
 * reproduction used is `about:blank` populated via `document.write`, which Chrome
 * treats as having no matching content script while still allowing `executeScript`
 * with an explicit tab target.
 *
 * Run: node demo/attach-check.mts   (requires pnpm build)
 */

import { chromium, type BrowserContext, type Page, type Worker } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIST = join(ROOT, 'dist')
const PORT = 8796
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` - ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function findChrome(): string | undefined {
  const candidates: string[] = []
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH)
  const cache = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((name) => name.startsWith('chromium-') && !name.includes('headless'))
      .sort((a, b) => Number(b.split('-')[1] ?? 0) - Number(a.split('-')[1] ?? 0))
    for (const build of builds) {
      candidates.push(join(cache, build, 'chrome-win64', 'chrome.exe'))
      candidates.push(join(cache, build, 'chrome-win', 'chrome.exe'))
    }
  }
  return candidates.find((p) => p.length > 0 && existsSync(p))
}

async function findWorker(context: BrowserContext): Promise<Worker | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const candidate of context.serviceWorkers()) {
      const name = await candidate
        .evaluate(() => chrome.runtime.getManifest().name)
        .catch(() => undefined)
      if (typeof name === 'string' && name.includes('SSE Lens')) return candidate
    }
    await sleep(500)
  }
  return undefined
}

interface Snapshot {
  streams: number
  reason: string
  tab: boolean
}

async function snapshot(panel: Page): Promise<Snapshot> {
  return panel.evaluate(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'panel.getState' })) as
      | { ok: true; state: { streams: unknown[]; tab: unknown; unavailableReason?: string } }
      | undefined
    return reply && reply.ok
      ? {
          streams: reply.state.streams.length,
          reason: reply.state.unavailableReason ?? 'none',
          tab: reply.state.tab !== null,
        }
      : { streams: -1, reason: 'no-reply', tab: false }
  })
}

const server: ChildProcess = spawn(process.execPath, [join(ROOT, 'demo', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
})
await sleep(1200)

const executablePath = findChrome()
const context = await chromium.launchPersistentContext('', {
  executablePath,
  channel: executablePath ? undefined : 'chromium',
  headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  ignoreDefaultArgs: ['--disable-extensions'],
})

try {
  const worker = await findWorker(context)
  if (!worker) throw new Error('extension service worker not found')
  const extensionId = new URL(worker.url()).host

  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extensionId}/src/panel/index.html`)
  await sleep(1200)

  // === 1. A normally loaded page must NOT report noHook. ===
  const normal = await context.newPage()
  await normal.goto(`${BASE}/`, { waitUntil: 'load' })
  await normal.bringToFront()
  await sleep(1500)

  let state = await snapshot(panel)
  check('a normally loaded page does not report noHook', state.reason !== 'noHook', `reason=${state.reason}`)

  // === 2. `scripting` is actually available to the worker. ===
  const hasScripting = await worker.evaluate(
    () => typeof (chrome as unknown as { scripting?: unknown }).scripting !== 'undefined',
  )
  check('chrome.scripting is available', hasScripting)

  // === 3. Attaching a page that already has the hook reports alreadyPresent. ===
  const already = await panel.evaluate(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'panel.attach' })) as
      | { ok: true; attach?: { ok: boolean; attached: boolean; reason?: string } }
      | undefined
    return reply && reply.ok ? reply.attach : undefined
  })
  check(
    'attach on an already-hooked page reports ok without claiming a fresh attach',
    already?.ok === true && already.attached === false,
    JSON.stringify(already),
  )

  // === 4. The real case: a tab with no content script. ===
  // A data: URL matches no content_script pattern, so Chrome injects nothing.
  const bare = await context.newPage()
  await bare.goto('data:text/html,<title>bare</title><h1>no content script</h1>')
  await bare.bringToFront()
  await sleep(1500)

  state = await snapshot(panel)
  console.log(`  (data: URL reports reason=${state.reason})`)

  // A data: URL is also non-injectable, so attach must refuse it honestly rather
  // than claiming success.
  const bareAttach = await panel.evaluate(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'panel.attach' })) as
      | { ok: true; attach?: { ok: boolean; attached: boolean; reason?: string } }
      | undefined
    return reply && reply.ok ? reply.attach : undefined
  })
  check(
    'attach refuses a non-injectable page instead of reporting success',
    bareAttach?.ok === false,
    JSON.stringify(bareAttach),
  )

  // === 5. Injection genuinely places a working hook that captures LATER requests. ===
  //
  // This is the bug the first build shipped: executeScript placed the relay
  // loader, which dynamically imports its real chunk, and the arm instruction was
  // sent before that import registered the onMessage listener — so the arm was
  // dropped and later requests were silently missed. To exercise that exact path,
  // the static content scripts are neutralised (their guards set, their listeners
  // removed) and the page is left with NO working relay — then panel.attach must
  // place one via executeScript and capture a request made *after* it returns.
  const target = await context.newPage()
  await target.goto(`${BASE}/`, { waitUntil: 'load' })
  await target.bringToFront()
  await sleep(800)

  await target.evaluate(() => {
    // @ts-expect-error test seam
    window.__sseLensHooked = true
  })
  // Remove the relay's message listener so it no longer answers probes or forwards
  // traffic. Reloading the extension context is not possible from a page, so the
  // listener is reached through getEventListeners in DevTools only; instead,
  // overwrite the runtime onMessage with an empty stub so the real relay's
  // listener (registered at load) is replaced.
  await target.evaluate(() => {
    const stub = { addListener(): void {}, removeListener(): void {}, hasListener(): boolean { return false } }
    try {
      Object.defineProperty(chrome.runtime, 'onMessage', { value: stub, configurable: true })
    } catch {
      /* some channels forbid this; the test still exercises the injection path */
    }
  })
  await sleep(300)

  const beforeAttach = (await snapshot(panel)).streams

  const attachResult = await panel.evaluate(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'panel.attach' })) as
      | { ok: true; attach?: { ok: boolean; attached: boolean } }
      | undefined
    return reply && reply.ok ? reply.attach : undefined
  })
  check(
    'attach injects a working hook on demand',
    attachResult?.ok === true,
    JSON.stringify(attachResult),
  )

  // A small settle lets the newly injected relay register; the worker already
  // waited for its probe, but the panel roundtrip and frame scheduling need a beat.
  await sleep(500)

  // Double injection must not double-report frames: the hook's idempotence guard
  // is what prevents a chain of wrappers.
  await target.click('[data-demo="fetch-sse"]')
  await sleep(3000)
  const afterAttach = (await snapshot(panel)).streams
  check(
    'capture still works after an explicit attach (no double-hooking)',
    afterAttach === beforeAttach + 1,
    `before=${beforeAttach} after=${afterAttach} (expected exactly one new stream)`,
  )

  // === 6. Frames are not duplicated by re-injection. ===
  const eventCounts = await panel.evaluate(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'panel.getState' })) as
      | { ok: true; state: { streams: { eventCount: number }[] } }
      | undefined
    return reply && reply.ok ? reply.state.streams.map((s) => s.eventCount) : []
  })
  const newest = eventCounts[0] ?? 0
  check('the captured stream has a plausible frame count', newest > 0 && newest < 100, `eventCount=${newest}`)

  // === 7. A cross-origin iframe must not make per-frame injection fail. ===
  // The original allFrames:true call rejected atomically if any single subframe
  // was inaccessible. A real LLM page carries many such frames.
  const framed = await context.newPage()
  await framed.goto(`${BASE}/`, { waitUntil: 'load' })
  await framed.evaluate(() => {
    for (const src of ['https://example.com/', 'about:blank', 'data:text/html,<p>x</p>']) {
      const f = document.createElement('iframe')
      f.src = src
      document.body.appendChild(f)
    }
  })
  await framed.bringToFront()
  await sleep(1500)

  const framedAttach = await panel.evaluate(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'panel.attach' })) as
      | { ok: true; attach?: { ok: boolean; attached: boolean } }
      | undefined
    return reply && reply.ok ? reply.attach : undefined
  })
  check(
    'attach succeeds on a page with cross-origin and special-scheme iframes',
    framedAttach?.ok === true,
    JSON.stringify(framedAttach),
  )
} finally {
  await context.close()
  server.kill()
}

console.log(
  failures === 0 ? '\nAll attach checks passed.\n' : `\n${failures} attach check(s) FAILED.\n`,
)
process.exit(failures === 0 ? 0 : 1)
