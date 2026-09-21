# SSE Lens

**English** · [简体中文](./README.zh-CN.md)

A Chrome extension that renders the **current tab's** Server-Sent Events in a readable side panel: framed events, JSON trees, reassembled LLM deltas, and the raw bytes.

Built because the DevTools Network tab shows SSE as one growing blob of `data:` lines. That is technically complete and practically unreadable — especially for a token-by-token LLM stream, where the thing you actually want (the answer) is spread across four hundred frames.

<img width="3803" height="1943" alt="image" src="https://github.com/user-attachments/assets/e4068070-55d4-44f2-98d2-2e0f9120cd79" />


---

## Why you would use this

| Situation | What DevTools gives you | What SSE Lens gives you |
| --- | --- | --- |
| **Debugging an LLM app** — is the model returning nonsense, or is your client reassembling it wrong? | 400 `data:` lines to read by eye | The reassembled answer, plus the JSON path it came from so you can check the guess |
| **A stream stops halfway** | A response that just… ends | Where it stopped, whether the last frame was complete, and the exact trailing bytes |
| **"It works in curl but not in the browser"** | Two things you cannot compare | A runnable `curl` reproduction generated from the real request |
| **The client sees no events at all** | No indication why | Whether frames arrived and were malformed, or never arrived — a mislabelled `content-type` is visible immediately |
| **A reasoning model returns two text streams** | Both interleaved | `content` and `reasoning_content` distinguished, so the scratchpad is not mistaken for the answer |
| **Filing a bug report** | Screenshots | JSON/NDJSON export, with a note recording what was masked or dropped |

Common users: anyone integrating OpenAI / Anthropic / Gemini / Ollama or an in-house gateway; developers of chat UIs, live dashboards, progress feeds, or notification streams.

