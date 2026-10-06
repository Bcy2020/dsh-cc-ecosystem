// Unit tests for findProjectRoot marker discovery (cc-loader/src/skills.js):
// projects without a .git repo must still resolve their root via .dsh / .claude.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot, findClaudeProjectRoot } from '../packages/cc-loader/src/skills.js'
import { Config as SkillsConfig } from '../packages/cc-skills/src/index.js'
import { Config as AgentsConfig } from '../packages/cc-agents/src/index.js'
import { Config as PermissionsConfig } from '../packages/cc-permissions/src/index.js'
import { Config as HooksConfig } from '../packages/cc-hooks/src/index.js'
import { Config as McpConfig } from '../packages/cc-mcp/src/index.js'

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

// ─── `.claude` as a default marker, with the home guard ────────────────────
//
// Claude Code resolves project settings at the nearest `.claude/`, so a project
// without a git repo must still have a root.

test('findProjectRoot: .claude is a default marker (no .git anywhere)', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirSync(join(dir, 'proj', 'src'), { recursive: true })
    mkdirSync(join(dir, 'proj', '.claude'))
    assert.equal(await findProjectRoot(join(dir, 'proj', 'src')), join(dir, 'proj'))
  } finally { cleanup() }
})

test('findProjectRoot: home is never a project root', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    // A simulated home carrying `~/.claude` and a session in a plain
    // subdirectory of it. Without the guard the walk matches the home's
    // `.claude` and loads Claude Code's *global* config as a project's.
    const home = join(dir, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, 'scratch'), { recursive: true })
    const cwd = join(home, 'scratch')

    assert.equal(
      await findProjectRoot(cwd, ['.git', '.claude']),
      home,
      'without homeDir the walk does match home — this is the case the guard exists for',
    )
    assert.notEqual(
      await findProjectRoot(cwd, ['.git', '.claude'], { homeDir: home }),
      home,
      'with homeDir the walk must skip home and keep going',
    )
  } finally { cleanup() }
})

// ─── every cc-* package must accept `.claude` as a root marker ─────────────
//
// The marker list is per-package config, so a package can drift. Each one must
// carry both `.git` and `.claude` (cc-mcp adds `.dsh`; extras are fine).

for (const [name, Config] of [
  ['cc-skills', SkillsConfig],
  ['cc-agents', AgentsConfig],
  ['cc-permissions', PermissionsConfig],
  ['cc-hooks', HooksConfig],
  ['cc-mcp', McpConfig],
]) {
  test(`${name}: projectRootMarkers default carries .git and .claude`, () => {
    const markers = Config({}).projectRootMarkers
    assert.ok(Array.isArray(markers), `${name}: projectRootMarkers must be an array`)
    assert.ok(markers.includes('.git'), `${name}: ${JSON.stringify(markers)} lacks .git`)
    assert.ok(markers.includes('.claude'), `${name}: ${JSON.stringify(markers)} lacks .claude`)
  })
}
