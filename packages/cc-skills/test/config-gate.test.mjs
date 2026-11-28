// The rules snapshot follows the shared config gate: a blocked ConfigChange
// keeps injecting the pre-change rules; an allowed one refreshes them. Each
// "session" here is a fresh fake so the per-cwd cache is the only state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../src/index.js'
import {
  activateConfigGate, bumpConfigGeneration, deactivateConfigGate,
} from '../../cc-loader/src/config-gate.js'

async function fixture(text) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-rules-gate-'))
  await mkdir(join(dir, '.claude', 'rules'), { recursive: true })
  await writeFile(join(dir, '.claude', 'rules', 'team.md'), `${text}\n`)
  await writeFile(join(dir, '.git'), '')
  return dir
}

function stubSkills() {
  return {
    registerProvider(create) { create({ signal: new AbortController().signal, invalidate() {} }) },
    async list() { return [] },
    async get() { return undefined },
  }
}

function freshSession(cwd) {
  return { session: { header: { cwd }, surface: { nodes: [] } } }
}

async function preStep(ctx, agent) {
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
}

function rulesText(decision) {
  const hit = decision.messages.find((m) => m?.source?.kind === 'cc-skills')
  return hit?.content?.[0]?.text
}

test('blocked rules changes stay frozen; the next allowed change refreshes them', async () => {
  const cwd = await fixture('Always run the linter.')
  try {
    const ctx = new Context()
    ctx.provide('skills', stubSkills())
    apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-rules-gate-nohome') }))
    activateConfigGate(cwd)

    assert.match(rulesText(await preStep(ctx, freshSession(cwd))), /Always run the linter\./)

    await writeFile(join(cwd, '.claude', 'rules', 'team.md'), 'Always run the type checker.\n')
    assert.match(
      rulesText(await preStep(ctx, freshSession(cwd))),
      /Always run the linter\./,
      'a blocked/pending change must keep the old rules',
    )

    bumpConfigGeneration(cwd)
    assert.match(
      rulesText(await preStep(ctx, freshSession(cwd))),
      /Always run the type checker\./,
      'an allowed change refreshes the rules on the next step',
    )
  } finally {
    deactivateConfigGate(cwd)
    await rm(cwd, { recursive: true, force: true })
  }
})
