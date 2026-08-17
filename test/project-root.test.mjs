// Unit tests for findProjectRoot marker discovery (cc-loader/src/skills.js):
// projects without a .git repo must still resolve their root via .dsh / .claude.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot, findClaudeProjectRoot } from '../packages/cc-loader/src/skills.js'

function tmpTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-root-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// findClaudeProjectRoot tests run under the REAL home directory (the temp
// tree lives inside it), so walking up from a tree without markers reaches
// ~/.claude / ~/.git — exactly the home-exclusion case the function guards.
const HOME = homedir()

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

// ─── findClaudeProjectRoot (CC semantics: closest .claude/, .git fallback) ──

test('findClaudeProjectRoot: closest .claude/ directory wins over .git root', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    // git root at dir, but a nested package carries its own .claude/
    mkdirSync(join(dir, 'repo', 'packages', 'a'), { recursive: true })
    mkdirSync(join(dir, 'repo', '.git'))
    mkdirSync(join(dir, 'repo', 'packages', 'a', '.claude'))
    // cwd inside package a → CC resolves to the package (closest .claude), not the git root
    assert.equal(await findClaudeProjectRoot(join(dir, 'repo', 'packages', 'a', 'src'), { homeDir: HOME }), join(dir, 'repo', 'packages', 'a'))
  } finally { cleanup() }
})

test('findClaudeProjectRoot: non-git project with .claude resolves', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirSync(join(dir, 'proj', 'src'), { recursive: true })
    mkdirSync(join(dir, 'proj', '.claude'))
    assert.equal(await findClaudeProjectRoot(join(dir, 'proj', 'src'), { homeDir: HOME }), join(dir, 'proj'))
  } finally { cleanup() }
})

test('findClaudeProjectRoot: falls back to .git when no .claude exists', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirSync(join(dir, 'repo', 'src'), { recursive: true })
    mkdirSync(join(dir, 'repo', '.git'))
    // stopAt keeps the walk inside the tree: no .claude anywhere below it,
    // so the .git fallback must win (home exclusion + walk-top markers on the
    // real machine cannot interfere).
    assert.equal(await findClaudeProjectRoot(join(dir, 'repo', 'src'), { homeDir: HOME, stopAt: dir }), join(dir, 'repo'))
  } finally { cleanup() }
})

test('findClaudeProjectRoot: home is never treated as a project root', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    // Simulated home inside the tree carries ~/.claude and ~/.git (a
    // git-backed home, like Claude Code's global config dir). A session in a
    // non-project subdirectory must NOT resolve its root to home.
    const home = join(dir, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.git'), { recursive: true })
    mkdirSync(join(home, 'scratch'), { recursive: true })
    assert.equal(await findClaudeProjectRoot(join(home, 'scratch'), { homeDir: home, stopAt: dir }), undefined)
  } finally { cleanup() }
})

test('findClaudeProjectRoot: cwd directly in home resolves undefined', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    const home = join(dir, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    assert.equal(await findClaudeProjectRoot(home, { homeDir: home, stopAt: dir }), undefined)
  } finally { cleanup() }
})
