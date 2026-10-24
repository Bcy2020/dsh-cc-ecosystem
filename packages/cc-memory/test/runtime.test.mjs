// Runtime switch controller: registration follows enabled/mode, toggles do not
// need a restart, and every change is persisted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRuntime } from '../src/runtime.js'

function context() {
  const sections = new Map()
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition)
        return () => { if (sections.get(definition.name) === definition) sections.delete(definition.name) }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => { if (tools.get(definition.name) === definition) tools.delete(definition.name) }
      },
    },
  }
  return { ctx, sections, toolNames: () => [...tools.keys()].sort() }
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-runtime-'))
  const memoryDirectory = join(root, 'memory')
  mkdirSync(memoryDirectory, { recursive: true })
  writeFileSync(join(memoryDirectory, 'MEMORY.md'), '- [A](a.md) — a\n')
  writeFileSync(join(memoryDirectory, 'a.md'), '---\nname: a\ndescription: d\nmetadata:\n  type: feedback\n---\n\nbody\n')
  return {
    root,
    memoryDirectory,
    statePath: join(root, 'state.json'),
    config(extra = {}) {
      return {
        homeDir: root,
        globalClaudeDir: join(root, 'claude'),
        statePath: join(root, 'state.json'),
        memoryDirectory,
        enabled: true,
        mode: 'read-only',
        ...extra,
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// The fake context exposes `systemPrompt.section` and `tools.register` exactly
// as the runtime uses them; the returned maps are the assertions' view.

test('start registers section + read tools for the default read-only state', () => {
  const space = workspace()
  try {
    const { ctx, sections, toolNames } = context()
    const runtime = new MemoryRuntime(ctx, space.config())
    runtime.start()
    assert.equal(sections.size, 1)
    assert.deepEqual(toolNames(), ['cc_memory_list', 'cc_memory_read'])
    assert.equal(runtime.enabled, true)
    assert.equal(runtime.mode, 'read-only')
    runtime.dispose()
  } finally { space.cleanup() }
})

test('mode toggle adds and removes the write tools without re-registering the section', () => {
  const space = workspace()
  try {
    const { ctx, sections, toolNames } = context()
    const runtime = new MemoryRuntime(ctx, space.config())
    runtime.start()
    const section = sections.get('cc-memory:auto-memory')

    runtime.set({ mode: 'read-write' })
    assert.deepEqual(toolNames(), ['cc_memory_edit', 'cc_memory_list', 'cc_memory_read', 'cc_memory_write'])
    assert.equal(sections.get('cc-memory:auto-memory'), section)
    assert.match(section.text({ agent: { session: { header: { cwd: space.root } } } }), /## How to save memories/)

    runtime.set({ mode: 'read-only' })
    assert.deepEqual(toolNames(), ['cc_memory_list', 'cc_memory_read'])
    assert.doesNotMatch(section.text({ agent: { session: { header: { cwd: space.root } } } }), /## How to save memories/)
    runtime.dispose()
  } finally { space.cleanup() }
})

test('disabling unregisters everything and re-enabling restores the saved mode', () => {
  const space = workspace()
  try {
    const { ctx, sections, toolNames } = context()
    const runtime = new MemoryRuntime(ctx, space.config({ mode: 'read-write' }))
    runtime.start()
    assert.equal(toolNames().length, 4)

    runtime.set({ enabled: false })
    assert.equal(sections.size, 0)
    assert.deepEqual(toolNames(), [])
    assert.equal(runtime.snapshot().effectiveMode, null)
    assert.equal(runtime.render({ agent: { session: { header: { cwd: space.root } } } }), '')

    runtime.set({ enabled: true })
    assert.equal(sections.size, 1)
    assert.deepEqual(toolNames(), ['cc_memory_edit', 'cc_memory_list', 'cc_memory_read', 'cc_memory_write'])
    runtime.dispose()
  } finally { space.cleanup() }
})

test('every toggle is persisted and a fresh runtime loads it', () => {
  const space = workspace()
  try {
    const first = context()
    const runtime = new MemoryRuntime(first.ctx, space.config())
    runtime.start()
    runtime.set({ enabled: true, mode: 'read-write' })
    runtime.dispose()

    const saved = JSON.parse(readFileSync(space.statePath, 'utf8'))
    assert.equal(saved.enabled, true)
    assert.equal(saved.mode, 'read-write')

    const second = context()
    const reloaded = new MemoryRuntime(second.ctx, space.config({ mode: 'read-only' }))
    reloaded.start()
    assert.equal(reloaded.mode, 'read-write')
    assert.equal(reloaded.stateSource, 'file')
    assert.equal(second.toolNames().length, 4)
    reloaded.dispose()
  } finally { space.cleanup() }
})

test('an invalid patch is rejected and changes nothing', () => {
  const space = workspace()
  try {
    const { ctx, sections, toolNames } = context()
    const runtime = new MemoryRuntime(ctx, space.config())
    runtime.start()
    assert.throws(() => runtime.set({ mode: 'write' }), /mode must be one of/)
    assert.throws(() => runtime.set({ enabled: 'yes' }), /enabled must be a boolean/)
    assert.equal(sections.size, 1)
    assert.deepEqual(toolNames(), ['cc_memory_list', 'cc_memory_read'])
    runtime.dispose()
  } finally { space.cleanup() }
})

test('a corrupt state file falls back to Config defaults', () => {
  const space = workspace()
  try {
    writeFileSync(space.statePath, '{oops')
    const { ctx, sections, toolNames } = context()
    const runtime = new MemoryRuntime(ctx, space.config({ mode: 'read-write' }))
    runtime.start()
    assert.equal(runtime.stateSource, 'defaults')
    assert.match(runtime.snapshot().stateError, /invalid JSON/)
    assert.equal(sections.size, 1)
    assert.equal(toolNames().length, 4)
    runtime.dispose()
  } finally { space.cleanup() }
})
