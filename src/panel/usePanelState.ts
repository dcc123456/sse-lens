/**
 * The panel's single door to the worker.
 *
 * All messaging lives here so components never touch `chrome.*`. That matters for
 * one specific reason beyond tidiness: the update strategy is subtle, and spreading
 * it across components would guarantee it drifts.
 *
 * ## Why incremental updates
 *
 * A stream can accumulate thousands of frames. Re-sending the whole record on
 * every frame would make traffic quadratic in stream length, and the panel would
 * stutter exactly when a stream is most interesting. So the worker sends one full
 * snapshot on open, then pushes only *new frames* — and this hook appends them.
 *
 * ## Why the frame buffer
 *
 * React state updates are asynchronous, and a fast stream can deliver several
 * pushes before a render commits. Appending directly with `setState` per message
 * would render once per frame, at 50+ renders/second. Instead frames accumulate in
 * a ref and flush on an animation frame, so the render rate is bounded by the
 * display rather than by the server.
 *
 * ## Why a port, not just messages
 *
 * The panel holds a `chrome.runtime.connect` port for its whole lifetime. It
 * carries no traffic; its only job is to give the worker a truthful open/close
 * signal, since Chrome fires no side-panel close event. Inferring "the panel is
 * open" from message traffic instead meant that a worker evicted while the panel
 * sat idle came back believing nothing was watching, and then refused to follow
 * the user to the next tab they selected — the panel would show "no page selected"
 * until it was closed and reopened. Holding the port also keeps the worker alive
 * while the panel is open, which removes most evictions during a debugging session.
 *
 * @module panel/usePanelState
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isWorkerEvent,
  sendToWorker,
  PANEL_PORT_NAME,
  RECONNECT_DELAY_MS,
  type PanelState,
  type WorkerEvent,
} from '../lib/messages'
import { DEFAULT_SETTINGS, type Settings, type SseEvent, type StreamRecord } from '../lib/types'

export interface PanelController {
  state: PanelState
  /** True until the first snapshot arrives, so the UI can avoid a false "empty". */
  loading: boolean
  /** Set when the worker cannot be reached at all. */
  error: string | null
  selectedId: string | null
  select(streamId: string | null): void
  selected: StreamRecord | undefined
  refresh(): void
  clearAll(): void
  clearStream(streamId: string): void
  updateSettings(patch: Partial<Settings>): void
}

const EMPTY_STATE: PanelState = {
  settings: DEFAULT_SETTINGS,
  streams: [],
  tab: null,
}

