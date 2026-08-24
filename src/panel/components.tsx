/**
 * Shared panel components.
 *
 * Small and unstyled beyond the class names in `styles.css`. The only one with
 * real logic is {@link JsonTree}, and it earns its place because a streamed frame
 * is almost always JSON and reading it as one flat line in a 360px column is
 * genuinely hard.
 *
 * @module panel/components
 */

import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { resolveBulk, type BulkToggle } from './bulk'
import type { Translate } from '../lib/i18n'

// --- Button ------------------------------------------------------------------

export function Button({
  onClick,
  children,
  variant = 'default',
  size,
  disabled,
  title,
}: {
  onClick: () => void
  children: ReactNode
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'tiny'
  disabled?: boolean
  title?: string
}): ReactNode {
  const classes = ['btn']
  if (variant !== 'default') classes.push(variant)
  if (size) classes.push(size)
  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

/**
 * A button that requires a second click to act.
 *
 * Used for destructive actions instead of `window.confirm`, which is disruptive
 * in a narrow panel and cannot be styled. The pending state resets on blur, so an
 * armed button cannot be left waiting to catch a later stray click.
 */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel,
  disabled,
}: {
  onConfirm: () => void
  label: string
  confirmLabel: string
  disabled?: boolean
}): ReactNode {
  const [armed, setArmed] = useState(false)
  return (
    <button
      type="button"
      className={armed ? 'btn danger' : 'btn'}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}

// --- Badge -------------------------------------------------------------------

export function Badge({
  children,
  tone,
  title,
}: {
  children: ReactNode
  tone?: 'open' | 'error' | 'aborted' | 'warn' | 'info'
  title?: string
}): ReactNode {
  return (
    <span className={tone ? `badge ${tone}` : 'badge'} title={title}>
      {children}
    </span>
  )
}

// --- Notice ------------------------------------------------------------------

export function Notice({
  title,
  children,
  tone,
}: {
  title?: string
  children?: ReactNode
  tone?: 'warn' | 'info'
}): ReactNode {
  return (
    <div className={tone ? `notice ${tone}` : 'notice'}>
      {title !== undefined && <div className="notice-title">{title}</div>}
      {children}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): ReactNode {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint !== undefined && <div>{hint}</div>}
    </div>
  )
}

// --- Header table ------------------------------------------------------------

