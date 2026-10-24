// Discovery-layer tests: slug, memory-dir resolution, index budget, listing,
// path containment, and the read/write/edit primitives. No DSH host needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  editMemory, expandMemoryDirectory, listMemories, memoryMeta, parseFrontmatter,
  projectSlug, readMemory, readMemoryIndex, readPinnedMemories, resolveMemoryDir, slugifyPath,
  truncateIndex, truncateMemoryBody, writeMemory,
} from '../src/discovery.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function memoryFile(name, { description = 'desc', type = 'project', modified = '2026-01-01T00:00:00.000Z', body = 'body', pinned } = {}) {
  return [
    '---',
    `name: ${name.replace(/\.md$/, '')}`,
    `description: ${description}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${type}`,
    `  modified: ${modified}`,
    ...(pinned === undefined ? [] : [`  pinned: ${pinned}`]),
    '---',
    '',
    body,
    '',
  ].join('\n')
}

test('slug mirrors CC: every non-alphanumeric becomes "-" and case is kept', () => {
  assert.equal(slugifyPath('C:\\Users\\Me'), 'C--Users-Me')
  assert.equal(slugifyPath('/home/me/.claude_x'), '-home-me--claude-x')
  assert.equal(slugifyPath('/repo/D--project-AAPP'), '-repo-D--project-AAPP')
})

test('projectSlug resolves symlinks before slugging', () => {
  const { root, cleanup } = workspace()
  try {
    const cwd = join(root, 'project')
    mkdirSync(cwd)
    assert.equal(projectSlug(cwd), slugifyPath(realpathSync.native(cwd)))
  } finally { cleanup() }
})

test('default memory dir is <config>/projects/<slug>/memory', () => {
  const { root, cleanup } = workspace()
  try {
    const home = join(root, 'home')
    const claude = join(root, 'claude')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const expected = join(claude, 'projects', projectSlug(cwd), 'memory')
    assert.equal(resolveMemoryDir(cwd, { homeDir: home, globalClaudeDir: claude }), expected)
  } finally { cleanup() }
})

test('autoMemoryDirectory from local settings wins, with ~/ expansion', () => {
  const { root, cleanup } = workspace()
  try {
    const home = join(root, 'home')
    const claude = join(root, 'claude')
    const cwd = join(root, 'project')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '~/custom-mem' }))
    assert.equal(
      resolveMemoryDir(cwd, { homeDir: home, globalClaudeDir: claude }),
      join(home, 'custom-mem'),
    )
  } finally { cleanup() }
})

test('user settings are the fallback; project settings are deliberately ignored', () => {
  const { root, cleanup } = workspace()
  try {
    const home = join(root, 'home')
    const claude = join(root, 'claude')
    const cwd = join(root, 'project')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    mkdirSync(claude, { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: join(root, 'from-project') }))
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ autoMemoryDirectory: join(root, 'from-user') }))
    assert.equal(
      resolveMemoryDir(cwd, { homeDir: home, globalClaudeDir: claude }),
      join(root, 'from-user'),
    )
  } finally { cleanup() }
})

test('an explicit memoryDirectory override bypasses slug discovery', () => {
  const { root, cleanup } = workspace()
  try {
    const home = join(root, 'home')
    const claude = join(root, 'claude')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    assert.equal(
      resolveMemoryDir(cwd, { homeDir: home, globalClaudeDir: claude, memoryDirectory: join(root, 'fixed-memory') }),
      resolve(root, 'fixed-memory'),
    )
  } finally { cleanup() }
})

test('autoMemoryDirectory rejects relative paths and .. escapes', () => {
  assert.equal(expandMemoryDirectory('relative/mem', '/home/me'), undefined)
  assert.equal(expandMemoryDirectory('~/../outside', '/home/me'), undefined)
  assert.equal(expandMemoryDirectory('~/inside', '/home/me'), resolve('/home/me', 'inside'))
})

test('frontmatter parser reads the flat metadata shape memory files use', () => {
  const { data, body } = parseFrontmatter(memoryFile('a', { description: 'one line', type: 'feedback', body: 'hello' }))
  const meta = memoryMeta(data)
  assert.equal(meta.name, 'a')
  assert.equal(meta.description, 'one line')
  assert.equal(meta.type, 'feedback')
  assert.equal(meta.modified, '2026-01-01T00:00:00.000Z')
  assert.equal(body.trim(), 'hello')
})

