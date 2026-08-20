/**
 * Bulk expand/collapse tests.
 *
 * The rule these guard is small but has two opposing requirements that are easy to
 * satisfy one at a time and break together:
 *
 * 1. An instruction must apply *once*, so a manual click afterwards is not undone.
 * 2. A repeated instruction must still apply, so pressing "expand all" twice works.
 *
 * The obvious implementation — a boolean `forceOpen` prop — satisfies neither: it
 * latches, overriding every later click, and a second identical press produces no
 * observable change at all. Each case below names the symptom it prevents.
 */

import { describe, expect, it } from 'vitest'
import { resolveBulk, type BulkToggle } from '../src/panel/components'

/**
 * Drives one node through a sequence of renders and clicks.
 *
 * Mirrors what the component does: `resolveBulk` on every render, with the
 * returned nonce persisted in a ref, and local clicks in between.
 */
class Node {
  open: boolean
  private appliedNonce: number

  constructor(initialOpen: boolean, initialNonce = 0) {
    this.open = initialOpen
    this.appliedNonce = initialNonce
  }

  /** One render pass with the given instruction. */
  render(bulk: BulkToggle | undefined): this {
    const decision = resolveBulk(bulk, this.appliedNonce, this.open)
    this.appliedNonce = decision.nonce
    if (decision.apply) this.open = decision.open
    return this
  }

  /** A user clicking this node's own toggle. */
  click(): this {
    this.open = !this.open
    return this
  }
}

describe('resolveBulk', () => {
  it('does nothing when no instruction is present', () => {
    // Trees rendered without bulk control must keep working unchanged.
    expect(resolveBulk(undefined, 0, false)).toEqual({ apply: false, open: false, nonce: 0 })
    expect(resolveBulk(undefined, 3, true)).toEqual({ apply: false, open: true, nonce: 3 })
  })

  it('applies a new instruction', () => {
    const decision = resolveBulk({ open: true, nonce: 1 }, 0, false)
    expect(decision.apply).toBe(true)
    expect(decision.open).toBe(true)
    expect(decision.nonce).toBe(1)
  })

  it('ignores an instruction it has already consumed', () => {
    // Guards the core symptom: without this, every re-render would re-apply the
    // last expand-all and a manually collapsed node could never stay collapsed.
    const decision = resolveBulk({ open: true, nonce: 1 }, 1, false)
    expect(decision.apply).toBe(false)
    expect(decision.open).toBe(false)
  })

  it('consumes the nonce even when the state already matches', () => {
    // Otherwise a redundant instruction would stay pending and fire later,
    // reverting a click the user made in between.
    const decision = resolveBulk({ open: true, nonce: 4 }, 1, true)
    expect(decision.apply).toBe(false)
    expect(decision.nonce).toBe(4)
  })
})

describe('bulk expand/collapse behaviour', () => {
  it('expands a collapsed node', () => {
    const node = new Node(false).render({ open: true, nonce: 1 })
    expect(node.open).toBe(true)
  })

  it('collapses an expanded node', () => {
    const node = new Node(true).render({ open: false, nonce: 1 })
    expect(node.open).toBe(false)
  })

  it('lets a manual collapse survive re-renders after expand-all', () => {
    // The bug a latching boolean would cause: the node reopens on next render.
    const bulk: BulkToggle = { open: true, nonce: 1 }
    const node = new Node(false).render(bulk)
    expect(node.open).toBe(true)

    node.click()
    expect(node.open).toBe(false)

    node.render(bulk).render(bulk).render(bulk)
    expect(node.open).toBe(false)
  })

  it('re-expands on a second press of the same button', () => {
    // The bug a bare boolean would cause: the button looks dead the second time.
    const node = new Node(false).render({ open: true, nonce: 1 })
    node.click()
    expect(node.open).toBe(false)

    node.render({ open: true, nonce: 2 })
    expect(node.open).toBe(true)
  })

  it('survives many alternating presses and clicks', () => {
    const node = new Node(false)
    let nonce = 0
    for (let round = 1; round <= 20; round += 1) {
      nonce += 1
      node.render({ open: true, nonce })
      expect(node.open, `expand round ${round}`).toBe(true)
      node.click()
      expect(node.open, `manual collapse round ${round}`).toBe(false)
      node.render({ open: true, nonce })
      expect(node.open, `stays collapsed round ${round}`).toBe(false)
    }
  })

  it('applies the current instruction to a node mounted afterwards', () => {
    // Frames arriving mid-stream should match the state the user chose, rather
    // than appearing collapsed underneath an active expand-all.
    const bulk: BulkToggle = { open: true, nonce: 7 }
    // A fresh row starts closed and has consumed no nonce.
    const late = new Node(false).render(bulk)
    expect(late.open).toBe(true)
  })

  it('keeps independent nodes independent', () => {
    const bulk: BulkToggle = { open: true, nonce: 1 }
    const first = new Node(false).render(bulk)
    const second = new Node(false).render(bulk)

    first.click()
    first.render(bulk)
    second.render(bulk)

    expect(first.open).toBe(false)
    expect(second.open).toBe(true)
  })

  it('collapse-all overrides a node the user just expanded', () => {
    // Bulk instructions are newer than the click, so they must win.
    const node = new Node(false)
    node.click()
    expect(node.open).toBe(true)
    node.render({ open: false, nonce: 1 })
    expect(node.open).toBe(false)
  })

  it('treats nonce 0 as already consumed for a node that starts with it', () => {
    // The initial state is not an instruction: a tree must open at its default
    // depth rather than being forced closed by the starting toggle value.
    const node = new Node(true, 0).render({ open: false, nonce: 0 })
    expect(node.open).toBe(true)
  })
})
