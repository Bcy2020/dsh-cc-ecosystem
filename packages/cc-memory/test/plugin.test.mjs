// Plugin-surface tests: the two switches, the per-assembly index read, and the
// read/write tool split. Uses a fake cordis context — no DSH host required.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { buildMemorySection } from '../src/prompt.js'
import { projectSlug } from '../src/discovery.js'

function fakeCtx() {
  const sections = []
  const toolDefs = []
  return {
    sections,
    toolDefs,
    logger: { info() {}, warn() {}, error() {} },
    systemPrompt: { section(definition) { sections.push(definition); return () => {} } },
    tools: { register(definition) { toolDefs.push(definition); return () => {} } },
  }
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-plugin-'))
  return {
    root,
    home: join(root, 'home'),
    claude: join(root, 'claude'),
    cwd: join(root, 'project'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function setupMemory(space, index = '- [Lesson](lesson.md) — a lesson\n') {
  const memoryDir = join(space.claude, 'projects', projectSlug(space.cwd), 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'MEMORY.md'), index)
  writeFileSync(join(memoryDir, 'lesson.md'), [
    '---',
    'name: lesson',
    'description: the lesson',
    'metadata:',
    '  node_type: memory',
    '  type: feedback',
    '  modified: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    'lesson body',
    '',
  ].join('\n'))
  return memoryDir
}

function config(space, extra = {}) {
  return {
    homeDir: space.home,
    globalClaudeDir: space.claude,
    statePath: join(space.root, 'state.json'),
    ...extra,
  }
}

function execFor(space) {
  return { agent: { session: { header: { cwd: space.cwd, id: 'session-1' } } } }
}

test('enabled:false registers nothing at all', () => {
  const space = workspace()
  try {
    setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space, { enabled: false }))
    assert.equal(ctx.sections.length, 0)
    assert.equal(ctx.toolDefs.length, 0)
  } finally { space.cleanup() }
})

test('read-only registers the prompt section and two read tools', () => {
  const space = workspace()
  try {
    setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space, { mode: 'read-only' }))
    assert.equal(ctx.sections.length, 1)
    assert.equal(ctx.sections[0].name, 'cc-memory:auto-memory')
    assert.deepEqual(ctx.toolDefs.map((tool) => tool.name).sort(), ['cc_memory_list', 'cc_memory_read'])
  } finally { space.cleanup() }
})

test('read-write additionally registers the two write tools', () => {
  const space = workspace()
  try {
    setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space, { mode: 'read-write' }))
    assert.deepEqual(ctx.toolDefs.map((tool) => tool.name).sort(), [
      'cc_memory_edit', 'cc_memory_list', 'cc_memory_read', 'cc_memory_write',
    ])
  } finally { space.cleanup() }
})