test('index under budget is returned untouched', () => {
  const result = truncateIndex('- one\n- two\n')
  assert.equal(result.content, '- one\n- two')
  assert.equal(result.warning, undefined)
  assert.equal(result.lineCount, 2)
})

test('index truncates at 200 lines and says where it cut', () => {
  const raw = Array.from({ length: 250 }, (_value, index) => `- m${index + 1}`).join('\n')
  const result = truncateIndex(raw)
  const [loaded, warning] = result.content.split('\n\n> WARNING: ')
  assert.equal(loaded.split('\n').length, 200)
  assert.match(warning, /50 of 250 lines were cut off, starting at line 201 \("- m201"\)/)
  assert.match(warning, /250 lines \(limit: 200\)/)
})

test('index truncates at 25,000 characters, not bytes', () => {
  const line = `- ${'x'.repeat(198)}`
  const raw = Array.from({ length: 150 }, () => line).join('\n')
  const result = truncateIndex(raw)
  assert.ok(result.content.length > 25000) // truncated text + WARNING paragraph
  assert.match(result.content, /limit: 24\.4KB/)
  assert.ok(result.charCount > 25000)
})

test('listing excludes MEMORY.md, hidden dirs, reserved dirs and archive/', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    mkdirSync(join(dir, 'archive'), { recursive: true })
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    mkdirSync(join(dir, 'team'), { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — a\n')
    writeFileSync(join(dir, 'a.md'), memoryFile('a', { description: 'first', type: 'feedback', modified: '2026-01-02T00:00:00.000Z' }))
    writeFileSync(join(dir, 'b.md'), memoryFile('b', { description: 'second', type: 'project', modified: '2026-01-01T00:00:00.000Z' }))
    writeFileSync(join(dir, 'archive', 'old.md'), memoryFile('old', { modified: '2025-01-01T00:00:00.000Z' }))
    writeFileSync(join(dir, '.hidden', 'x.md'), memoryFile('x'))
    writeFileSync(join(dir, 'team', 'y.md'), memoryFile('y'))
    assert.deepEqual(listMemories(dir).map((memory) => memory.name), ['a.md', 'b.md'])
    assert.deepEqual(listMemories(dir, { includeArchive: true }).map((memory) => memory.name), ['a.md', 'b.md', 'archive/old.md'])
    assert.equal(listMemories(dir)[0].type, 'feedback')
  } finally { cleanup() }
})

test('index read reports a missing MEMORY.md without throwing', () => {
  const { root, cleanup } = workspace()
  try {
    const index = readMemoryIndex(join(root, 'memory'))
    assert.equal(index.exists, false)
    assert.equal(index.content, '')
  } finally { cleanup() }
})

test('memory paths cannot escape the memory directory', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    mkdirSync(join(dir, 'archive'), { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'idx')
    writeFileSync(join(dir, 'archive', 'old.md'), 'old')
    assert.throws(() => readMemory(dir, '../outside.md'), /escapes|invalid/)
    assert.throws(() => readMemory(dir, join(root, 'outside.md')), /escapes|invalid/)
    assert.throws(() => readMemory(dir, '.hidden/x.md'), /hidden/)
    assert.throws(() => readMemory(dir, 'archive/old.md'), /archive/)
    assert.equal(readMemory(dir, 'archive/old.md', { includeArchive: true }).content, 'old')
    assert.throws(() => readMemory(dir, 'not-markdown.txt'), /\.md/)
    assert.equal(readMemory(dir, 'MEMORY.md').content, 'idx')
  } finally { cleanup() }
})

test('write creates frontmatter, updates in place, and preserves originSessionId', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    const created = writeMemory(dir, {
      name: 'new-memory',
      description: 'a durable lesson',
      type: 'feedback',
      content: 'Do the thing.',
      originSessionId: 'session-1',
    })
    assert.equal(created.operation, 'create')
    const text = readFileSync(created.path, 'utf8')
    assert.match(text, /name: new-memory/)
    assert.match(text, /type: feedback/)
    assert.match(text, /originSessionId: session-1/)
    assert.match(text, /modified: \d{4}-\d{2}-\d{2}T/)

    const updated = writeMemory(dir, {
      name: 'new-memory',
      description: 'a better lesson',
      type: 'project',
      content: 'Do the other thing.',
    })
    assert.equal(updated.operation, 'update')
    const after = readFileSync(updated.path, 'utf8')
    assert.match(after, /description: a better lesson/)
    assert.match(after, /type: project/)
    assert.match(after, /originSessionId: session-1/)
  } finally { cleanup() }
})

