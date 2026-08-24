/**
 * Bulk expand/collapse state.
 *
 * Two related mechanisms live here because they solve the same problem at
 * different depths, and keeping them together is what stops them drifting apart.
 *
 * ## {@link BulkSelection} — for a flat list whose parent owns the truth
 *
 * The event list needs a *single* toggle whose label reflects reality: "collapse
 * all" once everything is open, "expand all" otherwise. That is only answerable if
 * the parent knows each row's state, so row state is lifted out of the rows.
 *
 * The obvious lifted representation — a `Set` of open rows — is wrong for a live
 * stream. A frame arriving after "expand all" is not in the set, so it would appear
 * collapsed while the button still claimed everything was open. Instead this stores
 * a **baseline mode plus exceptions**: a new row has no exception recorded, so it
 * inherits the baseline and matches what the user chose.
 *
 * ## {@link BulkToggle} — for a tree whose nodes must keep their own state
 *
 * A JSON tree nests arbitrarily deep, and lifting every node's state into one
 * container would mean rebuilding paths on each toggle. Those nodes keep local
 * state and consume a one-shot instruction instead; see {@link resolveBulk}.
 *
 * @module panel/bulk
 */

// --- Flat list: parent-owned state ------------------------------------------

/**
 * Which rows of a list are expanded.
 *
 * `exceptions` holds the rows that *deviate* from `mode`, so the meaning of an
 * entry flips with the baseline. That inversion is the whole point: it makes
 * "everything is open, including rows that do not exist yet" representable.
 */
export interface BulkSelection {
  mode: 'collapsed' | 'expanded'
  exceptions: ReadonlySet<number>
}

/** A fresh selection: everything closed, no exceptions. */
export const COLLAPSED: BulkSelection = { mode: 'collapsed', exceptions: new Set() }

/** Whether one row is currently expanded. */
export function isRowOpen(selection: BulkSelection, id: number): boolean {
  const deviates = selection.exceptions.has(id)
  return selection.mode === 'expanded' ? !deviates : deviates
}

/**
 * Flips one row, leaving every other row alone.
 *
 * Returns a new object rather than mutating, so React sees the change.
 */
export function toggleRow(selection: BulkSelection, id: number): BulkSelection {
  const exceptions = new Set(selection.exceptions)
  if (exceptions.has(id)) exceptions.delete(id)
  else exceptions.add(id)
  return { mode: selection.mode, exceptions }
}

/**
 * Opens or closes everything, including rows not yet rendered.
 *
 * Exceptions are cleared, which is what makes this idempotent and what lets a
 * later-arriving row inherit the decision.
 */
export function setAllRows(open: boolean): BulkSelection {
  return { mode: open ? 'expanded' : 'collapsed', exceptions: new Set() }
}

/**
 * Whether every listed row is open.
 *
 * Takes the ids explicitly because only the rendered window matters: rows outside
 * it are not mounted, and letting them influence the button would make it claim to
 * have collapsed things the user cannot see.
 *
 * An empty list reports `false`, so the button offers "expand" rather than
 * "collapse" when there is nothing to collapse.
 */
export function allRowsOpen(selection: BulkSelection, ids: readonly number[]): boolean {
  if (ids.length === 0) return false
  return ids.every((id) => isRowOpen(selection, id))
}

// --- Nested tree: one-shot instructions -------------------------------------

/**
 * A bulk expand/collapse instruction for nodes that keep their own state.
 *
 * Carries a `nonce` because the alternative — a bare boolean — cannot express
 * "expand everything *again*". Once a user has expanded all and then collapsed one
 * node by hand, a second click on the same button produces an identical boolean,
 * no node sees a change, and the button appears dead. Bumping the nonce makes each
 * press a distinct event, which is what the nodes actually need to react to.
 */
export interface BulkToggle {
  open: boolean
  nonce: number
}

/** A starting instruction that no node should treat as a command. */
export const NO_BULK: BulkToggle = { open: false, nonce: 0 }

/** Produces the next instruction, so each press is distinguishable. */
export function nextBulk(current: BulkToggle, open: boolean): BulkToggle {
  return { open, nonce: current.nonce + 1 }
}

/**
 * Decides whether a collapsible node should adopt a bulk instruction.
 *
 * Two properties matter:
 *
 * - **One-shot.** An instruction applies at most once per nonce, so local clicks
 *   afterwards are never overridden. A latching override would make every manual
 *   collapse snap back open.
 * - **Repeatable.** A new nonce with the same `open` value still applies, which is
 *   what makes pressing the button a second time do something.
 *
 * @param bulk the current instruction, or undefined when bulk control is unused
 * @param appliedNonce the nonce this node last consumed
 * @param open the node's present state
 */
export function resolveBulk(
  bulk: BulkToggle | undefined,
  appliedNonce: number,
  open: boolean,
): { apply: boolean; open: boolean; nonce: number } {
  if (bulk === undefined || bulk.nonce === appliedNonce) {
    return { apply: false, open, nonce: appliedNonce }
  }
  // The nonce is consumed even when the state already matches, so a redundant
  // instruction cannot be re-applied later and undo an intervening click.
  return { apply: bulk.open !== open, open: bulk.open, nonce: bulk.nonce }
}
