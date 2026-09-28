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
  streams: { id: string; url: string; eventCount: number; state: string }[]
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

/**
 * Opens the panel in a new tab and returns it.
 *
 * The navigation is retried because a freshly loaded — or freshly *resumed* —
 * extension can briefly refuse to serve its own pages with `net::ERR_FAILED`.
 */
async function openPanelTab(context: BrowserContext, panelUrl: string): Promise<Page> {
  const panel = await context.newPage()
  panel.on('pageerror', (error) => console.log(`  (panel error) ${error.message}`))

  let navigated = false
  for (let attempt = 0; attempt < 5 && !navigated; attempt += 1) {
    navigated = await panel
      .goto(panelUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
      .then(() => true)
      .catch(() => false)
    if (!navigated) await sleep(1000)
  }
  check('panel page loaded', navigated, navigated ? '' : panelUrl)
  return panel
}

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
    const panelUrl = `chrome-extension://${extensionId}/${panelPath}`
    let panel = await openPanelTab(context, panelUrl)
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

    // --- a stream whose frames straddle a worker eviction ----------------------

    /*
     * The reported fault: on any stream that pauses longer than Chrome's ~30s
     * idle lifetime, the worker dies between frames. The restarted worker has the
     * record back from `storage.session` but must still recognise the id the page
     * gave that stream, or every later frame is discarded as an orphan and the
     * stream stops growing for good.
     *
     * Closing the panel is what makes the eviction happen: its port is the only
     * thing holding the worker open, and it also disarms the page — so the stream
     * is re-armed before its second frame is due, which is the state a user
     * reaches by reopening the panel mid-answer.
     */
    await page.click('[data-demo="fetch-long-gap"]')
    await sleep(2500)
    state = await panelState(panel)
    const beforeGap = state.streams.find((stream) => stream.url.includes('/long-gap'))
    check(
      'captures the frame before the gap',
      (beforeGap?.eventCount ?? 0) >= 1,
      `events=${beforeGap?.eventCount ?? 0}`,
    )

    /** A worker destroyed mid-evaluate can hang, so cap how long it is given. */
    const bounded = <T,>(promise: Promise<T>, ms = 8000): Promise<T | undefined> =>
      Promise.race([promise, sleep(ms).then(() => undefined)])

    await panel.close()
    console.log('  waiting out the worker idle timeout (35s)…')
    await sleep(35000)

    const stillAlive = await bounded(
      worker.evaluate(() => chrome.runtime.getManifest().name),
    ).catch(() => undefined)
    /*
     * Reported, not asserted: `findWorker` had to call into the worker to identify
     * it, and a worker with a debugging session attached is exempt from Chrome's
     * idle timeout. So this run cannot prove eviction happened either way — which
     * is why the restarted-worker path lives in tests/worker-lifecycle.spec.ts,
     * where eviction is simulated against the real worker module. What this case
     * does cover is the long-idle stream end to end.
     */
    console.log(
      `  (info) worker after 35s idle: ${typeof stillAlive === 'string' ? 'still running' : 'gone'}`,
    )

    /*
     * Reopen the panel, which wakes the worker and re-arms this tab. The second
     * frame is due at ~45s, so it arrives after a cold worker has rehydrated.
     */
    panel = await openPanelTab(context, panelUrl)
    await page.bringToFront()
    await sleep(1500)
    console.log('  waiting for the frame after the gap…')
    await sleep(15000)

    state = await panelState(panel)
    const afterGap = state.streams.find((stream) => stream.url === beforeGap?.url)
    check(
      'the same stream keeps capturing after the gap',
      afterGap !== undefined && afterGap.id === beforeGap?.id && afterGap.eventCount >= 2,
      `events=${afterGap?.eventCount ?? 0} state=${afterGap?.state ?? 'gone'}`,
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

    // --- the Raw tab's JSON view ---------------------------------------------

    /*
     * Driven through real clicks on the real panel, because the point of this view
     * is what a person reads: a splitter that agrees with `panelState` in a unit
     * test can still render nothing on screen.
     */
    await page.click('[data-demo="fetch-deltas"]')
    await sleep(4000)

    const deltasRow = panel.locator('.stream-row', { hasText: '/deltas' }).first()
    await deltasRow.click()
    await sleep(400)

    /*
     * The panel follows the browser's UI language, which on this machine is
     * Chinese, so every label is matched in both dictionaries. Matching on the
     * label at all is the point: it proves the click landed on the tab it names
     * rather than on whatever happened to be at that position.
     */
    await panel.locator('.tabbar button').filter({ hasText: /Raw|原始/ }).first().click()
    await sleep(400)

    const bytes = await panel.locator('pre.payload').first().innerText()
    check(
      'the raw view still shows the wire text by default',
      bytes.includes('data:') && bytes.includes('"choices"'),
      `${bytes.slice(0, 40).replace(/\n/g, '\\n')}…`,
    )

    await panel.locator('.btn').filter({ hasText: /^JSON$/ }).first().click()
    await sleep(600)

    const frameRows = await panel.locator('.scroll .event').count()
    check(
      'the raw JSON view cuts the text into one row per frame',
      frameRows >= 10,
      `rows=${frameRows}`,
    )

    /*
     * A row parses nothing until it opens, which is what keeps expand-all on a
     * retained multi-megabyte tail cheap. Asserted rather than trusted because it
     * is the one property a later "simplification" would silently break.
     */
    const treesBefore = await panel.locator('.json-tree').count()
    check('closed raw frames render no tree', treesBefore === 0, `trees=${treesBefore}`)

    await panel
      .locator('.event-toolbar .btn')
      .filter({ hasText: /Expand all|全部展开/ })
      .first()
      .click()
    await sleep(900)

    /*
     * A key label is rendered with its punctuation as a child node, so the text
     * read back is `choices:` — stripped here rather than in the component, which
     * renders the colon on purpose.
     */
    const keyNames = (keys: string[]): string[] => keys.map((key) => key.replace(/:$/, ''))

    const treeKeys = await panel.locator('.json-key').allInnerTexts()
    check(
      'an expanded raw frame renders its payload as a JSON tree',
      keyNames(treeKeys).includes('choices') && keyNames(treeKeys).includes('model'),
      `keys=${new Set(keyNames(treeKeys)).size}`,
    )

    /*
     * Deep keys are mounted only when their parent opens, which is what keeps a
     * tree on a narrow panel from rendering thousands of rows at once. Driven by
     * real clicks until `content` appears, since "the same tree as the Events tab"
     * is exactly the claim that a per-tab copy of the renderer would break.
     */
    const firstRow = panel.locator('.scroll .event').first()
    for (let depth = 0; depth < 4; depth += 1) {
      const closedNode = firstRow.locator('button.json-toggle[aria-expanded="false"]')
      if ((await closedNode.count()) === 0) break
      await closedNode.first().click()
      await sleep(250)
    }
    const deepKeys = keyNames(await firstRow.locator('.json-key').allInnerTexts())
    check(
      'the raw tree opens deeper on click, like an event row',
      deepKeys.includes('content'),
      `content=${deepKeys.filter((key) => key === 'content').length}`,
    )

    await panel.screenshot({ path: '/tmp/sse-lens-raw-json.png' })
    console.log('  (info) panel screenshot: /tmp/sse-lens-raw-json.png')

    await panel
      .locator('.event-toolbar .btn')
      .filter({ hasText: /Collapse all|全部折叠/ })
      .first()
      .click()
    await sleep(900)
    const treesCollapsed = await panel.locator('.json-tree').count()
    check(
      'one button collapses every raw frame it expanded',
      treesCollapsed === 0,
      `trees=${treesCollapsed} keysShown=${treeKeys.length}`,
    )

    /*
     * NDJSON has no blank lines, so the same view has to cut records by line
     * instead — a different branch of the splitter, and the format a plain
     * `/ndjson` endpoint really returns.
     */
    await page.click('[data-demo="ndjson"]')
    await sleep(2500)
    // Selecting a stream replaced the list with its detail, so go back first.
    await panel.locator('.detail-head .btn').first().click()
    await sleep(400)
    await panel.locator('.stream-row').filter({ hasText: '/ndjson' }).first().click()
    await sleep(400)
    await panel.locator('.tabbar button').filter({ hasText: /Raw|原始/ }).first().click()
    await sleep(300)
    await panel.locator('.btn').filter({ hasText: /^JSON$/ }).first().click()
    await sleep(500)
    await panel
      .locator('.event-toolbar .btn')
      .filter({ hasText: /Expand all|全部展开/ })
      .first()
      .click()
    await sleep(700)
    const ndjsonKeys = keyNames(await panel.locator('.json-key').allInnerTexts())
    check(
      'an NDJSON raw body cuts one row per record',
      ndjsonKeys.includes('seq') && ndjsonKeys.includes('text'),
      `keys=${new Set(ndjsonKeys).size}`,
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