test('write validates slug, type and description', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    assert.throws(() => writeMemory(dir, { name: 'Not A Slug', description: 'd', type: 'project', content: 'c' }), /kebab-case/)
    assert.throws(() => writeMemory(dir, { name: 'ok', description: 'd', type: 'nope', content: 'c' }), /type must be one of/)
    assert.throws(() => writeMemory(dir, { name: 'ok', description: 'two\nlines', type: 'project', content: 'c' }), /one line/)
    assert.throws(() => writeMemory(dir, { name: 'MEMORY', description: 'd', type: 'project', content: 'c' }), /index/)
  } finally { cleanup() }
})

test('edit requires a unique match unless replace_all is set and refreshes modified', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    const created = writeMemory(dir, { name: 'edit-me', description: 'd', type: 'project', content: 'alpha beta alpha' })
    // Pin an old stamp so the refresh is observable even within one millisecond.
    const pinned = readFileSync(created.path, 'utf8').replace(/modified: .*/, 'modified: 2020-01-01T00:00:00.000Z')
    writeFileSync(created.path, pinned)
    assert.throws(() => editMemory(dir, { name: 'edit-me.md', oldString: 'alpha', newString: 'gamma' }), /appears 2 times/)
    const result = editMemory(dir, { name: 'edit-me.md', oldString: 'alpha', newString: 'gamma', replaceAll: true })
    assert.equal(result.replacements, 2)
    const after = readFileSync(created.path, 'utf8')
    assert.match(after, /gamma beta gamma/)
    assert.notEqual(after.match(/modified: (.*)/)[1], '2020-01-01T00:00:00.000Z')
  } finally { cleanup() }
})

test('edit can target MEMORY.md and does not require frontmatter', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n')
    editMemory(dir, { name: 'MEMORY.md', oldString: 'hook', newString: 'better hook' })
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [A](a.md) — better hook\n')
  } finally { cleanup() }
})

test('pinned memories are injected newest first, capped at 4, body without frontmatter', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    mkdirSync(dir, { recursive: true })
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(join(dir, `pinned-${index}.md`), memoryFile(`pinned-${index}`, {
        modified: `2026-01-0${index}T00:00:00.000Z`,
        body: `pinned body ${index}`,
        pinned: 'true',
      }))
    }
    writeFileSync(join(dir, 'not-pinned.md'), memoryFile('not-pinned', { modified: '2026-02-01T00:00:00.000Z' }))
    writeFileSync(join(dir, 'malformed.md'), memoryFile('malformed', { modified: '2026-02-02T00:00:00.000Z', pinned: 'yes' }))

    const pinned = readPinnedMemories(dir, { cacheTtlMs: 0 })
    assert.deepEqual(pinned.map((entry) => basename(entry.path)), [
      'pinned-6.md', 'pinned-5.md', 'pinned-4.md', 'pinned-3.md',
    ])
    assert.equal(pinned[0].content, 'pinned body 6')
    assert.doesNotMatch(pinned[0].content, /^---/)
  } finally { cleanup() }
})

test('a pinned body over the budget gets the per-memory warning', () => {
  const raw = Array.from({ length: 250 }, (_value, index) => `line ${index + 1}`).join('\n')
  const result = truncateMemoryBody(raw)
  assert.match(result.content, /> WARNING: this memory file is 250 lines \(limit: 200\)/)
  assert.match(result.content, /Keep each memory file focused on one topic/)
})

test('writing a pinned memory invalidates the pinned scan cache', () => {
  const { root, cleanup } = workspace()
  try {
    const dir = join(root, 'memory')
    mkdirSync(dir, { recursive: true })
    assert.deepEqual(readPinnedMemories(dir), [])
    writeMemory(dir, { name: 'new-pinned', description: 'p', type: 'project', content: 'pinned later', pinned: true })
    const pinned = readPinnedMemories(dir)
    assert.equal(pinned.length, 1)
    assert.equal(pinned[0].content, 'pinned later')
  } finally { cleanup() }
})
