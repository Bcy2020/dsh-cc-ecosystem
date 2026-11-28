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

function gate(projectDir) {
  const ctx = new Context()
  apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-perm-gate-nohome') }))
  const call = () => ctx.waterfall('tools/pre-execute', {
    agent: { session: { header: { cwd: projectDir } } },
    name: 'bash',
    arguments: { command: 'rm -rf build' },
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

    bumpConfigGeneration(dir)
    assert.equal(await call(), undefined, 'an allowed change is picked up on the next call')
  } finally {
    deactivateConfigGate(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a blocked write that lands after an allowed change is never read back from disk', async () => {
  const dir = project({ permissions: { deny: ['Bash(rm *)'] } })
  try {
    const call = gate(dir)
    activateConfigGate(dir)
    await warmConfigGate(dir)
    assert.equal((await call()).kind, 'deny')

    // Allowed change: the disk now allows everything, and the generation moves
    // on. The adapter has NOT re-warmed yet (the watcher does that right after
    // bumping, but a write can land inside that window).
    writeSettings(dir, { permissions: { deny: [] } })
    bumpConfigGeneration(dir)

    // A second change lands a moment later and is BLOCKED. It must not be
    // reloaded (the mtime guard works at millisecond resolution).
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeSettings(dir, { permissions: { deny: ['Bash(curl *)'] } })
    const result = await call()
    assert.equal(result.kind, 'deny', 'a file newer than the last allowed change is not trusted')
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
    assert.equal(await call(), undefined)
  } finally {
    deactivateConfigGate(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})