export function usePanelState(): PanelController {
  const [state, setState] = useState<PanelState>(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  /** Frames waiting for the next paint, keyed by stream. */
  const pendingFrames = useRef(new Map<string, SseEvent[]>())
  /** Latest counters per stream, so a flush does not need to recount. */
  const pendingCounts = useRef(new Map<string, { bytes: number; eventCount: number }>())
  const frameHandle = useRef<number | null>(null)

  /** Applies buffered frames in one state update. */
  const flushFrames = useCallback(() => {
    frameHandle.current = null
    const frames = pendingFrames.current
    const counts = pendingCounts.current
    if (frames.size === 0) return

    const batch = new Map(frames)
    const batchCounts = new Map(counts)
    frames.clear()
    counts.clear()

    setState((current) => ({
      ...current,
      streams: current.streams.map((stream) => {
        const incoming = batch.get(stream.id)
        if (!incoming) return stream
        const counters = batchCounts.get(stream.id)
        return {
          ...stream,
          events: [...stream.events, ...incoming],
          bytes: counters?.bytes ?? stream.bytes,
          eventCount: counters?.eventCount ?? stream.eventCount,
        }
      }),
    }))
  }, [])

  const scheduleFlush = useCallback(() => {
    if (frameHandle.current !== null) return
    frameHandle.current = requestAnimationFrame(flushFrames)
  }, [flushFrames])

  const refresh = useCallback(() => {
    void sendToWorker({ type: 'panel.getState' }).then(
      (response) => {
        if (response?.ok) {
          setState(response.state)
          setError(null)
        }
        setLoading(false)
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      },
    )
  }, [])

  // Announce the panel once on mount, and hold a port for as long as it lives.
  //
  // The port is what tells the worker the panel exists — including after the
  // worker restarts, since a reconnect re-arms the active tab. `panel.opened`
  // still runs because it returns the first snapshot in one round trip.
  useEffect(() => {
    let port: chrome.runtime.Port | undefined
    let disposed = false

    const connect = (): void => {
      if (disposed) return
      try {
        port = chrome.runtime.connect({ name: PANEL_PORT_NAME })
        port.onDisconnect.addListener(() => {
          port = undefined
          if (disposed) return
          // The worker was evicted, not the panel closed. Reconnecting revives it
          // and re-arms the tab, so capture resumes without user action.
          setTimeout(connect, RECONNECT_DELAY_MS)
        })
      } catch {
        // The extension context is gone (reloaded or updated). Nothing to do:
        // this panel instance is defunct and Chrome will replace it.
      }
    }

    connect()

    void sendToWorker({ type: 'panel.opened' }).then(
      (response) => {
        if (response?.ok) {
          setState(response.state)
          setError(null)
        }
        setLoading(false)
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      },
    )

    return () => {
      disposed = true
      port?.disconnect()
    }
  }, [])

  // Live updates from the worker.
  useEffect(() => {
    const listener = (message: unknown): void => {
      if (!isWorkerEvent(message)) return
      const event = message as WorkerEvent

      switch (event.type) {
        case 'stream.upsert': {
          setState((current) => {
            const index = current.streams.findIndex((stream) => stream.id === event.stream.id)
            if (index === -1) {
              // New stream: newest first, matching the worker's ordering.
              return { ...current, streams: [event.stream, ...current.streams] }
            }
            const streams = [...current.streams]
            // Keep the locally accumulated frames: the upsert carries metadata,
            // and its `events` array may lag behind what has already been pushed.
            const existing = streams[index]
            streams[index] = {
              ...event.stream,
              events:
                existing && existing.events.length > event.stream.events.length
                  ? existing.events
                  : event.stream.events,
            }
            return { ...current, streams }
          })
          return
        }

        case 'stream.events': {
          const queue = pendingFrames.current.get(event.streamId) ?? []
          queue.push(...event.events)
          pendingFrames.current.set(event.streamId, queue)
          pendingCounts.current.set(event.streamId, {
            bytes: event.bytes,
            eventCount: event.eventCount,
          })
          scheduleFlush()
          return
        }

        case 'stream.closed': {
          // Flush first, so the final frames are not overwritten by the closing
          // snapshot's shorter event list.
          flushFrames()
          setState((current) => ({
            ...current,
            streams: current.streams.map((stream) => {
              if (stream.id !== event.stream.id) return stream
              return {
                ...event.stream,
                events:
                  stream.events.length > event.stream.events.length
                    ? stream.events
                    : event.stream.events,
              }
            }),
          }))
          return
        }

        case 'state.changed':
          // The armed tab or the stored capture changed underneath us; a full
          // snapshot is cheaper to reason about than reconciling the difference.
          refresh()
          return

        default:
          return
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
      if (frameHandle.current !== null) cancelAnimationFrame(frameHandle.current)
    }
  }, [flushFrames, refresh, scheduleFlush])

  const clearAll = useCallback(() => {
    pendingFrames.current.clear()
    pendingCounts.current.clear()
    setSelectedId(null)
    void sendToWorker({ type: 'panel.clear' }).then((response) => {
      if (response?.ok) setState(response.state)
    })
  }, [])

  const clearStream = useCallback(
    (streamId: string) => {
      pendingFrames.current.delete(streamId)
      pendingCounts.current.delete(streamId)
      if (selectedId === streamId) setSelectedId(null)
      void sendToWorker({ type: 'panel.clearStream', streamId }).then((response) => {
        if (response?.ok) setState(response.state)
      })
    },
    [selectedId],
  )

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    // Applied locally first so the control does not lag behind the click; the
    // worker's authoritative answer replaces it a moment later.
    setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }))
    void sendToWorker({ type: 'panel.setSettings', patch }).then((response) => {
      if (response?.ok) setState(response.state)
    })
  }, [])

  const selected = useMemo(
    () => state.streams.find((stream) => stream.id === selectedId),
    [state.streams, selectedId],
  )

  // A selected stream that was evicted by a quota would otherwise leave the
  // detail view showing nothing with no way back.
  useEffect(() => {
    if (selectedId !== null && selected === undefined) setSelectedId(null)
  }, [selectedId, selected])

  return {
    state,
    loading,
    error,
    selectedId,
    select: setSelectedId,
    selected,
    refresh,
    clearAll,
    clearStream,
    updateSettings,
  }
}
