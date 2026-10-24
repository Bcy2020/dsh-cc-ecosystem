// Persisted runtime switches: defaults, round-trip, and corrupt-file fallback.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultStatePath, loadState, saveState, STATE_VERSION } from '../src/state.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-state-'))
  return { root, path: join(root, 'cc-memory-state.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const defaults = { enabled: true, mode: 'read-only' }

test('a missing state file falls back to the Config defaults', () => {
  const space = workspace()
  try {
    const loaded = loadState(space.path, defaults)
    assert.equal(loaded.enabled, true)
    assert.equal(loaded.mode, 'read-only')
    assert.equal(loaded.source, 'defaults')
    assert.equal(loaded.error, undefined)
  } finally { space.cleanup() }
})

test('save then load round-trips both switches and the shape version', () => {
  const space = workspace()
  try {
    saveState(space.path, { enabled: false, mode: 'read-write' })
    const raw = JSON.parse(readFileSync(space.path, 'utf8'))
    assert.equal(raw.version, STATE_VERSION)
    assert.equal(raw.enabled, false)
    assert.equal(raw.mode, 'read-write')
    const loaded = loadState(space.path, defaults)
    assert.equal(loaded.enabled, false)
    assert.equal(loaded.mode, 'read-write')
    assert.equal(loaded.source, 'file')
  } finally { space.cleanup() }
})

test('malformed JSON and invalid values fall back with a reported error', () => {
  const space = workspace()
  try {
    writeFileSync(space.path, '{not json')
    let loaded = loadState(space.path, defaults)
    assert.equal(loaded.source, 'defaults')
    assert.match(loaded.error, /invalid JSON/)

    writeFileSync(space.path, JSON.stringify({ version: 99, enabled: true, mode: 'read-only' }))
    loaded = loadState(space.path, defaults)
    assert.equal(loaded.source, 'defaults')
    assert.match(loaded.error, /unsupported state version/)

    writeFileSync(space.path, JSON.stringify({ version: STATE_VERSION, enabled: 'yes', mode: 'read-only' }))
    loaded = loadState(space.path, defaults)
    assert.match(loaded.error, /enabled must be a boolean/)

    writeFileSync(space.path, JSON.stringify({ version: STATE_VERSION, enabled: true, mode: 'write' }))
    loaded = loadState(space.path, defaults)
    assert.match(loaded.error, /mode must be one of/)
  } finally { space.cleanup() }
})

test('defaultStatePath follows DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:/custom-dsh'
    assert.equal(defaultStatePath(), join('C:/custom-dsh', 'cc-memory-state.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
