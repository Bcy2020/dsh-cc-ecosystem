// Integration tests for dsh-cc-skills' tool-scope gate (A2):
// skill allowed-tools / disallowed-tools enforced via tools/pre-execute.
//
// Runs on a REAL cordis Context with a stub skills service (registerProvider
// is what cc-skills' apply consumes; the gate itself only needs ctx.on + the
// IR loaded from a temp tree).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../src/index.js'

/** Build a temp project with a scoped skill. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-scope-'))
  await mkdir(join(dir, '.claude', 'skills', 'scoped'), { recursive: true })
  await writeFile(join(dir, '.claude', 'skills', 'scoped', 'SKILL.md'), [
    '---',
    'name: scoped',
    'description: Skill with a tool scope',
    'allowed-tools:',
    '  - Read',
    'disallowed-tools:',
    '  - Write',
    '  - Edit',
    '---',
    'Use the allowed tools.',
  ].join('\n'))
  await writeFile(join(dir, '.git'), '')
  return dir
}

/** A stub skills service: records the provider, list/get read the temp tree. */
function stubSkills() {
  let provider = null
  return {
    registerProvider(create) { provider = create({ signal: new AbortController().signal, invalidate() {} }) },
    provider: () => provider,
    async list() { return provider ? provider.list({ cwd: process.cwd() }) : [] },
    async get() { return undefined },
  }
}

function fakeAgent(id, cwd) {
  const restricted = []
  return {
    id,
    session: {
      header: { cwd },
      surface: { nodes: [] },
      events: [],
    },
    ctx: {
      tools: {
        restrict({ deny }) {
          restricted.push(...deny)
          return () => { /* dispose no-op */ }
        },
      },
    },
    restricted,
  }
}

