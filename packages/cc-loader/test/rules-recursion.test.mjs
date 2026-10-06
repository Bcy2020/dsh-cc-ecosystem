// discoverRules walks the whole `.claude/rules` tree.
//
// Rule packs routinely organize rules in folders (`rules/common/`,
// `rules/typescript/` …). The reader used to look at the top level only, so
// those projects produced zero rules and the rules section injected nothing —
// a silent no-op with no warning anywhere.
//
// `name` is the path relative to the rules dir (slash-separated), which for a
// top-level file is just its filename — that keeps the existing display
// heading for flat rule dirs unchanged while making nested entries unique.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { discoverRules } from '../src/skills.js'

async function rulesDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-rules-'))
  for (const rel of files) {
    const path = join(dir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `# ${rel}\n`)
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const names = (rules) => rules.map((r) => r.name)

test('top-level rules keep their filename and are sorted', async () => {
  const { dir, cleanup } = await rulesDir(['02-b.md', '01-a.md'])
  try {
    assert.deepEqual(names(await discoverRules(dir, 'project')), ['01-a.md', '02-b.md'])
  } finally { await cleanup() }
})

test('rules in subfolders are found; name is the relative path', async () => {
  const { dir, cleanup } = await rulesDir([
    'a.md',
    'common/z.md',
    'typescript/a.md',
  ])
  try {
    const rules = await discoverRules(dir, 'project')
    assert.deepEqual(names(rules), ['a.md', 'common/z.md', 'typescript/a.md'])
  } finally { await cleanup() }
})

test('the same filename in two folders yields two distinct rules', async () => {
  const { dir, cleanup } = await rulesDir(['common/style.md', 'typescript/style.md'])
  try {
    const rules = await discoverRules(dir, 'project')
    assert.deepEqual(names(rules), ['common/style.md', 'typescript/style.md'])
    assert.notEqual(rules[0].path, rules[1].path)
  } finally { await cleanup() }
})

test('nesting is not depth-limited', async () => {
  const { dir, cleanup } = await rulesDir(['a/b/c/d/deep.md'])
  try {
    assert.deepEqual(names(await discoverRules(dir, 'project')), ['a/b/c/d/deep.md'])
  } finally { await cleanup() }
})

test('hidden folders and node_modules are skipped', async () => {
  const { dir, cleanup } = await rulesDir([
    'keep.md',
    '.archive/hidden.md',
    'node_modules/pkg/vendored.md',
  ])
  try {
    assert.deepEqual(names(await discoverRules(dir, 'project')), ['keep.md'])
  } finally { await cleanup() }
})

test('non-markdown files anywhere in the tree are skipped', async () => {
  const { dir, cleanup } = await rulesDir(['keep.md', 'notes.txt', 'common/readme.json'])
  try {
    assert.deepEqual(names(await discoverRules(dir, 'project')), ['keep.md'])
  } finally { await cleanup() }
})

test('a missing rules dir yields no rules', async () => {
  const dir = join(tmpdir(), 'cc-rules-does-not-exist')
  assert.deepEqual(await discoverRules(dir, 'project'), [])
})

test('every entry carries its scope and a readable absolute path', async () => {
  const { dir, cleanup } = await rulesDir(['common/a.md'])
  try {
    const [rule] = await discoverRules(dir, 'user')
    assert.equal(rule.scope, 'user')
    assert.equal(rule.status, 'DIRECT')
    assert.equal(rule.path, join(dir, 'common', 'a.md'))
  } finally { await cleanup() }
})
