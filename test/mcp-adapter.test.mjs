// Unit + integration tests for dsh-cc-mcp: public tool naming, entry
// normalization, plugin-root expansion, and a REAL stdio MCP round-trip
// (connectAndList → tool definition → callTool) against test/mcp-echo-server.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { publicToolName, interpolateEnv, connectAndList, mapResult } from '../packages/cc-mcp/src/register.js'
import { toRuntimeEntries, pluginNameOf } from '../packages/cc-mcp/src/index.js'
import { STATUS } from '../packages/cc-loader/src/classify.js'

const ECHO_SERVER = fileURLToPath(new URL('../packages/cc-mcp/test/mcp-echo-server.mjs', import.meta.url))

// ─── publicToolName ──────────────────────────────────────────────────────────

test('publicToolName: project server → mcp__<server>__<tool>', () => {
  assert.equal(publicToolName({ serverName: 'github' }, 'create_issue'), 'mcp__github__create_issue')
})

test('publicToolName: plugin server → mcp__plugin_<name>_<server>__<tool>', () => {
  assert.equal(
    publicToolName({ serverName: 'asana', pluginName: 'asana' }, 'create_task'),
    'mcp__plugin_asana_asana__create_task',
  )
})

test('publicToolName: official CC example shape', () => {
  // SKILL.md: plugin=asana, server=asana, tool=asana_create_task → mcp__plugin_asana_asana__asana_create_task
  assert.equal(
    publicToolName({ serverName: 'asana', pluginName: 'asana' }, 'asana_create_task'),
    'mcp__plugin_asana_asana__asana_create_task',
  )
})

test('publicToolName: illegal chars → underscore + deterministic hash', () => {
  const name = publicToolName({ serverName: 'a b' }, 'x.y')
  assert.ok(name.startsWith('mcp__a_b__x_y_'))
  assert.match(name, /_[0-9a-f]{12}$/)
  // deterministic: same inputs → same name
  assert.equal(publicToolName({ serverName: 'a b' }, 'x.y'), name)
})

test('publicToolName: overlong name gets hash suffix', () => {
  const long = 'm'.repeat(80)
  const name = publicToolName({ serverName: 'github' }, long)
  assert.ok(name.length <= 64)
  assert.ok(name.startsWith('mcp__github__'))
  assert.match(name, /_[0-9a-f]{12}$/)
})

// ─── interpolateEnv / expandPluginRoot ───────────────────────────────────────

test('interpolateEnv: resolves from process.env, leaves missing verbatim', () => {
  const before = process.env.CC_MCP_TEST_VAR
  process.env.CC_MCP_TEST_VAR = 'hello'
  try {
    const warnings = []
    assert.equal(interpolateEnv('${CC_MCP_TEST_VAR}-x', (m) => warnings.push(m)), 'hello-x')
    assert.equal(interpolateEnv('${CC_MCP_MISSING_VAR_XYZ}', (m) => warnings.push(m)), '${CC_MCP_MISSING_VAR_XYZ}')
    assert.equal(warnings.length, 1)
  } finally {
    if (before === undefined) delete process.env.CC_MCP_TEST_VAR
    else process.env.CC_MCP_TEST_VAR = before
  }
})

// ─── toRuntimeEntries / pluginNameOf ─────────────────────────────────────────

test('toRuntimeEntries: drops UNSUPPORTED, fills defaults', () => {
  const loaderEntries = [
    { serverName: 'ok', transport: 'stdio', command: 'npx', status: STATUS.DIRECT, envNames: [] },
    { serverName: 'legacy', transport: 'sse', url: 'https://x', status: STATUS.UNSUPPORTED, reason: 'nope', envNames: [] },
  ]
  const entries = toRuntimeEntries(loaderEntries, { idleTimeoutMs: 1000, toolCallTimeoutMs: 2000 })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].serverName, 'ok')
  assert.equal(entries[0].idleTimeoutMs, 1000)
  assert.equal(entries[0].toolCallTimeoutMs, 2000)
})

