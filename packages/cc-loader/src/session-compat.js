// session-compat.js — the single compatibility boundary for reading a DSH
// session's event log.
//
// WHY THIS EXISTS
// ---------------
// `Session.events` was REMOVED in DSH 0.1.2-alpha.4 and is gone in 0.1.5. It
// was the full event-log array (both spread and numeric indexing were used on
// it). Hosts at 0.1.5 expose a different, narrower surface:
//
//   session.seq                        -> SessionLogOffset (== log length)
//   session.eventAt(seq)               -> SessionEvent | undefined
//   session.snapshotEvents(from?, to?) -> readonly SessionEvent[] (frozen)
//   session.ownEvents()                -> readonly SessionEvent[] (post-fork)
//
// Reading `session.events` on 0.1.5 does not throw a nice error: it is
// `undefined`, so a spread raises `agent.session.events is not iterable` and a
// numeric index raises `Cannot read properties of undefined (reading 'NN')`.
// Both were live crashes. Every plugin read of the log MUST go through this
// module so the legacy fallback exists in exactly one place instead of being
// re-guessed at each call site.
//
// SUPPORT POLICY
// --------------
// The new API is ALWAYS preferred; the legacy `session.events` property is
// read only when the new methods are absent, i.e. only on pre-0.1.2-alpha.4
// hosts. Supporting two shapes is intentional and cheap: `typeof fn ===
// 'function'` is the whole branch.
//
// Both functions are total: a missing, partial, or malformed session object
// yields `undefined` rather than throwing, so a plugin degrades to "no log
// visible" instead of crashing the host at an event boundary.

/**
 * Read a session's full event log.
 *
 * Prefers `session.snapshotEvents()` (DSH >= 0.1.2-alpha.4). Falls back to the
 * legacy `session.events` array on older hosts. The full log is returned —
 * including any fork-inherited prefix — because callers index it with absolute
 * sequence numbers taken from `session.surface.nodes`, and because the legacy
 * `events` property was itself the full log.
 *
 * @param {unknown} session - the agent's session (`agent.session`), or anything else.
 * @returns {readonly unknown[]|undefined} the event log, or `undefined` when
 *   the session exposes neither reader.
 */
export function sessionEvents(session) {
  if (session === null || typeof session !== 'object') return undefined
  const snapshot = session.snapshotEvents
  if (typeof snapshot === 'function') {
    const events = snapshot.call(session)
    if (Array.isArray(events)) return events
  }
  // A host exposing only the point reader (`eventAt` + `seq`) still has a
  // readable log: materialize it by walking the sequence range. Real 0.1.5
  // sessions have `snapshotEvents` too; this keeps the boundary total.
  const at = session.eventAt
  const end = session.seq
  if (typeof at === 'function' && typeof end === 'number' && Number.isInteger(end) && end >= 0) {
    const events = []
    for (let seq = 0; seq < end; seq += 1) {
      const event = at.call(session, seq)
      if (event === undefined) break
      events.push(event)
    }
    return events
  }
  const legacy = session.events
  return Array.isArray(legacy) ? legacy : undefined
}

/**
 * Read one session event by its absolute sequence number.
 *
 * Prefers `session.eventAt(seq)` (DSH >= 0.1.2-alpha.4). Falls back to numeric
 * indexing into the legacy `session.events` array on older hosts. This is the
 * cheaper reader when only one event is needed: `eventAt` is a direct array
 * lookup, whereas `snapshotEvents()` materializes (and on a full read freezes)
 * the whole log.
 *
 * @param {unknown} session - the agent's session (`agent.session`), or anything else.
 * @param {number} seq - the absolute event sequence number.
 * @returns {unknown} the event, or `undefined` when absent/unreadable.
 */
export function sessionEventAt(session, seq) {
  if (session === null || typeof session !== 'object') return undefined
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return undefined
  const at = session.eventAt
  if (typeof at === 'function') return at.call(session, seq)
  const legacy = session.events
  return Array.isArray(legacy) ? legacy[seq] : undefined
}

/**
 * The newest event matching a predicate, or `undefined`.
 *
 * A convenience over {@link sessionEvents} for the common "findLast" pattern
 * (`lastTurn`, `lastAssistantMessage`): it scans the log newest-first, so it
 * never builds a reversed copy of a potentially long log.
 *
 * @param {unknown} session - the agent's session (`agent.session`).
 * @param {(event: any) => boolean} predicate - match test for one event.
 * @returns {any} the newest matching event, or `undefined`.
 */
export function sessionLastEvent(session, predicate) {
  const events = sessionEvents(session)
  if (events === undefined || typeof predicate !== 'function') return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (predicate(event)) return event
  }
  return undefined
}
