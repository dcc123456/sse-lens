/**
 * Side-panel entry point.
 *
 * `StrictMode` is deliberately omitted. In development it double-invokes effects,
 * and this panel's mount effect sends `panel.opened`, which *arms a tab* — an
 * externally visible action, not a pure state update. Double-firing it would make
 * the dev build behave differently from production in the one place where arming
 * is decided. The panel has no other effects that benefit from the checks.
 *
 * @module panel/main
 */

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('SSE Lens: panel root element is missing from index.html')
}

createRoot(container).render(<App />)
