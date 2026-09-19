// Regression tests for the DSH session event-reader compatibility boundary.
//
// `Session.events` was REMOVED in DSH 0.1.2-alpha.4. On 0.1.5 a plugin that
// still reads it gets `undefined`, so `[...session.events]` throws
// "agent.session.events is not iterable" and `session.events[seq]` throws
// "Cannot read properties of undefined (reading 'NN')" — both were live
// crashes in cc-skills / cc-hooks / cc-permissions.
//
// Every test here uses a FAKE session object; no DSH process is involved.
// Both host shapes are covered: the 0.1.5 shape (`snapshotEvents` / `eventAt` /
// `seq`) and the legacy pre-0.1.2-alpha.4 shape (`events`).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sessionEvents, sessionEventAt, sessionLastEvent } from '../src/session-compat.js'

const LOG = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { source: { kind: 'cc-skills', form: 'rules' } } },
  { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
]

// ─── the two host shapes ────────────────────────────────────────────────────

/** The DSH 0.1.5+ shape: `snapshotEvents()` + `eventAt()` + `seq`. */
function newShapeSession(log = LOG) {
  return {
    header: { id: 's-new', cwd: 'C:/proj' },
    get seq() { return log.length },
    eventAt(seq) { return log[seq] },
    snapshotEvents(from = 0, to = log.length) {
      return Object.freeze(log.slice(from, to))
    },
  }
}

/** The legacy pre-0.1.2-alpha.4 shape: a plain `events` array. */
function legacyShapeSession(log = LOG) {
  return { header: { id: 's-old', cwd: 'C:/proj' }, events: log }
}

/** A host exposing only the point reader — no snapshot, no legacy array. */
function eventAtOnlySession(log = LOG) {
  return { get seq() { return log.length }, eventAt(seq) { return log[seq] } }
}

test('sessionEvents: reads the 0.1.5 snapshotEvents() shape', () => {
  const session = newShapeSession()
  const events = sessionEvents(session)
  assert.ok(Array.isArray(events))
  assert.equal(events.length, LOG.length)
  assert.equal(events[1].type, 'user/message')
})

test('sessionEvents: reads the legacy `events` shape', () => {
  const session = legacyShapeSession()
  const events = sessionEvents(session)
  assert.ok(Array.isArray(events))
  assert.equal(events.length, LOG.length)
  assert.equal(events[1].type, 'user/message')
})

test('sessionEvents: materializes an eventAt()+seq-only shape', () => {
  const events = sessionEvents(eventAtOnlySession())
  assert.ok(Array.isArray(events))
  assert.equal(events.length, LOG.length)
  assert.equal(events[4].type, 'assistant/message')
})

test('sessionEvents: prefers the new API when both are present', () => {
  // A host mid-migration: `events` is stale/empty, snapshotEvents is truth.
  const session = { ...newShapeSession(), events: [] }
  assert.equal(sessionEvents(session).length, LOG.length)
})

// ─── sessionEventAt ─────────────────────────────────────────────────────────

test('sessionEventAt: reads by absolute seq on the 0.1.5 shape', () => {
  const session = newShapeSession()
  assert.equal(sessionEventAt(session, 1).type, 'user/message')
  assert.equal(sessionEventAt(session, 0).type, 'turn/start')
})

test('sessionEventAt: reads by absolute seq on the legacy shape', () => {
  const session = legacyShapeSession()
  assert.equal(sessionEventAt(session, 1).type, 'user/message')
})

test('sessionEventAt: prefers eventAt() over the legacy array', () => {
  const session = { ...newShapeSession(), events: [{ type: 'bogus' }] }
  assert.equal(sessionEventAt(session, 1).type, 'user/message')
})

test('sessionEventAt: out-of-range seq is undefined, never a throw', () => {
  assert.equal(sessionEventAt(newShapeSession(), 999), undefined)
  assert.equal(sessionEventAt(legacyShapeSession(), 999), undefined)
})

// ─── totality: malformed input never throws ─────────────────────────────────

test('sessionEvents: absent / malformed session yields undefined', () => {
  for (const bad of [undefined, null, 0, 1, '', 'session', true, [], () => {}]) {
    assert.equal(sessionEvents(bad), undefined, `sessionEvents(${String(bad)})`)
  }
  assert.equal(sessionEvents({}), undefined, 'plain object')
})

test('sessionEvents: a non-array snapshotEvents() falls through', () => {
  assert.equal(sessionEvents({ snapshotEvents: () => undefined }), undefined)
  assert.equal(sessionEvents({ snapshotEvents: () => 'nope' }), undefined)
  // …and still finds the legacy array.
  assert.equal(sessionEvents({ snapshotEvents: () => null, events: LOG }).length, LOG.length)
})

test('sessionEvents: a throwing snapshotEvents() propagates (not swallowed)', () => {
  // A genuine host fault must not be silently masked into "no events".
  const session = { snapshotEvents() { throw new Error('host fault') } }
  assert.throws(() => sessionEvents(session), /host fault/)
})

test('sessionEventAt: rejects a non-sequence argument', () => {
  const session = newShapeSession()
  for (const bad of [undefined, null, -1, 1.5, '1', NaN, Infinity]) {
    assert.equal(sessionEventAt(session, bad), undefined, `seq=${String(bad)}`)
  }
})

test('sessionEventAt: an eventAt()+seq session with no legacy array', () => {
  assert.equal(sessionEventAt(eventAtOnlySession(), 4).type, 'assistant/message')
})

test('the removed `Session.events` is genuinely absent on the new shape', () => {
  // Guards the premise of this whole module: if a future DSH restores
  // `events`, this test is the reminder to revisit the boundary.
  assert.equal(newShapeSession().events, undefined)
})

// ─── sessionLastEvent ───────────────────────────────────────────────────────

test('sessionLastEvent: finds the newest match on either shape', () => {
  const isTurn = (e) => e.type === 'turn/start'
  assert.equal(sessionLastEvent(newShapeSession(), isTurn).data.turn, 2)
  assert.equal(sessionLastEvent(legacyShapeSession(), isTurn).data.turn, 2)
})

test('sessionLastEvent: no match / no session / no predicate → undefined', () => {
  assert.equal(sessionLastEvent(newShapeSession(), (e) => e.type === 'nope'), undefined)
  assert.equal(sessionLastEvent(undefined, () => true), undefined)
  assert.equal(sessionLastEvent(newShapeSession(), undefined), undefined)
})

test('sessionLastEvent: reproduces the exact cc-hooks lastTurn / lastAssistantMessage reads', () => {
  // These mirror the two crashes: `[...events].findLast(...)` was the old body.
  const lastTurn = (agent) => {
    const last = sessionLastEvent(agent?.session, (e) => e.type === 'turn/start')
    return last?.type === 'turn/start' ? last.data.turn : 0
  }
  const lastAssistant = (agent) => {
    const last = sessionLastEvent(agent?.session, (e) => e.type === 'assistant/message')
    return last?.type === 'assistant/message' ? last.data.message.content : ''
  }
  for (const session of [newShapeSession(), legacyShapeSession(), eventAtOnlySession()]) {
    const agent = { session }
    assert.equal(lastTurn(agent), 2, 'turn number')
    assert.deepEqual(lastAssistant(agent), [{ type: 'text', text: 'done' }])
  }
  assert.equal(lastTurn(undefined), 0, 'no agent → turn 0')
  assert.equal(lastAssistant(undefined), '', 'no agent → empty text')
})
