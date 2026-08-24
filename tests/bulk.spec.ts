/**
 * Bulk expand/collapse tests.
 *
 * Two mechanisms are covered, because the panel needs both and they fail in
 * different ways.
 *
 * `BulkSelection` backs the event list's single toggle. Its hard requirement is
 * that a frame arriving *after* "expand all" appears expanded — otherwise the
 * button's label would contradict what is on screen. A plain `Set` of open ids
 * cannot do that, which is why the representation is a baseline plus exceptions.
 *
 * `resolveBulk` backs the JSON tree, whose nodes keep local state. Its requirements
 * oppose each other and are easy to satisfy one at a time: an instruction must
 * apply *once* (so a later manual click is not undone) yet a *repeated* instruction
 * must still apply (so pressing the button twice works). A boolean prop satisfies
 * neither — it latches, and a second identical press is invisible.
 *
 * Each case below names the symptom it prevents.
 */

import { describe, expect, it } from 'vitest'
import {
  allRowsOpen,
  isRowOpen,
  nextBulk,
  resolveBulk,
  setAllRows,
  toggleRow,
  COLLAPSED,
  NO_BULK,
  type BulkToggle,
} from '../src/panel/bulk'

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

  it('never emits a repeated nonce', () => {
    // Two presses sharing a nonce would make the second one invisible.
    let bulk = NO_BULK
    const seen = new Set<number>([bulk.nonce])
    for (let press = 1; press <= 50; press += 1) {
      bulk = nextBulk(bulk, press % 2 === 0)
      expect(seen.has(bulk.nonce), `nonce ${bulk.nonce} repeated`).toBe(false)
      seen.add(bulk.nonce)
    }
  })
})

describe('BulkSelection: which rows are open', () => {
  it('starts with everything collapsed', () => {
    expect(isRowOpen(COLLAPSED, 1)).toBe(false)
    expect(isRowOpen(COLLAPSED, 999)).toBe(false)
  })

  it('toggles one row without disturbing its neighbours', () => {
    const selection = toggleRow(COLLAPSED, 5)
    expect(isRowOpen(selection, 5)).toBe(true)
    expect(isRowOpen(selection, 4)).toBe(false)
    expect(isRowOpen(selection, 6)).toBe(false)
  })

  it('toggles a row back closed', () => {
    const selection = toggleRow(toggleRow(COLLAPSED, 5), 5)
    expect(isRowOpen(selection, 5)).toBe(false)
  })

  it('does not mutate the selection it was given', () => {
    // React relies on identity to detect the change, and a shared mutable Set
        // would leak state between renders.
    const before = toggleRow(COLLAPSED, 1)
    const after = toggleRow(before, 2)
    expect(isRowOpen(before, 2)).toBe(false)
    expect(after).not.toBe(before)
    expect(COLLAPSED.exceptions.size).toBe(0)
  })

  it('expands rows that do not exist yet — the live-stream requirement', () => {
    // The reason a Set of open ids is the wrong representation: a frame arriving
    // after expand-all would be absent from it and render collapsed, while the
    // button still claimed everything was open.
    const selection = setAllRows(true)
    expect(isRowOpen(selection, 1)).toBe(true)
    expect(isRowOpen(selection, 100_000)).toBe(true)
  })

  it('collapses rows that do not exist yet', () => {
    const selection = setAllRows(false)
    expect(isRowOpen(selection, 7)).toBe(false)
  })

  it('lets one row be closed again after expand-all', () => {
    const selection = toggleRow(setAllRows(true), 3)
    expect(isRowOpen(selection, 3)).toBe(false)
    // Everything else, including future rows, stays open.
    expect(isRowOpen(selection, 4)).toBe(true)
    expect(isRowOpen(selection, 500)).toBe(true)
  })

  it('lets one row be opened after collapse-all', () => {
    const selection = toggleRow(setAllRows(false), 3)
    expect(isRowOpen(selection, 3)).toBe(true)
    expect(isRowOpen(selection, 4)).toBe(false)
  })

  it('clears exceptions on a bulk action, so it is idempotent', () => {
    const messy = toggleRow(toggleRow(setAllRows(true), 1), 2)
    const reset = setAllRows(true)
    expect(isRowOpen(reset, 1)).toBe(true)
    expect(isRowOpen(reset, 2)).toBe(true)
    expect(reset.exceptions.size).toBe(0)
    expect(messy.exceptions.size).toBe(2)
  })
})

describe('the single toggle label', () => {
  /** What the button should offer next, given the rendered rows. */
  const offersCollapse = (selection: Parameters<typeof allRowsOpen>[0], ids: number[]): boolean =>
    allRowsOpen(selection, ids)

  const ids = [1, 2, 3]

  it('offers expand when everything is collapsed', () => {
    expect(offersCollapse(COLLAPSED, ids)).toBe(false)
  })

  it('offers collapse once every rendered row is open', () => {
    expect(offersCollapse(setAllRows(true), ids)).toBe(true)
  })

  it('offers expand while any row is still closed', () => {
    // Otherwise the button would say "collapse all" over a partly closed list,
    // and pressing it would leave the remaining rows unopened.
    const partial = toggleRow(COLLAPSED, 2)
    expect(offersCollapse(partial, ids)).toBe(false)
  })

  it('reverts to offering expand after one row is manually collapsed', () => {
    const selection = toggleRow(setAllRows(true), 2)
    expect(offersCollapse(selection, ids)).toBe(false)
  })

  it('offers collapse when rows are opened one by one until all are open', () => {
    let selection = COLLAPSED
    for (const id of ids) selection = toggleRow(selection, id)
    expect(offersCollapse(selection, ids)).toBe(true)
  })

  it('offers expand for an empty list', () => {
    // There is nothing to collapse, so proposing it would be nonsense.
    expect(offersCollapse(setAllRows(true), [])).toBe(false)
    expect(offersCollapse(COLLAPSED, [])).toBe(false)
  })

  it('judges only the rendered window, not the whole stream', () => {
    // Frames outside the window are not mounted. Letting them count would leave
    // the button permanently offering "expand all" on a long stream.
    const selection = setAllRows(true)
    expect(offersCollapse(selection, [900, 901, 902])).toBe(true)
  })

  it('completes the full press cycle', () => {
    // expand -> collapse -> expand, which is the behaviour that was asked for.
    let selection = COLLAPSED
    expect(offersCollapse(selection, ids)).toBe(false)

    selection = setAllRows(!offersCollapse(selection, ids))
    expect(ids.every((id) => isRowOpen(selection, id))).toBe(true)
    expect(offersCollapse(selection, ids)).toBe(true)

    selection = setAllRows(!offersCollapse(selection, ids))
    expect(ids.every((id) => isRowOpen(selection, id))).toBe(false)
    expect(offersCollapse(selection, ids)).toBe(false)

    selection = setAllRows(!offersCollapse(selection, ids))
    expect(ids.every((id) => isRowOpen(selection, id))).toBe(true)
  })
})