test('the section carries the index and switches its guidance with the mode', () => {
  const space = workspace()
  try {
    setupMemory(space)
    const exec = execFor(space)

    const readOnly = fakeCtx()
    apply(readOnly, config(space, { mode: 'read-only' }))
    const readOnlyText = readOnly.sections[0].text({ agent: exec.agent })
    assert.match(readOnlyText, /# auto memory/)
    assert.match(readOnlyText, /- \[Lesson\]\(lesson\.md\) — a lesson/)
    assert.match(readOnlyText, /memory is read-only in this session/)
    assert.match(readOnlyText, /## Types of memory/)
    assert.match(readOnlyText, /## What NOT to save in memory/)
    assert.match(readOnlyText, /## Before recommending from memory/)
    assert.match(readOnlyText, /\(user's auto-memory, persists across conversations\):/)
    assert.doesNotMatch(readOnlyText, /## How to save memories/)

    const readWrite = fakeCtx()
    apply(readWrite, config(space, { mode: 'read-write' }))
    const readWriteText = readWrite.sections[0].text({ agent: exec.agent })
    assert.match(readWriteText, /## How to save memories/)
    assert.match(readWriteText, /`cc_memory_write`/)
    assert.match(readWriteText, /`cc_memory_edit`/)
    assert.match(readWriteText, /The memory says X exists/)
    assert.doesNotMatch(readWriteText, /memory is read-only in this session/)
  } finally { space.cleanup() }
})

test('MEMORY.md is re-read on every assembly', () => {
  const space = workspace()
  try {
    const memoryDir = setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space))
    const exec = execFor(space)
    assert.match(ctx.sections[0].text({ agent: exec.agent }), /a lesson/)
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Lesson](lesson.md) — the changed hook\n')
    assert.match(ctx.sections[0].text({ agent: exec.agent }), /the changed hook/)
  } finally { space.cleanup() }
})

test('the 0.1.5 assembly shape (agent carried as scope) still resolves memory', () => {
  const space = workspace()
  try {
    setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space))
    const text = ctx.sections[0].text({ scope: execFor(space).agent })
    assert.match(text, /- \[Lesson\]\(lesson\.md\) — a lesson/)
  } finally { space.cleanup() }
})

test('pinned memory bodies are injected before MEMORY.md and escape "<"', () => {
  const space = workspace()
  try {
    const memoryDir = setupMemory(space)
    writeFileSync(join(memoryDir, 'pinned.md'), [
      '---',
      'name: pinned',
      'description: always applies',
      'metadata:',
      '  node_type: memory',
      '  type: feedback',
      '  pinned: true',
      '---',
      '',
      'alpha <script> beta',
      '',
    ].join('\n'))
    const ctx = fakeCtx()
    apply(ctx, config(space, { mode: 'read-only' }))
    const text = ctx.sections[0].text({ agent: execFor(space).agent })
    const pinnedAt = text.indexOf('# Pinned memories (apply to every conversation)')
    const indexAt = text.indexOf("Contents of ")
    assert.ok(pinnedAt >= 0, 'pinned block missing')
    assert.ok(indexAt > pinnedAt, 'pinned block must precede MEMORY.md')
    assert.match(text, /<pinned-memory path="[^"]*pinned\.md">/)
    assert.ok(text.includes('<\\script>'), 'body must escape "<"')
  } finally { space.cleanup() }
})

test('the section never contains a {{…}} interpolation group', () => {
  // DSH's renderPrompt throws on any `{{…}}` that is not a valid variable
  // reference, so neither the CLI template nor a memory body may carry one.
  const text = buildMemorySection({
    memoryDir: 'D:/m',
    index: { exists: true, content: '- [A](a.md) — {{index}}' },
    mode: 'read-write',
    pinned: [{ path: 'D:/m/p.md', content: 'body {{pinned}}' }],
  })
  assert.doesNotMatch(text, /\{\{/)
  assert.match(text, /name: \{short-kebab-case-slug\}/)
})

test('an assembly without an agent contributes nothing', () => {
  const space = workspace()
  try {
    setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space))
    assert.equal(ctx.sections[0].text({}), '')
  } finally { space.cleanup() }
})

test('read tools return the listing and one memory body', async () => {
  const space = workspace()
  try {
    setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space, { mode: 'read-only' }))
    const exec = execFor(space)
    const list = ctx.toolDefs.find((tool) => tool.name === 'cc_memory_list')
    const listed = await list.execute({}, exec)
    assert.deepEqual(listed.memories.map((memory) => memory.name), ['lesson.md'])
    assert.equal(listed.memories[0].type, 'feedback')

    const read = ctx.toolDefs.find((tool) => tool.name === 'cc_memory_read')
    const value = await read.execute({ name: 'lesson.md' }, exec)
    assert.match(value.content, /lesson body/)
  } finally { space.cleanup() }
})

test('write tools create a memory and then edit the index', async () => {
  const space = workspace()
  try {
    const memoryDir = setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space, { mode: 'read-write' }))
    const exec = execFor(space)

    const write = ctx.toolDefs.find((tool) => tool.name === 'cc_memory_write')
    const created = await write.execute({
      name: 'new-lesson',
      description: 'another durable lesson',
      type: 'project',
      content: 'Do not repeat this.',
    }, exec)
    assert.deepEqual(created, { name: 'new-lesson.md', operation: 'create' })
    const text = readFileSync(join(memoryDir, 'new-lesson.md'), 'utf8')
    assert.match(text, /type: project/)
    assert.match(text, /originSessionId: session-1/)

    const edit = ctx.toolDefs.find((tool) => tool.name === 'cc_memory_edit')
    const edited = await edit.execute({
      name: 'MEMORY.md',
      old_string: '- [Lesson](lesson.md) — a lesson',
      new_string: '- [Lesson](lesson.md) — a lesson\n- [New](new-lesson.md) — another durable lesson',
    }, exec)
    assert.deepEqual(edited, { name: 'MEMORY.md', replacements: 1 })
    assert.match(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), /new-lesson\.md/)
  } finally { space.cleanup() }
})

test('read-only mode has no path that writes memory', async () => {
  const space = workspace()
  try {
    const memoryDir = setupMemory(space)
    const ctx = fakeCtx()
    apply(ctx, config(space, { mode: 'read-only' }))
    assert.equal(ctx.toolDefs.some((tool) => tool.name === 'cc_memory_write'), false)
    assert.equal(ctx.toolDefs.some((tool) => tool.name === 'cc_memory_edit'), false)
    const read = ctx.toolDefs.find((tool) => tool.name === 'cc_memory_read')
    await assert.rejects(read.execute({ name: '../escape.md' }, execFor(space)), /escapes|invalid/)
    assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), '- [Lesson](lesson.md) — a lesson\n')
  } finally { space.cleanup() }
})
