// Unit tests for the cc-permissions gate: enableAllProjectMcpServers
// auto-approves PROJECT MCP tools (mcp__<server>__<tool>) at the bottom of the
// deny → ask → allow fold, while explicit deny rules and plugin MCP tools
// (mcp__plugin_…) keep their normal behavior.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.js'

function tempProject(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-perm-test-'))
  mkdirSync(join(dir, '.git'), { recursive: true }) // project-root marker
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  return {
    dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

function gate(projectDir) {
  const ctx = new Context()
  apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-perm-nohome') }))
  const call = (name, args = {}) =>
    ctx.waterfall('tools/pre-execute', {
      agent: { session: { header: { cwd: projectDir } } },
      name,
      arguments: args,
    }, () => undefined)
  return { ctx, call }
}

test('enableAllProjectMcpServers: project MCP tool auto-allowed on no-rule', async () => {
  const t = tempProject({ enableAllProjectMcpServers: true })
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result.kind, 'allow')
    assert.ok(result.reason.includes('enableAllProjectMcpServers'))
  } finally {
    t.cleanup()
  }
})

test('enableAllProjectMcpServers: explicit deny rule still wins', async () => {
  const t = tempProject({
    enableAllProjectMcpServers: true,
    permissions: { deny: ['mcp__filesys__list'] },
  })
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result.kind, 'deny')
  } finally {
    t.cleanup()
  }
})

test('enableAllProjectMcpServers: explicit ask rule still asks', async () => {
  const t = tempProject({
    enableAllProjectMcpServers: true,
    permissions: { ask: ['mcp__filesys__list'] },
  })
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result.kind, 'ask')
  } finally {
    t.cleanup()
  }
})

test('enableAllProjectMcpServers: plugin MCP tools NOT auto-allowed', async () => {
  const t = tempProject({ enableAllProjectMcpServers: true })
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__plugin_myplugin_mysrv__tool')
    assert.equal(result, undefined, 'plugin MCP falls through to next()')
  } finally {
    t.cleanup()
  }
})

test('without the setting: project MCP tool falls through to next()', async () => {
  const t = tempProject({})
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result, undefined)
  } finally {
    t.cleanup()
  }
})
