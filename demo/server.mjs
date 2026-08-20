/**
 * Local streaming server for manual verification.
 *
 * Plain `node:http` with no dependencies, so it runs from a fresh clone. It exists
 * because the interesting behaviours cannot be checked against a public endpoint:
 * a mislabelled content type, a stream truncated mid-event, and an abort all have
 * to be produced deliberately.
 *
 * Run: `node demo/server.mjs`, then open http://127.0.0.1:8787/
 *
 * Serving over http rather than opening the file directly is required, not a
 * convenience: Chrome forbids content scripts on `file://` without a separate
 * opt-in, so the hook would never attach.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Words for the delta demo, so the merged text is recognisably a sentence. */
const SENTENCE = [
  'Server',
  '-sent',
  ' events',
  ' arrive',
  ' one',
  ' frame',
  ' at',
  ' a',
  ' time',
  ',',
  ' which',
  ' is',
  ' exactly',
  ' why',
  ' they',
  ' are',
  ' hard',
  ' to',
  ' read',
  ' raw',
  '.',
]

function sseHeaders(response, contentType = 'text/event-stream') {
  response.writeHead(200, {
    'content-type': contentType,
    // Without these a proxy or the browser may buffer, and the stream arrives as
    // one lump — which would make the demo prove nothing.
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

const routes = {
  /** Framed SSE with comments, custom types, ids and a retry directive. */
  async '/sse'(request, response, url) {
    const contentType = url.searchParams.get('as') ?? 'text/event-stream'
    const gap = url.searchParams.get('slow') === '1' ? 400 : 90
    sseHeaders(response, contentType)

    // A comment frame: invisible to EventSource consumers, visible in raw capture.
    response.write(': stream open, this is a comment\n\n')
    response.write('retry: 3000\n\n')

    for (let index = 1; index <= 12; index += 1) {
      if (response.writableEnded) return
      response.write(`id: ${index}\nevent: message\ndata: frame ${index} of 12\n\n`)
      // A heartbeat every few frames, as a real long-lived stream sends.
      if (index % 4 === 0) response.write(': keep-alive\n\n')
      await sleep(gap)
    }
    response.write('data: [DONE]\n\n')
    response.end()
  },

  /** OpenAI-shaped incremental deltas. */
  async '/deltas'(request, response) {
    sseHeaders(response)
    const id = `chatcmpl-demo-${Date.now()}`

    response.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        model: 'demo-1',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' } }],
      })}\n\n`,
    )

    for (const word of SENTENCE) {
      if (response.writableEnded) return
      response.write(
        `data: ${JSON.stringify({
          id,
          choices: [{ index: 0, delta: { content: word } }],
        })}\n\n`,
      )
      await sleep(70)
    }

    response.write(
      `data: ${JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: SENTENCE.length },
      })}\n\n`,
    )
    response.write('data: [DONE]\n\n')
    response.end()
  },

  /** One JSON object per line, no SSE framing. */
  async '/ndjson'(request, response) {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-cache, no-transform',
    })
    for (let index = 1; index <= 8; index += 1) {
      if (response.writableEnded) return
      response.write(`${JSON.stringify({ seq: index, text: `line ${index}`, done: index === 8 })}\n`)
      await sleep(110)
    }
    response.end()
  },

  /** Ends deliberately mid-event, to exercise the tail warning. */
  async '/truncated'(request, response) {
    sseHeaders(response)
    response.write('data: this frame is complete\n\n')
    await sleep(150)
    response.write('data: this frame is complete too\n\n')
    await sleep(150)
    // No blank line: the parser must hold this as an unterminated tail.
    response.write('data: this frame never term')
    response.end()
  },

  /** For EventSource, including a custom event type. */
  async '/events'(request, response) {
    sseHeaders(response)
    response.write(': comment the browser will hide from us\n\n')
    let index = 0
    const timer = setInterval(() => {
      if (response.writableEnded) {
        clearInterval(timer)
        return
      }
      index += 1
      response.write(`id: ${index}\ndata: message ${index}\n\n`)
      if (index % 3 === 0) response.write(`event: tick\ndata: ${new Date().toISOString()}\n\n`)
      if (index >= 30) {
        clearInterval(timer)
        response.end()
      }
    }, 700)
    request.on('close', () => clearInterval(timer))
  },

  /** A non-streaming response, which must not be captured. */
  async '/json'(request, response) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, note: 'This must NOT appear in the panel.' }))
  },
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)

  if (url.pathname === '/' || url.pathname === '/index.html') {
    readFile(join(HERE, 'index.html')).then(
      (body) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(body)
      },
      () => {
        response.writeHead(500)
        response.end('Could not read demo/index.html')
      },
    )
    return
  }

  const handler = routes[url.pathname]
  if (!handler) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('Not found')
    return
  }

  handler(request, response, url).catch(() => {
    // A client that navigated away mid-stream is normal, not an error worth
    // crashing a demo server over.
    if (!response.writableEnded) response.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`SSE Lens demo server: http://127.0.0.1:${PORT}/\n`)
})
