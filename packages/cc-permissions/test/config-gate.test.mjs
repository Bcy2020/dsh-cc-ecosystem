// The permission cache follows the shared config gate: while a ConfigChange
// hook can still decide, an allowed change is the ONLY thing that refreshes
// the settings snapshot. This is what makes a blocked ConfigChange block
// permission changes too, not just hook changes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.js'
import {
  activateConfigGate, bumpConfigGeneration, deactivateConfigGate, warmConfigGate,
} from '../../cc-loader/src/config-gate.js'

function project(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-perm-gate-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  return dir
}

function writeSettings(dir, settings) {
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
}

function gate(projectDir, command = 'rm -rf build') {
  const ctx = new Context()
  apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-perm-gate-nohome') }))
  const call = () => ctx.waterfall('tools/pre-execute', {
    agent: { session: { header: { cwd: projectDir } } },
    name: 'bash',
    arguments: { command },
  }, () => undefined)
  return call
}

test('a blocked settings change keeps the permission snapshot; an allowed one refreshes it', async () => {
  const dir = project({ permissions: { deny: ['Bash(rm *)'] } })
  try {
    const call = gate(dir)
    activateConfigGate(dir)
    const denied = await call()
    assert.equal(denied.kind, 'deny')

    // Disk now allows the command, but no ConfigChange has been allowed yet.
    writeSettings(dir, { permissions: { deny: [] } })
    assert.equal((await call()).kind, 'deny', 'a blocked/pending change stays invisible')

    // An allowed change bumps the generation and re-warms the adapter; only
    // that refresh may read the disk.
    bumpConfigGeneration(dir)
    await warmConfigGate(dir)
    assert.equal(await call(), undefined, 'an allowed change is picked up')
  } finally {
    deactivateConfigGate(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a blocked write that lands after an allowed change is never read back from disk', async () => {
  const dir = project({ permissions: { deny: ['Bash(rm *)'] } })
  try {
    const rmCall = gate(dir)
    const curlCall = gate(dir, 'curl https://example.com')
    activateConfigGate(dir)
    await warmConfigGate(dir)
    assert.equal((await rmCall()).kind, 'deny')

    // Allowed change: the disk now allows everything. The watcher bumps and
    // re-warms right after the hook allows it.
    writeSettings(dir, { permissions: { deny: [] } })
    bumpConfigGeneration(dir)
    await warmConfigGate(dir)
    assert.equal(await rmCall(), undefined, 'the allowed change is live')

    // A second change is written and then BLOCKED. The session must keep the
    // allowed snapshot: rm stays allowed and the blocked curl rule never
    // applies.
    writeSettings(dir, { permissions: { deny: ['Bash(curl *)'] } })
    assert.equal(await rmCall(), undefined, 'the blocked write does not reach the cache')
    assert.equal(await curlCall(), undefined, 'nor does the rule it tried to add')
  } finally {
    deactivateConfigGate(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the session-start warm snapshot is what a later blocked change cannot alter', async () => {
  const dir = project({ permissions: { deny: ['Bash(rm *)'] } })
  try {
    const call = gate(dir)
    activateConfigGate(dir)
    // The watcher warms every cache before it can block anything; no tool call
    // has run yet, so this is the only way the old snapshot can exist.
    await warmConfigGate(dir)

    writeSettings(dir, { permissions: { deny: [] } })
    assert.equal((await call()).kind, 'deny', 'a lazy first read must not see the blocked change')

    bumpConfigGeneration(dir)
    await warmConfigGate(dir)
    assert.equal(await call(), undefined)
  } finally {
    deactivateConfigGate(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})
