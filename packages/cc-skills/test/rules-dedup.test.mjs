// Regression tests for the cc-skills rules-injection dedup path.
//
// The rules section injects the project's `.claude/rules/*.md` text as one
// synthetic user message at the head of the first pre-step of a session, and
// must never inject it twice. The dedup probe reads the session log:
//
//     agent.session.surface.nodes.some((seq) => {
//       const event = agent.session.events[seq]      // ← crashed on 0.1.5
//       return event?.type === 'user/message' && event.data?.source?.kind === 'cc-skills'
//     })
//
// `Session.events` was removed in DSH 0.1.2-alpha.4, so on 0.1.5 this threw
// "Cannot read properties of undefined (reading 'NN')" (NN = the surface seq).
// It now goes through `sessionEventAt()`.
//
// Both host shapes are covered with FAKE sessions — no DSH process involved:
//   - new (0.1.5):  snapshotEvents() / eventAt() / seq
//   - legacy:       the `events` array

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../src/index.js'

const RULES_TEXT = 'Always run the linter before committing.'

/** A temp project carrying one CC rules file at `.claude/rules/team.md`. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-rules-dedup-'))
  await mkdir(join(dir, '.claude', 'rules'), { recursive: true })
  await writeFile(join(dir, '.claude', 'rules', 'team.md'), `${RULES_TEXT}\n`)
  await writeFile(join(dir, '.git'), '')
  return dir
}

/** A stub skills service — cc-skills only registers a provider on it. */
function stubSkills() {
  return {
    registerProvider(create) { create({ signal: new AbortController().signal, invalidate() {} }) },
    async list() { return [] },
    async get() { return undefined },
  }
}

/**
 * A session whose log is `log` plus its `surface.nodes` index, in one of the
 * two host shapes. `kind === 'new'` exposes only the 0.1.5 readers — no
 * `events` property at all, exactly like a real 0.1.5 session.
 */
function fakeSession(cwd, log, nodes, kind) {
  const base = { header: { cwd }, surface: { nodes } }
  if (kind === 'legacy') return { ...base, events: log }
  return {
    ...base,
    get seq() { return log.length },
    eventAt(seq) { return log[seq] },
    snapshotEvents(from = 0, to = log.length) { return Object.freeze(log.slice(from, to)) },
  }
}

/** Drive the real `agent/pre-step` waterfall the way the host does. */
function preStep(ctx, agent, messages = []) {
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
}

/** The synthetic rules message, or undefined when the step injected nothing. */
function injectedRules(decision) {
  const hits = decision.messages.filter((m) => m?.source?.kind === 'cc-skills')
  assert.ok(hits.length <= 1, `expected at most one cc-skills injection, got ${hits.length}`)
  return hits[0]
}

for (const kind of ['new', 'legacy']) {
  const label = kind === 'new' ? '0.1.5 session (snapshotEvents/eventAt)' : 'legacy session (events array)'

  test(`rules are injected once and deduped on the next step — ${label}`, async () => {
    const cwd = await fixture()
    try {
      const ctx = new Context()
      ctx.provide('skills', stubSkills())
      apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-rules-nohome') }))

      const log = []
      const nodes = []
      const agent = { session: fakeSession(cwd, log, nodes, kind) }

      // 1. First pre-step of the session: the rules message is injected.
      const first = await preStep(ctx, agent)
      const rules = injectedRules(first)
      assert.ok(rules !== undefined, 'first pre-step must inject the rules message')
      assert.equal(rules.source.form, 'rules')
      const text = rules.content.map((b) => b.text ?? '').join('')
      assert.match(text, /Always run the linter before committing\./)

      // The host committed it to the log + surface before the next step.
      const seq = log.length
      log.push({ type: 'user/message', data: { source: rules.source } })
      nodes.push(seq)

      // 2. Second pre-step: the log now proves the rules are already present,
      //    so nothing is injected a second time.
      const second = await preStep(ctx, agent)
      assert.equal(injectedRules(second), undefined, 'rules must not be injected twice')
      assert.equal(second.messages.length, 0, 'no message added on the deduped step')

      // The dedup probe really read the log (this is what used to throw).
      assert.equal(nodes.length, 1)
      assert.equal(log[seq].data.source.kind, 'cc-skills')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

test('rules dedup also short-circuits when the message is already in `messages`', async () => {
  const cwd = await fixture()
  try {
    const ctx = new Context()
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-rules-nohome') }))

    const agent = { session: fakeSession(cwd, [], [], 'new') }
    const already = { role: 'user', source: { kind: 'cc-skills', form: 'rules' }, content: [] }
    const decision = await preStep(ctx, agent, [already])
    assert.equal(injectedRules(decision), undefined, 'no second injection')
    assert.equal(decision.messages.length, 0)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('an unrelated user/message in the log does not suppress the rules', async () => {
  const cwd = await fixture()
  try {
    const ctx = new Context()
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-rules-nohome') }))

    const log = [{ type: 'user/message', data: { source: { kind: 'other' } } }]
    const nodes = [0]
    const agent = { session: fakeSession(cwd, log, nodes, 'new') }

    const decision = await preStep(ctx, agent)
    assert.ok(injectedRules(decision) !== undefined, 'rules still injected')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a 0.1.5-shaped session with out-of-range surface nodes never throws', async () => {
  const cwd = await fixture()
  try {
    const ctx = new Context()
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-rules-nohome') }))

    // Surface seqs that the log cannot satisfy: eventAt() returns undefined.
    // The old `session.events[seq]` read threw here; the new reader must not.
    const agent = { session: fakeSession(cwd, [], [0, 7, 96], 'new') }
    const decision = await preStep(ctx, agent)
    assert.ok(injectedRules(decision) !== undefined, 'rules injected, no throw')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
