/**
 * Real-browser end-to-end check.
 *
 * ## Why this exists
 *
 * Two fixes for "capture stops after switching pages" were verified only against a
 * Node fake of the `chrome` API. A fake encodes my *beliefs* about Chrome, so it
 * can only catch bugs I already imagined, and the reported fault survived both
 * rounds. This launches a real browser with the real unpacked extension and
 * asserts on the state the panel actually receives.
 *
 * It drives the reported sequence: open the panel, then navigate and switch tabs
 * repeatedly, checking capture after every step.
 *
 * Requires `pnpm build`. Run: `pnpm e2e`
 */

import { chromium, type BrowserContext, type Page, type Worker } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIST = join(ROOT, 'dist')
const PORT = 8791
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` - ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function startServer(): ChildProcess {
  return spawn(process.execPath, [join(ROOT, 'demo', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  })
}

/**
 * Locates a browser that will actually load an unpacked MV3 extension.
 *
 * Stable Chrome 151 silently ignores `--load-extension`: it starts, reports no
 * error, and `developerPrivate.getExtensionsInfo` returns an empty list. Testing
 * against it gives false confidence, because the worker Playwright then finds
 * belongs to a built-in component extension ("Google Network Speech") rather than
 * to this one. That is why findWorker verifies the manifest name.
 *
 * Playwright's bundled Chromium still honours the flag, so it is preferred.
 * `CHROME_PATH` overrides.
 */
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

  candidates.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  )

  return candidates.find((path) => path.length > 0 && existsSync(path))
}

/**
 * Finds this extension's service worker.
 *
 * `serviceWorkers()[0]` is not safe: Chrome runs its own component extensions, and
 * picking one produced a passing "worker started" check against an extension that
 * had never loaded. Each candidate is asked for its manifest name.
 */
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

interface State {
  tab: { id: number; url: string } | null
  streams: { url: string; eventCount: number; state: string }[]
  unavailableReason?: string
}

/**
 * Asks the worker for the panel state, from the panel page.
 *
 * This must not be evaluated inside the service worker: `chrome.runtime.sendMessage`
 * never dispatches to the sender's own context, so a worker asking itself receives
 * `undefined`, and a `?? fallback` then reports an empty capture. That produced a
 * run where every assertion failed for a reason that did not exist.
 *
 * The panel page is a real extension page, so its `sendMessage` reaches the worker
 * exactly as the product's own code does.
 */
async function panelState(panel: Page): Promise<State> {
  const result = await panel.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'panel.getState' })
    if (!response || response.ok !== true) {
      return { error: `bad response: ${JSON.stringify(response)}` }
    }
    return { state: response.state }
  })

  if ('error' in result && result.error) throw new Error(String(result.error))
  return (result as { state: State }).state
}

/** Highest event count across all captured streams. */
const bestEvents = (state: State): number =>
  Math.max(0, ...state.streams.map((stream) => stream.eventCount))

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    console.error('dist/manifest.json is missing - run `pnpm build` first.')
    process.exit(1)
  }

  const executablePath = findChrome()
  if (!executablePath) {
    console.error('No Chromium found. Set CHROME_PATH to a browser executable.')
    process.exit(1)
  }
  console.log(`Browser: ${executablePath}`)

  const server = startServer()
  await sleep(1200)

  const context: BrowserContext = await chromium.launchPersistentContext('', {
    executablePath,
    // MV3 extensions do not load in headless Chrome, so this must be headed.
    headless: false,
    /*
     * Playwright's default arguments include `--disable-extensions`, which
     * silently wins over `--load-extension`: Chrome starts, reports no error, and
     * loads nothing. Clearing these is what makes the extension load at all.
     */
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
    ],
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    // MV3 registers the worker lazily; loading an injected page starts it.
    const page = await context.newPage()
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await sleep(1200)

    const worker = await findWorker(context)
    if (!worker) {
      console.error(`\nSSE Lens did not load from ${DIST}.`)
      console.error('Chrome 151 stable ignores --load-extension; use the Playwright')
      console.error('Chromium (installed with `pnpm add -D playwright`) or set CHROME_PATH.')
      throw new Error('extension did not load')
    }

    const extensionId = new URL(worker.url()).host
    console.log(`\nExtension id: ${extensionId}\n`)
    check('SSE Lens service worker started', true)

    const panelPath = await worker.evaluate(
      () => chrome.runtime.getManifest().side_panel?.default_path ?? '',
    )
    check('manifest declares a side panel', panelPath.endsWith('.html'), panelPath)

    /*
     * The panel is opened as a tab.
     *
     * Chrome's real side panel needs a user gesture Playwright cannot synthesise.
     * The panel document runs identical code either way: same port, same messages.
     * The difference that matters is which tab is active, so the demo page is
     * brought back to the front afterwards - a panel that armed itself would be
     * inspecting a chrome-extension page, which is restricted.
     */
    const panel = await context.newPage()
    panel.on('pageerror', (error) => console.log(`  (panel error) ${error.message}`))

    /*
     * Retry the panel navigation.
     *
     * A freshly reloaded extension can briefly refuse to serve its own pages with
     * `net::ERR_FAILED` while Chrome re-registers the worker. That is a harness
     * race, not a product defect, and letting it abort the run would hide whatever
     * the run was meant to measure.
     */
    const panelUrl = `chrome-extension://${extensionId}/${panelPath}`
    let navigated = false
    for (let attempt = 0; attempt < 5 && !navigated; attempt += 1) {
      navigated = await panel
        .goto(panelUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
        .then(() => true)
        .catch(() => false)
      if (!navigated) await sleep(1000)
    }
    check('panel page loaded', navigated, navigated ? '' : panelUrl)
    await sleep(700)

    const rendered = await panel.evaluate(
      () => document.getElementById('root')?.childElementCount ?? -1,
    )
    check('panel rendered', rendered > 0, `rootChildren=${rendered}`)

    await page.bringToFront()
    await sleep(1000)

    let state = await panelState(panel)
    check(
      'panel armed the page tab',
      state.tab !== null,
      state.tab?.url ?? `none (${state.unavailableReason ?? 'no reason given'})`,
    )

    // --- capture on the first page -------------------------------------------

    await page.click('[data-demo="fetch-sse"]')
    await sleep(2400)
    state = await panelState(panel)
    check(
      'captures SSE on the first page',
      bestEvents(state) > 0,
      `streams=${state.streams.length} events=${bestEvents(state)}`,
    )

    // --- the reported sequence: navigate, then capture again -----------------

    for (const step of [1, 2, 3]) {
      await page.goto(`${BASE}/?nav=${step}`, { waitUntil: 'domcontentloaded' })
      await sleep(800)
      await page.click('[data-demo="fetch-deltas"]')
      await sleep(2800)

      state = await panelState(panel)
      check(
        `captures after navigation ${step}`,
        bestEvents(state) > 0,
        `streams=${state.streams.length} best=${bestEvents(state)}`,
      )
    }

    // --- a stream that starts during page load (the ordering race) -----------

    await page.goto(`${BASE}/`, { waitUntil: 'commit' })
    await page
      .click('[data-demo="fetch-deltas"]', { timeout: 6000 })
      .catch(() => console.log('  (early click missed)'))
    await sleep(2800)
    state = await panelState(panel)
    check(
      'captures a stream started during page load',
      bestEvents(state) > 0,
      `best=${bestEvents(state)}`,
    )

    // --- switching tabs ------------------------------------------------------

    const second = await context.newPage()
    await second.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await sleep(1000)
    await second.click('[data-demo="fetch-sse"]')
    await sleep(2400)
    state = await panelState(panel)
    check(
      'captures on a newly opened tab',
      bestEvents(state) > 0,
      `tab=${state.tab?.url ?? 'none'} best=${bestEvents(state)}`,
    )

    await page.bringToFront()
    await sleep(800)
    await second.bringToFront()
    await sleep(800)
    await page.bringToFront()
    await sleep(1000)

    await page.click('[data-demo="fetch-sse"]')
    await sleep(2400)
    state = await panelState(panel)
    check(
      'captures after switching tabs repeatedly',
      bestEvents(state) > 0,
      `best=${bestEvents(state)}`,
    )

    // --- other transports ----------------------------------------------------

    await page.click('[data-demo="eventsource"]')
    await sleep(3000)
    state = await panelState(panel)
    check(
      'captures EventSource',
      state.streams.some((stream) => stream.url.includes('/events')),
      state.streams.map((stream) => stream.url.split('/').pop()).join(','),
    )

    await page.click('[data-demo="xhr"]')
    await sleep(3000)
    state = await panelState(panel)
    check(
      'captures XHR',
      state.streams.filter((stream) => stream.eventCount > 0).length >= 2,
      `withEvents=${state.streams.filter((stream) => stream.eventCount > 0).length}`,
    )

    // --- control: an ordinary JSON response must not be captured -------------

    const before = state.streams.length
    await page.click('[data-demo="plain-json"]')
    await sleep(1500)
    state = await panelState(panel)
    check(
      'ignores a non-streaming JSON response',
      state.streams.length === before,
      `before=${before} after=${state.streams.length}`,
    )
  } finally {
    await context.close()
    server.kill()
  }

  console.log(
    failures === 0
      ? '\nAll real-browser checks passed.\n'
      : `\n${failures} real-browser check(s) FAILED.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

await main()
