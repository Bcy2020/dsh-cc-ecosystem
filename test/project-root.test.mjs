// Unit tests for findProjectRoot marker discovery (cc-loader/src/skills.js):
// projects without a .git repo must still resolve their root via .dsh / .claude.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot } from '../packages/cc-loader/src/skills.js'

function tmpTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-root-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('findProjectRoot: .git marker (default)', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    mkdirSync(join(dir, 'a', '.git'))
    assert.equal(await findProjectRoot(join(dir, 'a', 'b')), join(dir, 'a'))
  } finally { cleanup() }
})

test('findProjectRoot: falls back to .dsh when no .git exists', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    mkdirSync(join(dir, 'a', '.dsh'))
    assert.equal(await findProjectRoot(join(dir, 'a', 'b'), ['.git', '.dsh', '.claude']), join(dir, 'a'))
  } finally { cleanup() }
})

test('findProjectRoot: falls back to .claude when no .git/.dsh exists', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    mkdirSync(join(dir, 'a', '.claude'))
    assert.equal(await findProjectRoot(join(dir, 'a', 'b'), ['.git', '.dsh', '.claude']), join(dir, 'a'))
  } finally { cleanup() }
})

test('findProjectRoot: returns undefined when no marker exists on the walk', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    assert.equal(await findProjectRoot(join(dir, 'a', 'b'), ['__no_such_marker__']), undefined)
  } finally { cleanup() }
})