export function HeaderTable({
  headers,
  emptyLabel,
}: {
  headers: Record<string, string> | undefined
  emptyLabel: string
}): ReactNode {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) return <div className="dim small">{emptyLabel}</div>
  return (
    <div className="header-table">
      {entries.map(([name, value]) => (
        // A Fragment keeps both cells as direct grid children, so the two-column
        // layout applies to them rather than to a wrapper div.
        <Fragment key={name}>
          <div className="header-name">{name}</div>
          {/* `title` carries the untruncated value, since the column is narrow. */}
          <div className="header-value" title={value}>
            {value}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

// --- JSON tree ---------------------------------------------------------------

/**
 * Nodes deeper than this start collapsed.
 *
 * Two levels shows `choices[0].delta` without a click for the common OpenAI
 * shape, which is the whole point, while keeping a deeply nested payload from
 * filling the panel on open.
 */
const DEFAULT_OPEN_DEPTH = 2

/** Children rendered before the node collapses itself. */
const CHILD_LIMIT = 200

interface TreeProps {
  value: unknown
  /** Key or index label; absent for the root. */
  label?: string
  depth: number
  bulk?: BulkToggle
}

function isExpandable(value: unknown): boolean {
  return (
    (Array.isArray(value) && value.length > 0) ||
    (value !== null && typeof value === 'object' && Object.keys(value as object).length > 0)
  )
}

function ScalarValue({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span className="json-null">null</span>
  switch (typeof value) {
    case 'string':
      // Quoted, so an empty string and a null are distinguishable at a glance.
      return <span className="json-string">&quot;{value}&quot;</span>
    case 'number':
      return <span className="json-number">{String(value)}</span>
    case 'boolean':
      return <span className="json-boolean">{String(value)}</span>
    case 'undefined':
      return <span className="json-null">undefined</span>
    default:
      return <span className="json-null">{String(value)}</span>
  }
}

function TreeNode({ value, label, depth, bulk }: TreeProps): ReactNode {
  const expandable = isExpandable(value)
  const [open, setOpen] = useState(depth < DEFAULT_OPEN_DEPTH)

  /**
   * Applies a bulk instruction exactly once, then hands control back.
   *
   * The node keeps ordinary local state, so after an expand-all the user can still
   * collapse a single branch and have it stay collapsed. See {@link resolveBulk}.
   */
  const appliedNonce = useRef(bulk?.nonce ?? 0)
  const decision = resolveBulk(bulk, appliedNonce.current, open)
  appliedNonce.current = decision.nonce
  // Assigning during render is safe here and deliberately not an effect: an effect
  // would paint the old state first, so a large tree would visibly flash its
  // previous shape before settling.
  if (decision.apply) setOpen(decision.open)

  const entries = useMemo(() => {
    if (!expandable) return []
    if (Array.isArray(value)) {
      return value.slice(0, CHILD_LIMIT).map((item, index) => [String(index), item] as const)
    }
    return Object.entries(value as Record<string, unknown>).slice(0, CHILD_LIMIT)
  }, [value, expandable])

  const hiddenCount = useMemo(() => {
    if (!expandable) return 0
    const total = Array.isArray(value)
      ? value.length
      : Object.keys(value as Record<string, unknown>).length
    return Math.max(0, total - CHILD_LIMIT)
  }, [value, expandable])

  const summary = useMemo(() => {
    if (Array.isArray(value)) return `[${value.length}]`
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value as object).length}}`
    }
    return ''
  }, [value])

  return (
    <div className="json-node">
      <div className="json-row">
        {expandable ? (
          <button
            type="button"
            className="json-toggle"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="json-toggle" aria-hidden="true" />
        )}

        {label !== undefined && (
          <span className="json-key">
            {label}
            <span className="json-punct">:</span>
          </span>
        )}

        {expandable ? (
          <span className="json-count">{summary}</span>
        ) : (
          <span className="json-value">
            <ScalarValue value={value} />
          </span>
        )}
      </div>

      {expandable && open && (
        <div>
          {entries.map(([key, child]) => (
            <TreeNode key={key} label={key} value={child} depth={depth + 1} bulk={bulk} />
          ))}
          {hiddenCount > 0 && (
            <div className="json-node json-count">… {hiddenCount} more</div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Renders parsed JSON as a collapsible tree.
 *
 * `bulk` drives one-shot expand/collapse of every node; see {@link BulkToggle} for
 * why it is a nonce rather than a boolean.
 */
export function JsonTree({
  value,
  bulk,
}: {
  value: unknown
  bulk?: BulkToggle
}): ReactNode {
  return (
    <div className="json-tree">
      <TreeNode value={value} depth={0} bulk={bulk} />
    </div>
  )
}

// --- Copy button -------------------------------------------------------------

/**
 * Copies text and reports the outcome inline.
 *
 * The label reverts after a moment so the button does not read "Copied" forever,
 * which would leave the user unsure whether a second click did anything.
 */
export function CopyButton({
  text,
  label,
  t,
  size,
}: {
  text: string | (() => string)
  label: string
  t: Translate
  size?: 'tiny'
}): ReactNode {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')

  const handle = useCallback(() => {
    const value = typeof text === 'function' ? text() : text
    void navigator.clipboard.writeText(value).then(
      () => {
        setState('done')
        setTimeout(() => setState('idle'), 1400)
      },
      () => {
        setState('failed')
        setTimeout(() => setState('idle'), 1400)
      },
    )
  }, [text])

  return (
    <Button onClick={handle} variant="ghost" size={size}>
      {state === 'done' ? t('copied') : state === 'failed' ? t('copyFailed') : label}
    </Button>
  )
}
