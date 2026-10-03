// Regression tests for the DSH session-start compatibility boundary.
//
// DSH 0.2.0 REMOVED `agent/session-start` and moved the extension point to
// `agent/created`, enriching the payload with `source`. A plugin registered
// only on the old name is never called on 0.2.0 — no error, nothing in the log,
// the feature just stops working (this is issue #7: four listeners went dead on
// the released v0.3.1). A plain rename is not a fix either, because 0.1.5's
// `agent/created` is registration-only and carries no `source`, which the
// SessionStart hook payload needs.
//
// Every test here drives a FAKE ctx; no DSH process is involved. Both host
// generations are covered: 0.1.5 (agent/created without source, then
// agent/session-start with one) and 0.2.0 (agent/created with source, and no
// agent/session-start at all).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { onSessionStart } from '../src/session-start-compat.js'

const AGENT = { id: 'a1' }

/** A ctx that fans out like cordis and records the return value of the last listener. */
function makeCtx() {
  const listeners = new Map()
  const warnings = []
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
    emit(event, payload) {
      let returned
      for (const handler of listeners.get(event) ?? []) returned = handler(payload)
      return returned
    },
    eventNames: () => [...listeners.keys()],
    warnings,
  }
}

// ─── the premise: why this module exists ────────────────────────────────────

test('premise: an `agent/session-start`-only listener is never called on 0.2.0', () => {
  const ctx = makeCtx()
  let naive = 0
  ctx.on('agent/session-start', () => { naive += 1 }) // the pre-v0.3.2 shape
  ctx.emit('agent/created', { agent: AGENT, source: 'startup' }) // all 0.2.0 emits
  assert.equal(naive, 0, 'silently dead — no throw, no log line')
})

test('premise: 0.1.5 agent/created carries no `source`', () => {
  // Guards the discriminator the boundary relies on. If a future DSH enriches
  // 0.1.5's payload, revisit the header's "runs exactly once" argument.
  const ctx = makeCtx()
  const seen = []
  ctx.on('agent/created', (payload) => seen.push(payload))
  const registrationOnly = { agent: AGENT }
  ctx.emit('agent/created', registrationOnly)
  assert.deepEqual(seen, [registrationOnly])
  assert.equal(seen[0].source, undefined)
})

// ─── both host generations ──────────────────────────────────────────────────

test('0.1.5 host: fires exactly once, with source, on agent/session-start', () => {
  const ctx = makeCtx()
  const seen = []
  onSessionStart(ctx, (payload) => seen.push(payload))

  // publish() announces the agent first (no source), then emits session-start.
  ctx.emit('agent/created', { agent: AGENT })
  assert.equal(seen.length, 0, 'registration-only event must not fire the handler')

  ctx.emit('agent/session-start', { agent: AGENT, source: 'startup' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].source, 'startup')
  assert.equal(seen[0].agent, AGENT)
})

test('0.2.0 host: fires exactly once, with source, on agent/created', () => {
  const ctx = makeCtx()
  const seen = []
  onSessionStart(ctx, (payload) => seen.push(payload))

  const signal = new AbortController().signal
  ctx.emit('agent/created', { agent: AGENT, source: 'resume', signal })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].source, 'resume')
  assert.equal(seen[0].signal, signal, 'the 0.2.0 signal is passed through')
})

test('every SessionStartSource value survives both generations', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const older = makeCtx()
    const newer = makeCtx()
    const seenOlder = []
    const seenNewer = []
    onSessionStart(older, (p) => seenOlder.push(p.source))
    onSessionStart(newer, (p) => seenNewer.push(p.source))
    older.emit('agent/created', { agent: AGENT })
    older.emit('agent/session-start', { agent: AGENT, source })
    newer.emit('agent/created', { agent: AGENT, source })
    assert.deepEqual(seenOlder, [source], `0.1.5 ${source}`)
    assert.deepEqual(seenNewer, [source], `0.2.0 ${source}`)
  }
})

test('registers on both host event names', () => {
  const ctx = makeCtx()
  onSessionStart(ctx, () => {})
  assert.deepEqual(ctx.eventNames().sort(), ['agent/created', 'agent/session-start'])
})

// ─── 0.2.0's agent/created is serial: never stall or veto publication ───────

test('never returns the handler promise, so a serial dispatch cannot await it', () => {
  const ctx = makeCtx()
  let settle
  onSessionStart(ctx, () => new Promise((resolve) => { settle = resolve }))
  const returned = ctx.emit('agent/created', { agent: AGENT, source: 'startup' })
  assert.equal(returned, undefined, 'a pending hook must not block session publication')
  settle()
})

test('a throwing handler is logged, never propagated to the host', () => {
  const ctx = makeCtx()
  onSessionStart(ctx, () => { throw new Error('boom') })
  assert.doesNotThrow(() => ctx.emit('agent/created', { agent: AGENT, source: 'startup' }))
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /boom/)
})

test('a rejecting async handler is logged, not left as an unhandled rejection', async () => {
  const ctx = makeCtx()
  onSessionStart(ctx, async () => { throw new Error('async boom') })
  ctx.emit('agent/created', { agent: AGENT, source: 'startup' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /async boom/)
})

test('a handler that resolves normally logs nothing', async () => {
  const ctx = makeCtx()
  let ran = 0
  onSessionStart(ctx, async () => { ran += 1 })
  ctx.emit('agent/created', { agent: AGENT, source: 'startup' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(ran, 1)
  assert.deepEqual(ctx.warnings, [])
})

// ─── totality: malformed payloads never fire ────────────────────────────────

test('a source-less agent/created never fires, whatever else it carries', () => {
  const ctx = makeCtx()
  let calls = 0
  onSessionStart(ctx, () => { calls += 1 })
  for (const payload of [undefined, null, {}, { agent: AGENT }, 'x', 42, { source: undefined }]) {
    ctx.emit('agent/created', payload)
  }
  assert.equal(calls, 0)
})

test('a session-start payload is forwarded verbatim, even a malformed one', () => {
  // agent/session-start only ever fires at the session-start boundary, so there
  // is nothing to discriminate on: the host's payload is passed straight on and
  // the handler owns its own totality.
  const ctx = makeCtx()
  const seen = []
  onSessionStart(ctx, (payload) => seen.push(payload))
  for (const payload of [undefined, null, { agent: AGENT, source: 'startup' }]) {
    ctx.emit('agent/session-start', payload)
  }
  assert.deepEqual(seen, [undefined, null, { agent: AGENT, source: 'startup' }])
})
