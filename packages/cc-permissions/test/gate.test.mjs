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

function tempProject(settings, mcpServers) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-perm-test-'))
  mkdirSync(join(dir, '.git'), { recursive: true }) // git root (bounded walk boundary)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  // The `.mcp.json` approval gate only applies to servers a project config
  // declares — a user/local-scope server is never gated.
  if (mcpServers !== undefined) {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2), 'utf8')
  }
  return {
    dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

/** One project-scope server named `filesys`. */
const FILESYS = { filesys: { command: 'filesys-server' } }

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

// ─── `.mcp.json` servers: DEFAULT-OPEN ───────────────────────────────────────
//
// Claude Code gates project-scope MCP servers on an interactive approval. DSH
// has no approval prompt, so the policy is inverted: a project MCP tool RUNS
// unless settings explicitly reject that server. See src/index.js for why.

test('a project MCP tool runs with no approval configured', async () => {
  const t = tempProject({}, FILESYS)
  try {
    const { call } = gate(t.dir)
    assert.equal(await call('mcp__filesys__list'), undefined, 'nothing to decide → next()')
  } finally {
    t.cleanup()
  }
})

test('enableAllProjectMcpServers / enabledMcpjsonServers no longer decide anything', async () => {
  for (const settings of [
    { enableAllProjectMcpServers: true },
    { enabledMcpjsonServers: ['filesys'] },
    { enabledMcpjsonServers: ['other'] },
  ]) {
    const t = tempProject(settings, { ...FILESYS, other: { command: 'other-server' } })
    try {
      const { call } = gate(t.dir)
      const label = JSON.stringify(settings)
      assert.equal(await call('mcp__filesys__list'), undefined, label)
      assert.equal(await call('mcp__other__list'), undefined, label)
    } finally {
      t.cleanup()
    }
  }
})

test('disabledMcpjsonServers is the ONLY thing that blocks a project MCP server', async () => {
  const t = tempProject(
    {
      disabledMcpjsonServers: ['filesys'],
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['filesys'],
    },
    { ...FILESYS, other: { command: 'other-server' } },
  )
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result.kind, 'deny', 'an explicit rejection outranks every approval flag')
    assert.ok(result.reason.includes('disabledMcpjsonServers'))
    assert.equal(await call('mcp__other__list'), undefined, 'a server the list does not name is unaffected')
  } finally {
    t.cleanup()
  }
})

test('an explicit deny rule still wins over default-open', async () => {
  const t = tempProject({ permissions: { deny: ['mcp__filesys__list'] } }, FILESYS)
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result.kind, 'deny')
  } finally {
    t.cleanup()
  }
})

test('an explicit ask rule still asks over default-open', async () => {
  const t = tempProject({ permissions: { ask: ['mcp__filesys__list'] } }, FILESYS)
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result.kind, 'ask')
  } finally {
    t.cleanup()
  }
})

test('plugin MCP tools are not project servers and are never gated', async () => {
  const t = tempProject({ disabledMcpjsonServers: ['filesys'] }, FILESYS)
  try {
    const { call } = gate(t.dir)
    assert.equal(
      await call('mcp__plugin_myplugin_mysrv__tool'),
      undefined,
      'the plugin namespace never matches a project .mcp.json server name',
    )
  } finally {
    t.cleanup()
  }
})

test('no project .mcp.json: MCP tools are not gated at all', async () => {
  const t = tempProject({ disabledMcpjsonServers: ['filesys'] })
  try {
    const { call } = gate(t.dir)
    const result = await call('mcp__filesys__list')
    assert.equal(result, undefined, 'user/local-scope servers fall through to next()')
  } finally {
    t.cleanup()
  }
})