test('toRuntimeEntries: expands ${CLAUDE_PLUGIN_ROOT} in command/args/cwd', () => {
  const loaderEntries = [{
    serverName: 'custom',
    transport: 'stdio',
    command: '${CLAUDE_PLUGIN_ROOT}/servers/db-server',
    args: ['--config', '${CLAUDE_PLUGIN_ROOT}/config.json'],
    cwd: '${CLAUDE_PLUGIN_ROOT}',
    status: STATUS.DIRECT,
    envNames: [],
  }]
  const [entry] = toRuntimeEntries(loaderEntries, { pluginRoot: 'C:/plugins/db' })
  assert.equal(entry.command, 'C:/plugins/db/servers/db-server')
  assert.deepEqual(entry.args, ['--config', 'C:/plugins/db/config.json'])
  assert.equal(entry.cwd, 'C:/plugins/db')
})

test('pluginNameOf: dir basename, sanitized', () => {
  assert.equal(pluginNameOf('C:/plugins/asana'), 'asana')
  assert.equal(pluginNameOf('C:/plugins/my-plugin'), 'my-plugin')
  assert.equal(pluginNameOf('C:/plugins/weird name!'), 'weird_name_')
})

// ─── real MCP round-trip (stdio echo server) ─────────────────────────────────

test('connectAndList: real stdio MCP server lists tools', async () => {
  const entry = {
    transport: 'stdio',
    serverName: 'echo',
    command: process.execPath,
    args: [ECHO_SERVER],
    env: {},
    toolCallTimeoutMs: 10000,
    idleTimeoutMs: 10000,
  }
  const { client, tools, closed } = await connectAndList(entry, dirname(ECHO_SERVER))
  try {
    assert.equal(closed, false)
    assert.ok(tools.length >= 1)
    const echo = tools.find((t) => t.name === 'echo')
    assert.ok(echo, 'echo tool listed')
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } })
    const mapped = mapResult(result)
    assert.equal(mapped.content[0].text, 'echo: hi')
  } finally {
    await client.close()
  }
})

// ─── full flow: serverEntries → toRuntimeEntries → connect (project scope) ───

test('integration: loader entries feed the adapter end-to-end', async () => {
  const { serverEntries } = await import('../packages/cc-loader/src/mcp.js')
  const raw = await import('../packages/cc-loader/src/mcp.js')
  const entries = raw.serverEntries({
    echo: {
      command: process.execPath,
      args: [ECHO_SERVER],
    },
  })
  const [runtime] = toRuntimeEntries(entries, { idleTimeoutMs: 10000, toolCallTimeoutMs: 10000 })
  const { client, tools } = await connectAndList(runtime, dirname(ECHO_SERVER))
  try {
    assert.ok(tools.some((t) => t.name === 'echo'))
  } finally {
    await client.close()
  }
})

// ─── plugin namespace: full chain discovery → normalize → public name ───────

test('plugin MCP: discoverMcpConfig → toRuntimeEntries → mcp__plugin_<name>_<server>__<tool>', async () => {
  const { discoverMcpConfig } = await import('../packages/cc-loader/src/mcp.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const pluginDir = mkdtempSync(join(tmpdir(), 'cc-plug-'))
  try {
    writeFileSync(join(pluginDir, '.mcp.json'), JSON.stringify({
      mcpServers: { 'cc-echo': { command: process.execPath, args: [ECHO_SERVER] } },
    }))
    const found = await discoverMcpConfig(pluginDir, { pluginName: 'echo-mcp' })
    assert.equal(found.servers.length, 1)
    const [runtime] = toRuntimeEntries(found.servers, { pluginRoot: pluginDir, idleTimeoutMs: 10000, toolCallTimeoutMs: 10000 })
    // CC official naming: mcp__plugin_<plugin>_<server>__<tool>
    assert.equal(
      publicToolName({ serverName: runtime.serverName, pluginName: runtime.pluginName }, 'echo'),
      'mcp__plugin_echo-mcp_cc-echo__echo',
    )
    // Real connect through the plugin-scoped entry
    const { client } = await connectAndList(runtime, pluginDir)
    try {
      const result = await client.callTool({ name: 'echo', arguments: { text: 'plugin-ok' } })
      assert.equal(mapResult(result).content[0].text, 'echo: plugin-ok')
    } finally {
      await client.close()
    }
  } finally { rmSync(pluginDir, { recursive: true, force: true }) }
})