**Not the right tool for:** WebSockets, plain (non-streaming) REST, or replaying and modifying requests. See [Scope](#scope).

---

## What it does

| Capability | Notes |
| --- | --- |
| Event timeline | Every frame with its `event`, `id`, `retry`, comments, and offset from stream start |
| Expand / collapse all | One button, labelled by state: **▾ Expand all** until everything is open, then **▴ Collapse all** |
| JSON tree | Collapsible, per frame, with the common shapes pre-expanded |
| Merged deltas | Reassembles incremental text and **names the field it came from**, so the guess is checkable |
| Raw text | The exact bytes, for when framing itself is the bug |
| Request details | Headers, body, and a runnable `curl` reproduction |
| Export | JSON or NDJSON, each carrying a note about what was masked or dropped |
| Bilingual | English / 简体中文, following the browser or set explicitly |

Captures `fetch`, `XMLHttpRequest` and `EventSource`, in the top frame and iframes.

---

## Install

Requires **Chrome 116+** (for the Side Panel API) and [pnpm](https://pnpm.io/).

```bash
git clone git@github.com:dcc123456/sse-lens.git
cd sse-lens
pnpm install
pnpm build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`dist/`** folder — not the project root

> After any `pnpm build`, click the **↻ reload** icon on the SSE Lens card. Service-worker changes are not picked up otherwise.

---

## Usage

### 1. Open the panel

Click the SSE Lens toolbar icon. The panel opens on the right and follows whichever tab you are looking at — there is nothing to select.

### 2. Reload the page you want to inspect

**This step matters, and skipping it is the most common reason for seeing nothing.** The hook must replace `fetch` *before* any page script captures a reference to it. A page that was already open when you installed or opened the panel has already run. See [why](#why-reloading-matters).

### 3. Trigger the stream

Use the app normally — send a chat message, open the dashboard. Streams appear in the panel as they start.

### 4. Read it

| Tab | Use it for |
| --- | --- |
| **Events** | Frame-by-frame timeline; expand any frame for its JSON tree |
| **Merged** | The reassembled text, with the JSON path it was taken from |
| **Raw** | Exact bytes, when you suspect the framing itself |
| **Request** | Headers, body, and a `curl` reproduction to copy |

Use **Export** for a bug report. The **⚙** tab holds language, capture on/off, extra headers to redact, and size limits.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Panel says the page cannot be inspected | You are on `chrome://`, the Web Store, or another extension's page. Chrome forbids extensions there; switch to an ordinary `http(s)` page. |
| Nothing appears when the stream runs | Reload the page with the panel already open (step 2). |
| A tab open before the extension loaded | The panel detects the missing hook and shows **Not listening on this page yet**; click **Start listening** (or the **⊕** in the top bar). It injects the hook per-frame without reloading. See [Attaching to a page after load](#attaching-to-a-page-after-load). |
| Still nothing after a rebuild | Click **↻** on the SSE Lens card in `chrome://extensions`. |
| `EventSource` shows no comments or heartbeats | Expected, and labelled in the UI — the browser consumed those bytes before the hook could see them. See [Fidelity](#fidelity-differs-by-transport). |
| Long stream appears truncated | Windowing and quotas. Dropped frames are always **counted and reported**, never silently omitted. |

---

## Try it without a real API

A local server reproduces every capture path, including ones no public endpoint will give you on demand — a mislabelled content type, a stream truncated mid-event, an abort:

```bash
pnpm demo      # http://127.0.0.1:8787/
```

Open that URL with the panel open (reload once) and click the buttons. Two cases are worth checking deliberately: **plain JSON** must *not* appear in the panel, and **fidelity** asserts the page still receives a correct, complete response after the hook rebuilt it.

To check the parser against real bytes off a socket, with the server running:

```bash
pnpm verify
```

`pnpm verify` is deliberately separate from `pnpm test`: it needs the server, and a suite that fails when a server is absent is a suite people learn to ignore. It closes the one gap unit tests cannot — every unit test feeds the parser text *this repository wrote*, so a wrong assumption about real SSE framing would be invisible to all of them.

---

## Privacy

This extension reads network payloads, so the posture is deliberate:

- **Redaction happens in the page, before data crosses any boundary**, and again in the worker. `authorization`, `cookie`, `x-api-key` and friends are always masked; extra header names can be added in settings. Bearer/Basic tokens and `sk-`/`ghp_`-style literals are masked inside bodies too.
- **Captures live only in `chrome.storage.session`** — memory-backed, cleared when the browser closes, never written to disk. A capture can contain a credential even after redaction (an unexpected header, a session id in a payload), so it must not outlive the debugging session that justified collecting it.
- **One tab at a time.** The hook is installed everywhere but stays inert until the worker arms the tab you opened the panel over. Switching tabs disarms the old one explicitly, because a page keeps capturing until told otherwise.
- **Nothing leaves the browser.** No network requests, no analytics, no remote code.
- Permissions requested: `storage`, `tabs`, `sidePanel`, and host access for `http`/`https`. Not requested: `webRequest`, `debugger`, `scripting`, `unlimitedStorage`, `downloads`.

Note the honest limit: `window.postMessage` is a public channel, so a hostile page could *forge* a capture record. It cannot read one, and the worker takes `tabId`/`frameId` from the message sender rather than the payload, so a forgery can only appear in the panel for the tab that made it. No private channel exists across the MAIN/ISOLATED boundary; this is the floor, and it is an acceptable one for a debugging tool.

---

## Scope

**In:** SSE and text streaming over `fetch`, `XMLHttpRequest`, `EventSource`; the current tab; top frame and iframes.

**Out, for now:** WebSocket and WebTransport; cross-tab history archiving; modifying or replaying requests; importing recordings captured elsewhere. Each is a different tool, and pretending otherwise would make this one worse at what it does.

---

## Design notes

### Why the page's own `fetch` gets patched

MV3 offers no way for an extension to read a response body:

| Approach | Why it does not work |
| --- | --- |
| `chrome.webRequest` | Headers only. Response bodies were never exposed, and MV3 made it observe-only. |
| `chrome.declarativeNetRequest` | Declarative by design — it can block and redirect, but never observe content. |
| `chrome.debugger` / CDP | Works, but banners the tab with "being debugged" and fights DevTools for the session. Unacceptable for a tool you leave on. |
| Patching the page's primitives | The only remaining seam. |

So a `world: 'MAIN'` content script replaces `fetch`, `XMLHttpRequest` and `EventSource` at `document_start`.

### Why reloading matters

The hook must install *before* any page script captures a reference. A bundle that does `const f = window.fetch` at module scope keeps the original function forever, and a hook that arrives afterwards sees nothing. `document_start` guarantees this for pages loaded after the extension — but a page that was already open has already run. Hence the reload.

For streams a page opens during its own bootstrap there is a second problem: the arm state arrives asynchronously (the MAIN world has no `chrome.*`), so it may not have arrived yet. Early traffic goes into a bounded ring buffer and is flushed or discarded once the answer comes back — otherwise the most common case of all, a streaming app starting a request on load, would be missed.

### The rule the hook obeys

**The page must behave exactly as it would without this extension.** A debugging tool that changes the thing being debugged is worse than no tool. Concretely:

- `response.body.tee()`, never `response.clone()`. `clone()` buffers without bound when one consumer reads slower than the other — on a long-lived SSE connection that is an unbounded leak inside the user's page. This side always drains at network speed, so its `tee` buffer stays near zero.
- Rebuilding a `Response` loses `url`, `redirected` and `type` — prototype getters with no constructor equivalent. They are restored explicitly, because a page resolving relative links against `response.url` must not suddenly see `''`.
- Requests that are not captured return the **original object**, not a copy, so identity comparisons and non-standard properties survive.
- Every wrapper is guarded and falls back to native behaviour. A bug here degrades to "no capture", never to "the page broke".

### Attaching to a page after load

A common request is "the page is already loaded — give me a button to start listening". It turns out to cover **two very different situations**, and only one is fixable by injection, so the panel distinguishes them rather than promising the same fix for both.

| Situation | What is actually happening | Recoverable? |
| --- | --- | --- |
| The tab was open before the extension was installed/reloaded | Chrome never injected the content script into that tab at all | **Yes** — `chrome.scripting.executeScript` places it on demand |
| The hook is present and the page calls `window.fetch` | Already captured; no action needed | N/A |
| The hook is present, but the page saved `const f = window.fetch` before `document_start` | The page holds the *original* function; patching `window.fetch` later cannot reach it | **No** — only a reload helps |

The first case is what the **Start listening** button fixes. It is why the `scripting` permission exists — it is used *only* for this recovery, never during normal operation. The injected files are read from the running manifest's own `content_scripts`, so a bundle hash change cannot silently break them.

The boundary is not theoretical; it was established in a real browser. A page aliasing `fetch` via an init script before the hook runs genuinely misses its stream, while a `window.fetch` call from the same page in the same session is captured. Reporting those two as identical success would make the button look like it works on most pages and fail silently on exactly the bundled applications that are hardest to debug. So the panel says so: attach applies to **later requests only**, a request already in flight is gone, and the "already listening" result points at the early-alias case and suggests a reload.

Detecting the missing-hook case has its own traps, and both were real bugs caught by `pnpm e2e:attach`:

1. **The probe must not be an instruction.** The worker probes each tab with `tabs.sendMessage` to tell "no content script" (reject) from "idle page" (resolve). The first probe reused `armMessage(false)`, and because that probe ran on every state refresh, it silently disarmed the tab under inspection — capture appeared to work and then stopped. A fake relay has no arm state to lose, so no unit test could see it. The probe is now an inert `{type:'probe'}` that the relay answers without acting on.

2. **The arm must wait for a freshly injected relay.** `executeScript` resolves when the relay *loader* is queued, before its dynamically imported chunk has registered the `onMessage` listener. Sending the arm instruction immediately meant it could land before the listener existed and be silently dropped — the attach reported success while later requests were still missed. The attach now polls the probe in each frame it injected and only arms once the relay answers, with a 1.5s cap.

3. **Injection is per-frame, not `allFrames: true`.** That call is atomic across frames, so a single inaccessible subframe (a cross-origin frame without host access, an odd scheme) makes it reject and leaves the top frame un-injected. Since SSE originates in the top frame in essentially every case, each frame is injected on its own; the top frame is required, subframes are best-effort and skipped when their URL is non-`http(s)`. This was confirmed against a page carrying cross-origin, `about:blank` and `data:` iframes at once.

### Following the current tab

The panel always shows whichever tab you are looking at. Switching tabs, switching windows, or closing the armed tab all re-point it automatically — there is no "select this page" button, because a panel scoped to "the current page" should not need to be told what the current page is.

This is safe only because captures are stored **per tab**: switching away disarms a tab but never discards what it already collected, so switching back restores it.

Making that reliable needs two things that are easy to get wrong:

- **A port, not a guess.** Chrome fires no side-panel close event, so the panel holds a `chrome.runtime.connect` port for its lifetime. It carries no data; `onConnect`/`onDisconnect` is simply the only truthful answer to "is a panel watching right now?". Inferring it from message traffic meant the worker could not distinguish a closed panel from a quiet one.
- **Persisting the arm state.** MV3 evicts an idle worker after ~30 seconds, and an SSE stream is idle between frames far longer than that. The arm state therefore lives in `chrome.storage.session` alongside the captures. Without this, a worker evicted while the panel sat idle restarted believing nothing was watching, then refused to arm the next tab selected — the panel showed "no page selected" until it was closed and reopened. Holding the port also keeps the worker alive during an active session, which removes most evictions in the first place.

`tests/arm.spec.ts` simulates eviction by round-tripping the state through JSON, because every other test in that file drives one controller through a single continuous life — precisely the assumption eviction breaks.

### Page messages are applied in arrival order

`handlePageMessage` is `async`: it awaits settings, arm state and tab hydration before touching the store. Those awaits are suspension points, so without a queue several messages from the same tab can be in flight at once and resume in any order.

That is fatal, because the store is order-dependent: `stream.headers` and `stream.chunk` resolve a record created by `stream.open`, and if `open` has not finished they find nothing. Messages are therefore chained **per tab** — one slow tab cannot delay another, but a tab's own messages are always applied in the order they arrived.

This caused a real, user-visible bug: capture worked on a page that was already loaded, then stopped after navigating. A page that streams during bootstrap sends its first frames while the worker is still doing its lazy first-message initialisation, so the awaits genuinely suspend; a page that streams later awaits nothing unresolved and stays ordered by luck. The observed resume order was `headers`, `chunk`, `open` — so the stream appeared in the panel with zero events.

Relatedly, `CaptureStore` **counts** messages it cannot match to a stream (`orphanCount`). This bug stayed hidden for as long as it did because those drops were silent, and a debugging tool that quietly discards data is worse than one that admits it.

### The bulk expand toggle

One button in a sticky toolbar above the frames. It reads **▾ Expand all** until every loaded frame is open, then **▴ Collapse all** — and it drives the JSON tree inside each row too, since expanding a row that still hides its payload would be a half-measure.

Two separate mechanisms sit behind it, because a flat list and a nested tree need different things. Both live in `src/panel/bulk.ts` so they cannot drift apart.

**The event list lifts row state into the parent.** A button whose label reflects reality has to be able to ask "is everything open?", and it cannot ask rows that each hold their own answer privately. But the obvious lifted form — a `Set` of open row ids — is wrong for a live stream:

| Representation | What breaks |
| --- | --- |
| `Set` of open ids | A frame arriving after "expand all" is not in the set, so it renders collapsed while the button still says "collapse all" — the label contradicts the screen |
| Baseline mode + exceptions | A new row has no exception recorded, so it inherits the baseline and matches what the user chose |

So the state is a mode (`collapsed`/`expanded`) plus the rows that *deviate* from it. The meaning of an entry inverts with the mode, which is exactly what makes "everything is open, including rows that do not exist yet" representable.

**The JSON tree keeps local state and consumes one-shot instructions.** Lifting every node in an arbitrarily deep tree would mean rebuilding paths on each toggle. Instead each instruction carries a **nonce**, because a boolean cannot express either half of what is needed:

| Design | How it fails |
| --- | --- |
| Latching boolean override | Overrides every later click, so collapsing one branch by hand snaps straight back open |
| Plain boolean, react to changes | Pressing the button a second time produces an identical value, nothing changes, and the button looks dead |

A nonce makes each press a distinct event that every node consumes exactly once, then hands control back to local state.

Bulk actions only reach the frames currently mounted — a long stream is windowed — so the toolbar states the count (`80/2431`) rather than implying it touched everything, and the label is judged against the visible window only.

### Fidelity differs by transport

| Transport | What is captured | Limitation |
| --- | --- | --- |
| `fetch` | Raw bytes | None — exact framing, comments and heartbeats preserved |
| `XMLHttpRequest` | `responseText` increments | None for text; a `blob`/`arraybuffer` responseType is reported as *unreadable* rather than omitted |
| `EventSource` | Reconstructed from parsed DOM events | **Comments and exact framing are unavailable** — the browser consumed the bytes first |

The UI labels the `EventSource` case rather than letting you infer the server sent no heartbeats. Throughout, the same principle applies to quota trimming: dropped frames are counted and reported, because a gap presented as a complete record produces false conclusions.

### Merging deltas without a vendor table

Every streaming API nests its incremental text differently — `choices[].delta.content`, `delta.text`, `candidates[].content.parts[].text`, `response`, and whatever an in-house gateway invented. Matching a hard-coded list would silently produce nothing for the next API and for every internal one.

Instead the merge *discovers* the field: across a stream, an incremental text field recurs at the same path in most frames, while an id or a model name appears once and a `role` never changes. Known field names are preferred over unknown ones — which is what stops a reasoning model's `reasoning_content` scratchpad being presented as its answer — and coverage decides among the rest.

A cumulative style (each frame repeats everything so far) is detected separately and takes the last value, because concatenating those produces quadratic garbage.

The panel always shows which path it used, so the guess is checkable rather than magic.

---

## Development

```bash
pnpm dev         # watch build
pnpm typecheck   # tsc --noEmit, for both the extension and demo/
pnpm test        # unit and integration tests
pnpm build       # production dist/
pnpm e2e         # real browser, real extension (needs pnpm build first)
pnpm e2e:attach  # real-browser check for the post-load attach path
pnpm icons       # regenerate PNGs (pure Node, no image deps)
```

### Layout

```
src/
  inpage/hook-install.ts   the hook itself — testable against a fake global
  inpage/hook.ts           MAIN-world entry: wires it to the real window
  content/relay.ts         ISOLATED bridge; validates before forwarding
  background/
    index.ts               message routing, persistence, lifecycle
    store.ts               capture state and quota enforcement
    arm.ts                 which tab is being captured (the privacy boundary)
    settings.ts            validated, clamped preferences
  lib/
    sse.ts                 WHATWG-conformant stream parser
    redact.ts              masking, before truncation
    deltas.ts              delta discovery and merging
    export.ts              JSON / NDJSON / curl
    i18n.ts                type-closed bilingual dictionary
    messages.ts            the wire protocol between all four contexts
  panel/
    bulk.ts                expand/collapse state for the list and the tree
    ...                    React side panel
demo/
  server.mjs               no-dependency streaming server
  verify.mjs               protocol-level checks against it
  browser-check.mts        real Chromium + real extension (pnpm e2e)
```

### Testing notes

The suite covers the SSE parser against the WHATWG rules (BOM handling, `\r\n` split across chunks, bare `\r`, NUL in `id`), redaction, quota eviction, the arm-state transitions, delta discovery against real OpenAI/Anthropic/Gemini/Ollama shapes, and the hook's page-fidelity guarantees.

Two tests exist specifically because their absence would hide a real bug:

- **Response identity** — a non-captured request must return the same object reference, not an equivalent copy.
- **XHR increments** — `responseText` is cumulative, so forwarding it whole on each progress event would show every frame N times.

#### Unit tests were not enough

`tests/worker-lifecycle.spec.ts` boots the **real** `background/index.ts` against `tests/harness.ts`, a `chrome` fake that actually dispatches events — tab switches, window focus changes, port connects, navigation, worker eviction.

It exists because a "capture stops after switching pages" report arrived while 316 tests were passing. Every one of those exercised `CaptureStore` or `ArmController` *directly*; nothing had ever executed the module that wires them to Chrome's lifecycle, so every bug in the wiring was invisible. The older `tests/fake-chrome.ts` even stubs `addListener` as a no-op, which made that gap structural rather than accidental.

Two properties of the harness are load-bearing:

- **`sendConcurrently`** delivers messages without awaiting each reply, which is how Chrome really behaves. Awaiting each one serialises the worker's handlers and hides every ordering bug — the original fault was only reproducible under genuine interleaving.
- **`evict()`** drops listeners while keeping storage, so worker eviction can be tested rather than reasoned about.

Bugs found this way, each noted in a comment at the relevant code with its failure mode named: a redaction leak, a delta mis-ranking, arm state lost to eviction, and page messages applied out of order.

#### Nor was a fake browser enough

`pnpm e2e` (`demo/browser-check.mts`) launches a real Chromium with the real unpacked `dist/`, opens the panel, and asserts on the state the panel actually receives while navigating and switching tabs. A fake `chrome` object encodes beliefs about Chrome; only a browser can refute them.

It immediately falsified two of mine:

- The panel page and the service worker are **not** interchangeable message peers. `chrome.runtime.sendMessage` never dispatches to the sender's own context, so a worker asking *itself* for state receives `undefined` — with a `?? fallback` that read as "nothing captured", failing every assertion for a reason that did not exist.
- Playwright's default `--disable-extensions` silently overrides `--load-extension`, and stable Chrome 151 ignores the flag entirely. Both fail *quietly*: Chrome starts, reports no error, loads nothing. Worse, `serviceWorkers()[0]` then returns a **built-in** component extension's worker, so a naive "the worker started" check passes against an extension that was never loaded. The script therefore identifies its worker by manifest name.

Note what this script does **not** do: with the per-tab queue reverted, it still passes. It exercises navigation and tab switching faithfully, but a locally hosted page cannot reliably reproduce the bootstrap-timing window that the ordering bug needs — the request completes too quickly for the worker's lazy initialisation to interleave. The unit-level `sendConcurrently` test is what pins that fault down. Both layers are necessary: the browser proves the wiring is real, the harness proves the ordering is correct.

#### A flake worth naming

Vitest's default forked-process pool intermittently dies on Windows with `VirtualAlloc failed` or `spawn UNKNOWN` *before any test runs*, which surfaces as a bare exit 1 with no failing test. `pool: 'threads'` is set in `vite.config.ts` for that reason.

Under heavy memory pressure (many leftover browser processes), a thread can also be starved badly enough that a purely synchronous assertion reports a ~6s duration and fails. That is the environment, not the code: it does not reproduce, and the assertion involved touches no timers.

---

## License

MIT