test('apply with tool scope: registers listeners, never throws', async () => {
  const ctx = new Context()
  ctx.provide('skills', stubSkills())
  let error = null
  try { apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') })) } catch (e) { error = e }
  assert.equal(error, null, 'apply must not throw synchronously')
  // No-op events must be safe (host emits these at agent boundaries). Both
  // agent/pre-step and tools/pre-execute are waterfall-mode events; emit would
  // call listeners with a missing next(). agent/pre-step always carries a real
  // agent from the host, so use the fake agent shape here.
  const agent = fakeAgent('nop', process.cwd())
  await ctx.waterfall('agent/pre-step', { agent, messages: [] },
    () => Promise.resolve({ kind: 'enter', messages: [] }))
  await ctx.waterfall('tools/pre-execute', { agent, name: 'read' },
    () => Promise.resolve({ kind: 'allow' }))
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(true, 'no synchronous throw, no unhandled rejection observed')
})

test('pre-execute: disallowed tool denied while skill active', async () => {
  const ctx = new Context()
  const cwd = await fixture()
  try {
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') }))
    const agent = fakeAgent('a1', cwd)

    // 1. skill tool call activates the scope (pre-execute on the skill tool).
    let skillCall = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'skill', arguments: { name: 'scoped' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(skillCall.kind, 'allow', 'skill tool call itself is allowed')

    // 2. disallowed tool → denied.
    const denied = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'write', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /disallowed-tools/)

    // 3. allowed tool → passes through; an ask from downstream becomes allow.
    const allowed = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'read', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(allowed.kind, 'allow')
    const askUpgraded = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'read', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'ask', reason: 'needs approval' }))
    assert.equal(askUpgraded.kind, 'allow', 'allowed-tools upgrades downstream ask to allow')

    // 4. downstream deny is preserved (deny > ask > allow).
    const denyKept = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'read', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'deny', reason: 'settings deny' }))
    assert.equal(denyKept.kind, 'deny')
    assert.equal(denyKept.reason, 'settings deny')

    // 5. unrelated tool unaffected while a scope is active.
    const other = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'bash', arguments: { command: 'ls' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(other.kind, 'allow')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('turn-stopping: activation cleared at round end (CC: next message sees tools again)', async () => {
  const ctx = new Context()
  const cwd = await fixture()
  try {
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') }))
    const agent = fakeAgent('a2', cwd)

    // Activate via the skill tool call in round 1.
    await ctx.waterfall('tools/pre-execute', {
      agent, name: 'skill', arguments: { name: 'scoped' },
    }, () => Promise.resolve({ kind: 'allow' }))
    const denied = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'edit', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny', 'round 1: disallowed tool denied')

    // Round 1 ends → agent/turn-stopping clears the scope. The model-facing
    // tool list for the NEXT round is assembled AFTER this, so the tools are
    // visible again from the very next user message (CC semantics).
    ctx.emit('agent/turn-stopping', { agent })
    const after = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'edit', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(after.kind, 'allow', 'round 2: scope cleared at turn end, edit allowed again')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('pre-step: empty batch (tool continuation) keeps the scope active', async () => {
  const ctx = new Context()
  const cwd = await fixture()
  try {
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') }))
    const agent = fakeAgent('a2b', cwd)

    await ctx.waterfall('tools/pre-execute', {
      agent, name: 'skill', arguments: { name: 'scoped' },
    }, () => Promise.resolve({ kind: 'allow' }))

    // A tool-continuation step (empty claimed batch, no turn end) keeps the
    // scope active.
    await ctx.waterfall('agent/pre-step', { agent, messages: [] },
      () => Promise.resolve({ kind: 'enter', messages: [] }))
    const stillDenied = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'edit', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(stillDenied.kind, 'deny', 'empty batch keeps the active scope')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('pre-step: /name gesture activates the skill scope', async () => {
  const ctx = new Context()
  const cwd = await fixture()
  try {
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') }))
    const agent = fakeAgent('a3', cwd)

    // tool-skill injects a user message with source.kind === 'skill-invocation'
    // into the final decision. The raw claimed batch is the user's own words
    // (non-empty → clears the previous round); the injection rides the
    // decision.messages we inspect after next().
    const userBatch = [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'use scoped' }] }]
    const gesture = {
      kind: 'user',
      content: [{ type: 'text', text: 'use scoped' }],
      source: { kind: 'skill-invocation', name: 'scoped', form: 'instructions' },
    }
    await ctx.waterfall('agent/pre-step', { agent, messages: userBatch },
      () => Promise.resolve({ kind: 'enter', messages: [...userBatch, gesture] }))

    const denied = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'write', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny', 'gesture-activated skill denies disallowed tool')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('pre-step: prepend listener sees injections made by an earlier-registered listener', async () => {
  const ctx = new Context()
  const cwd = await fixture()
  try {
    ctx.provide('skills', stubSkills())
    // Simulate tool-skill: a plain (non-prepend) pre-step listener that
    // appends a skill-invocation message to the decision.
    const gesture = {
      kind: 'user',
      content: [{ type: 'text', text: 'use scoped' }],
      source: { kind: 'skill-invocation', name: 'scoped', form: 'instructions' },
    }
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'enter'
        ? { kind: 'enter', messages: [...decision.messages, gesture] }
        : decision
    })
    // cc-skills registers with prepend → runs outside the listener above, so
    // its next() sees the appended gesture.
    apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') }))
    const agent = fakeAgent('a3b', cwd)

    const userBatch = [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'use scoped' }] }]
    await ctx.waterfall('agent/pre-step', { agent, messages: userBatch },
      () => Promise.resolve({ kind: 'enter', messages: [...userBatch] }))

    const denied = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'write', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny', 'prepend listener observed the simulated tool-skill injection')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('disallowed tools are hidden from the model via agent.ctx.tools.restrict', async () => {
  const ctx = new Context()
  const cwd = await fixture()
  try {
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') }))
    const restricted = []
    const agent = {
      id: 'a4',
      session: {
        header: { cwd },
        surface: { nodes: [] },
        events: [],
      },
      ctx: {
        tools: {
          restrict({ deny }) {
            restricted.push(...deny)
            return () => {}
          },
        },
      },
    }
    await ctx.waterfall('tools/pre-execute', {
      agent, name: 'skill', arguments: { name: 'scoped' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.deepEqual([...restricted].sort(), ['edit', 'str_replace_editor', 'write'], 'Write/Edit buckets expanded and hidden')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('restrict failure degrades to pre-execute deny (own-layer tools stay visible)', async () => {
  // Mirrors the real host: tools registered in the agent's OWN scope layer
  // (web surface mounts tool-fs per session) are NOT restrictable —
  // tools.restrict() throws "names unknown global tool" for them. The gate
  // must still deny at pre-execute so disallowed-tools semantics hold.
  const ctx = new Context()
  const cwd = await fixture()
  try {
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'nohome') }))
    const agent = {
      id: 'a5',
      session: {
        header: { cwd },
        surface: { nodes: [] },
        events: [],
      },
      ctx: {
        tools: {
          restrict() { throw new Error('tools.restrict() names unknown global tool "write"; known global tools: (none)') },
        },
      },
    }
    // Activate via the skill tool call; restrict throws but must not propagate.
    const skillCall = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'skill', arguments: { name: 'scoped' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(skillCall.kind, 'allow', 'skill tool call stays allowed even when restrict throws')

    const denied = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'edit', arguments: { file_path: '/x' },
    }, () => Promise.resolve({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny', 'own-layer tool still denied at pre-execute')
    assert.match(denied.reason, /disallowed-tools/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
