// Regression tests for the per-agent registration path (issue #7).
//
// cc-permissions used to spread this work over TWO events: bare-name deny on
// `agent/created`, and defaultMode on `agent/session-start`. DSH 0.2.0 removed
// `agent/session-start`, so the defaultMode half went silently dead on the
// released v0.3.1 — no throw, no log line, the approval policy just was not
// applied. Nothing in the suite noticed, because neither listener had a test.
//
// Both concerns are registration-time (they configure the agent's tool registry
// and approval policy before the first prompt), so they now share ONE
// `agent/created` listener — an event that carries the same `{ agent }` on both
// host generations. The tests below drive only `agent/created`, which is the
// 0.2.0 host shape: the generation that used to break.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

const NO_HOME = join(tmpdir(), 'cc-perm-nohome')

/**
 * Both concerns run detached behind real file I/O, so waiting a fixed number of
 * ticks is a race. Every assertion below is therefore paired with a positive
 * signal to wait on, and negative expectations are only read once their sibling
 * positive has landed.
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}

function makeProject(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-perm-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings))
  writeFileSync(join(dir, '.git'), '')
  return dir
}

function makeCtx() {
  const listeners = new Map()
  const services = {}
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    get: (name) => services[name],
    provide: (name, value) => { services[name] = value },
    logger: { info: () => {}, warn: () => {} },
    effect: () => {},
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    eventNames: () => [...listeners.keys()],
  }
}

/** Apply the plugin, register an agent, and drive the 0.2.0 host shape. */
function start(dir, config = {}) {
  const ctx = makeCtx()
  apply(ctx, { homeDir: NO_HOME, ...config })
  const restricted = []
  const policies = []
  const agent = {
    session: { header: { id: 's1', cwd: dir } },
    ctx: { tools: { restrict: (arg) => restricted.push(arg) } },
  }
  ctx.provide('approval', { setPolicy: (_agent, policy) => policies.push(policy) })
  ctx.emit('agent/created', { agent })
  return { ctx, restricted, policies }
}

async function withProject(settings, config, body) {
  const dir = makeProject(settings)
  try {
    return await body(start(dir, config))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─── the fix itself ─────────────────────────────────────────────────────────

test('registers agent/created and NOT the removed agent/session-start', () => {
  const ctx = makeCtx()
  apply(ctx, { homeDir: NO_HOME })
  assert.ok(ctx.eventNames().includes('agent/created'))
  assert.ok(
    !ctx.eventNames().includes('agent/session-start'),
    'the removed 0.2.0 event must not be the only thing carrying defaultMode',
  )
})

// ─── both concerns fire from that one listener ──────────────────────────────

test('defaultMode=dontAsk applies the approval policy on agent/created alone', async () => {
  await withProject({ defaultMode: 'dontAsk' }, {}, async ({ policies }) => {
    assert.ok(await waitFor(() => policies.length > 0), 'approval policy never applied')
    assert.deepEqual(policies, ['never'])
  })
})

test('a bare deny hides the tool on agent/created alone', async () => {
  await withProject({ permissions: { deny: ['Bash'] } }, {}, async ({ restricted }) => {
    assert.ok(await waitFor(() => restricted.length > 0), 'tools.restrict was never called')
    assert.deepEqual(restricted, [{ deny: ['Bash'] }])
  })
})

test('both concerns run from the same single agent/created event', async () => {
  await withProject(
    { defaultMode: 'dontAsk', permissions: { deny: ['Bash'] } },
    {},
    async ({ restricted, policies }) => {
      assert.ok(await waitFor(() => policies.length > 0 && restricted.length > 0), 'one half never ran')
      assert.deepEqual(policies, ['never'])
      assert.deepEqual(restricted, [{ deny: ['Bash'] }])
    },
  )
})

// ─── the config switches still gate each half independently ─────────────────

test('hideDeniedTools:false leaves the registry alone but keeps defaultMode', async () => {
  await withProject(
    { defaultMode: 'dontAsk', permissions: { deny: ['Bash'] } },
    { hideDeniedTools: false },
    async ({ ctx, restricted, policies }) => {
      // Wait on the half that SHOULD run, then read the half that should not.
      assert.ok(await waitFor(() => policies.length > 0), 'defaultMode never ran')
      assert.deepEqual(restricted, [])
      assert.ok(ctx.eventNames().includes('agent/created'))
    },
  )
})

test('enableDefaultMode:false drops the policy but keeps tool hiding', async () => {
  await withProject(
    { defaultMode: 'dontAsk', permissions: { deny: ['Bash'] } },
    { enableDefaultMode: false },
    async ({ restricted, policies }) => {
      assert.ok(await waitFor(() => restricted.length > 0), 'tool hiding never ran')
      assert.deepEqual(policies, [])
    },
  )
})

test('both switches off registers no agent/created listener at all', () => {
  const ctx = makeCtx()
  apply(ctx, { homeDir: NO_HOME, hideDeniedTools: false, enableDefaultMode: false })
  assert.ok(!ctx.eventNames().includes('agent/created'))
})

// ─── malformed payloads must not veto publication ───────────────────────────

test('an agent with no usable cwd is skipped, never throwing', async () => {
  // 0.2.0 dispatches `agent/created` serially, so a synchronous throw here
  // vetoes session publication outright — cc-mcp's suite already pins that an
  // empty payload is dispatched.
  const ctx = makeCtx()
  apply(ctx, { homeDir: NO_HOME })
  for (const payload of [
    { agent: { session: { header: {} } } },
    { agent: { session: {} } },
    { agent: {} },
    {},
  ]) {
    assert.doesNotThrow(() => ctx.emit('agent/created', payload), JSON.stringify(payload))
  }
})
