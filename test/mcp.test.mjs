// Unit tests for dsh-cc-loader MCP discovery (.mcp.json / plugin.json inline):
// dual-form parsing, transport classification, env placeholder preservation,
// project-root discovery, and loadClaude IR integration.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseMcpText, serverEntries, discoverMcpConfig, discoverProjectMcp,
  VALID_SERVER_NAME,
} from '../packages/cc-loader/src/mcp.js'
import { loadClaude } from '../packages/cc-loader/src/load.js'
import { STATUS } from '../packages/cc-loader/src/classify.js'

function tmpTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ─── parseMcpText: dual form ─────────────────────────────────────────────────

test('parseMcpText: mcpServers-wrapped form (project level)', () => {
  const map = parseMcpText('{ "mcpServers": { "github": { "command": "npx" } } }')
  assert.deepEqual(Object.keys(map), ['github'])
})

test('parseMcpText: bare server map form (official plugin form)', () => {
  const map = parseMcpText('{ "database-tools": { "command": "db-server" }, "api": { "type": "http", "url": "https://x/mcp" } }')
  assert.deepEqual(Object.keys(map), ['database-tools', 'api'])
})

test('parseMcpText: rejects invalid JSON', () => {
  assert.throws(() => parseMcpText('{ not json'), /invalid JSON/)
})

test('parseMcpText: rejects non-object', () => {
  assert.throws(() => parseMcpText('[1,2]'), /JSON object/)
})

test('parseMcpText: rejects mixed bare map (non-object value)', () => {
  assert.throws(() => parseMcpText('{ "a": { "command": "x" }, "b": 42 }'), /mcpServers/)
})

// ─── serverEntries: classification ───────────────────────────────────────────

test('serverEntries: stdio (command) is DIRECT', () => {
  const entries = serverEntries({ runapi: { command: 'npx', args: ['-y', '@runapi.ai/mcp'], env: { KEY: '${RUNAPI_API_KEY}' } } })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, STATUS.DIRECT)
  assert.equal(entries[0].transport, 'stdio')
  assert.equal(entries[0].serverName, 'runapi')
  assert.deepEqual(entries[0].args, ['-y', '@runapi.ai/mcp'])
})

test('serverEntries: http url is DIRECT (streamable-http)', () => {
  const entries = serverEntries({ api: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } } })
  assert.equal(entries[0].status, STATUS.DIRECT)
  assert.equal(entries[0].transport, 'http')
  assert.equal(entries[0].url, 'https://api.example.com/mcp')
})

test('serverEntries: url without type defaults to http', () => {
  const entries = serverEntries({ api: { url: 'http://localhost:3000/mcp' } })
  assert.equal(entries[0].transport, 'http')
  assert.equal(entries[0].status, STATUS.DIRECT)
})

test('serverEntries: sse and ws are UNSUPPORTED with reason', () => {
  const entries = serverEntries({
    asana: { type: 'sse', url: 'https://mcp.asana.com/sse' },
    realtime: { type: 'ws', url: 'wss://x/mcp' },
  })
  assert.equal(entries.length, 2)
  for (const e of entries) {
    assert.equal(e.status, STATUS.UNSUPPORTED)
    assert.match(e.reason, /not supported by the DSH MCP client/)
  }
  assert.equal(entries[0].transport, 'sse')
  assert.equal(entries[1].transport, 'ws')
})

test('serverEntries: env placeholders kept verbatim, names recorded', () => {
  const entries = serverEntries({ s: { command: 'x', env: { A: '${API_KEY}', B: 'literal', C: 'pre-${TOKEN}-post' } } })
  assert.equal(entries[0].env.A, '${API_KEY}')
  assert.equal(entries[0].env.B, 'literal')
  assert.equal(entries[0].env.C, 'pre-${TOKEN}-post')
  assert.deepEqual(entries[0].envNames, ['API_KEY', 'TOKEN'])
})

test('serverEntries: invalid server names skipped with warning', () => {
  const warnings = []
  const entries = serverEntries({ 'bad name!': { command: 'x' }, ok: { command: 'y' } }, { warn: (m) => warnings.push(m) })
  assert.deepEqual(entries.map((e) => e.serverName), ['ok'])
  assert.equal(warnings.length, 1)
})

test('serverEntries: command and url both present → skipped', () => {
  const warnings = []
  const entries = serverEntries({ both: { command: 'x', url: 'https://y' } }, { warn: (m) => warnings.push(m) })
  assert.equal(entries.length, 0)
  assert.equal(warnings.length, 1)
})

