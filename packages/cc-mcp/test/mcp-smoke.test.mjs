// Smoke test on a REAL cordis Context: apply() must never throw
// synchronously, Config must validate the patch's config shape, and no-op
// events must not blow up. This is the anti-"broke the host startup"
// guardrail for mounting dsh-cc-mcp into a profile.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, name } from '../src/index.js'

test('module exports name/apply/Config', () => {
  assert.equal(name, 'dsh-cc-mcp')
  assert.equal(typeof apply, 'function')
  assert.ok(Config, 'Config schema exported')
})

test('Config validates the patch config shape', () => {
  const cfg = Config({
    enableProject: true,
    pluginRoots: [],
    idleTimeoutMs: 300000,
    toolCallTimeoutMs: 60000,
    watchProject: true,
  })
  assert.equal(cfg.enableProject, true)
  assert.deepEqual(cfg.pluginRoots, [])
  assert.equal(cfg.idleTimeoutMs, 300000)
})

test('Config defaults fill in for a bare {} config', () => {
  const cfg = Config({})
  assert.equal(cfg.enableProject, true)
  assert.deepEqual(cfg.pluginRoots, [])
  assert.equal(cfg.idleTimeoutMs, 300000)
  assert.equal(cfg.toolCallTimeoutMs, 60000)
  assert.equal(cfg.watchProject, true)
})

test('apply on a real Context: registers listeners, no-op events are safe', async () => {
  const ctx = new Context()
  let error = null
  try {
    apply(ctx, Config({}))
  } catch (e) {
    error = e
  }
  assert.equal(error, null, 'apply must not throw synchronously')
  // No-op payloads must not throw (host emits these at agent boundaries).
  ctx.emit('agent/created', { agent: undefined })
  ctx.emit('agent/created', {})
  ctx.emit('agent/disposed', { agent: undefined })
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(true, 'no synchronous throw, no unhandled rejection observed')
})

test('agent/created with a cwd-less agent only warns, never throws', async () => {
  const ctx = new Context()
  const warns = []
  const origLogger = ctx.logger
  ctx.logger = { warn: (m) => warns.push(m), info: () => {}, error: () => {}, debug: () => {} }
  try {
    apply(ctx, Config({}))
    ctx.emit('agent/created', { agent: { id: 'a1', ctx: undefined } })
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(warns.length >= 1, 'expected a warning about missing cwd')
  } finally {
    ctx.logger = origLogger
  }
})
