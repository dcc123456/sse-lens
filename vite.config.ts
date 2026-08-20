import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [
    react(),
    crx({
      manifest,
      contentScripts: {
        /**
         * The MAIN-world hook must be a self-contained IIFE.
         *
         * CRXJS normally emits a content script as an ES module plus a loader
         * that `import()`s it. In the MAIN world that loader would fetch the
         * chunk as a page resource and, more importantly, defer execution past
         * `document_start` — exactly the timing this hook cannot afford. Built
         * standalone, all imports are inlined and the patch lands synchronously
         * before any page script runs.
         */
        standaloneFiles: ['src/inpage/hook.ts'],
      },
    }),
  ],
  build: {
    target: 'chrome116',
    // Extension pages are loaded from disk; readable output helps debugging.
    minify: false,
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    /*
     * Threads, not the default forked processes.
     *
     * The fork pool intermittently dies on this Windows setup with
     * `VirtualAlloc failed` / `spawn UNKNOWN` before any test runs — an allocation
     * failure while spawning, unrelated to the tests themselves. It presents as a
     * bare exit code 1 with no failing test, which is easy to misread as a real
     * regression.
     */
    pool: 'threads',
  },
})