test('serverEntries: neither command nor url → skipped', () => {
  const warnings = []
  const entries = serverEntries({ empty: { args: [] } }, { warn: (m) => warnings.push(m) })
  assert.equal(entries.length, 0)
})

test('serverEntries: pluginName propagates', () => {
  const entries = serverEntries({ s: { command: 'x' } }, { pluginName: 'my-plugin' })
  assert.equal(entries[0].pluginName, 'my-plugin')
})

// ─── discoverMcpConfig: sources ──────────────────────────────────────────────

test('discoverMcpConfig: project .mcp.json wrapped form', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }))
    const { servers, sources, warnings } = await discoverMcpConfig(t.dir)
    assert.equal(servers.length, 1)
    assert.equal(servers[0].serverName, 'github')
    assert.equal(sources.length, 1)
    assert.equal(warnings.length, 0)
  } finally { t.cleanup() }
})

test('discoverMcpConfig: plugin .mcp.json bare form', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, '.mcp.json'), JSON.stringify({ 'database-tools': { command: 'node', args: ['server.js'] } }))
    const { servers } = await discoverMcpConfig(t.dir, { pluginName: 'db-plugin' })
    assert.equal(servers.length, 1)
    assert.equal(servers[0].serverName, 'database-tools')
    assert.equal(servers[0].pluginName, 'db-plugin')
  } finally { t.cleanup() }
})

test('discoverMcpConfig: plugin.json inline mcpServers', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0', mcpServers: { 'plugin-api': { command: '${CLAUDE_PLUGIN_ROOT}/servers/api-server' } } }))
    const { servers, sources } = await discoverMcpConfig(t.dir, { pluginName: 'p' })
    assert.equal(servers.length, 1)
    assert.equal(servers[0].serverName, 'plugin-api')
    assert.equal(servers[0].command, '${CLAUDE_PLUGIN_ROOT}/servers/api-server')
    assert.ok(sources.some((s) => s.endsWith('plugin.json')))
  } finally { t.cleanup() }
})

test('discoverMcpConfig: includePluginJson=false skips plugin.json', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, 'plugin.json'), JSON.stringify({ mcpServers: { inline: { command: 'x' } } }))
    const { servers } = await discoverMcpConfig(t.dir, { includePluginJson: false })
    assert.equal(servers.length, 0)
  } finally { t.cleanup() }
})

test('discoverProjectMcp: project root .mcp.json only', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, '.mcp.json'), JSON.stringify({ mcpServers: { git: { command: 'npx' } } }))
    writeFileSync(join(t.dir, 'plugin.json'), JSON.stringify({ mcpServers: { inline: { command: 'x' } } }))
    const { servers } = await discoverProjectMcp(t.dir)
    assert.deepEqual(servers.map((s) => s.serverName), ['git'])
  } finally { t.cleanup() }
})

// ─── loadClaude integration ──────────────────────────────────────────────────

test('loadClaude: components.mcp populated from project .mcp.json', async () => {
  const t = tmpTree()
  try {
    mkdirSync(join(t.dir, '.git'))
    writeFileSync(join(t.dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        runapi: { command: 'npx', args: ['-y', '@runapi.ai/mcp'], env: { KEY: '${RUNAPI_API_KEY}' } },
        legacy: { type: 'sse', url: 'https://mcp.example.com/sse' },
      },
    }))
    const ir = await loadClaude({ cwd: t.dir, enableGlobal: false })
    const servers = ir.components.mcp.servers
    assert.equal(servers.length, 2)
    const runapi = servers.find((s) => s.serverName === 'runapi')
    assert.equal(runapi.status, STATUS.DIRECT)
    assert.deepEqual(runapi.envNames, ['RUNAPI_API_KEY'])
    const legacy = servers.find((s) => s.serverName === 'legacy')
    assert.equal(legacy.status, STATUS.UNSUPPORTED)
    assert.ok(ir.report.unsupported.some((u) => u.kind === 'mcp-server' && u.name === 'legacy'))
  } finally { t.cleanup() }
})

test('loadClaude: no .mcp.json → empty mcp component', async () => {
  const t = tmpTree()
  try {
    mkdirSync(join(t.dir, '.git'))
    const ir = await loadClaude({ cwd: t.dir, enableGlobal: false })
    assert.deepEqual(ir.components.mcp.servers, [])
  } finally { t.cleanup() }
})
