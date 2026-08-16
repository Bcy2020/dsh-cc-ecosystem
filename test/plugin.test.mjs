// Unit tests for dsh-cc-loader M4: plugin manifest + marketplace parsing,
// plugin-root discovery, and loadClaude plugin wiring.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePluginManifest, parseMarketplace, normalizePluginSource,
  discoverPluginRoot, discoverMarketplace, pluginComponentName,
  RESERVED_MARKETPLACE_NAMES,
} from '../packages/cc-loader/src/plugin.js'
import { loadClaude } from '../packages/cc-loader/src/load.js'
import { STATUS } from '../packages/cc-loader/src/classify.js'

function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-plugin-test-'))
  return {
    dir,
    write(rel, content) {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

// ─── parsePluginManifest ─────────────────────────────────────────────────────

test('parsePluginManifest: minimal (name only)', () => {
  const r = parsePluginManifest('{ "name": "my-first-plugin" }')
  assert.equal(r.manifest.name, 'my-first-plugin')
  assert.equal(r.unrecognized.length, 0)
  assert.equal(r.warnings.length, 0)
})

test('parsePluginManifest: full metadata + component paths', () => {
  const r = parsePluginManifest(JSON.stringify({
    name: 'plugin-dev',
    displayName: 'Plugin Dev',
    version: '1.2.0',
    description: 'dev tools',
    author: { name: 'Dev', email: 'dev@example.com', url: 'https://example.com' },
    homepage: 'https://example.com',
    repository: 'https://github.com/dev/plugin',
    license: 'MIT',
    keywords: ['dev', 'ci'],
    defaultEnabled: false,
    skills: ['./custom/skills/'],
    commands: ['./cmd1.md'],
    agents: ['./custom/agents/reviewer.md'],
    mcpServers: './mcp-config.json',
    lspServers: './.lsp.json',
    hooks: './config/hooks.json',
    outputStyles: './styles/',
    workflows: './workflows/',
    experimental: { themes: './themes/', monitors: './monitors.json' },
  }))
  const m = r.manifest
  assert.equal(m.name, 'plugin-dev')
  assert.equal(m.displayName, 'Plugin Dev')
  assert.equal(m.version, '1.2.0')
  assert.deepEqual(m.author, { name: 'Dev', email: 'dev@example.com', url: 'https://example.com' })
  assert.equal(m.defaultEnabled, false)
  assert.deepEqual(r.paths.skills, ['./custom/skills/'])
  assert.deepEqual(r.paths.commands, ['./cmd1.md'])
  assert.deepEqual(r.paths.agents, ['./custom/agents/reviewer.md'])
  assert.deepEqual(r.paths.mcpServers, ['./mcp-config.json'])
  assert.deepEqual(r.paths.lspServers, ['./.lsp.json'])
  assert.deepEqual(r.paths.hooks, ['./config/hooks.json'])
  assert.deepEqual(r.paths.outputStyles, ['./styles/'])
  assert.deepEqual(r.paths.workflows, ['./workflows/'])
  assert.deepEqual(r.paths.themes, ['./themes/'])
  assert.deepEqual(r.paths.monitors, ['./monitors.json'])
})

test('parsePluginManifest: field classification', () => {
  const r = parsePluginManifest(JSON.stringify({
    name: 'x', skills: './s/', commands: './c/', agents: './a/',
    hooks: './h.json', mcpServers: './m.json', lspServers: './l.json',
    workflows: './w/', outputStyles: './o/',
    experimental: { themes: './t/' },
    userConfig: { api_token: { type: 'string' } },
    channels: [{ server: 'telegram' }],
    dependencies: ['helper-lib'],
  }))
  const byField = Object.fromEntries(r.classification.map((c) => [c.field, c]))
  for (const f of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers']) {
    assert.equal(byField[f]?.status, STATUS.DIRECT, `${f} should be DIRECT`)
  }
  for (const f of ['workflows', 'outputStyles']) {
    assert.equal(byField[f]?.status, STATUS.UNSUPPORTED, `${f} should be UNSUPPORTED`)
  }
  assert.equal(byField.experimental.status, STATUS.UNSUPPORTED)
  assert.equal(byField.userConfig.status, STATUS.ADAPTED)
  assert.equal(byField.channels.status, STATUS.UNSUPPORTED)
  assert.equal(byField.dependencies.status, STATUS.ADAPTED)
})

test('parsePluginManifest: unrecognized field warns (CC validate behavior)', () => {
  const r = parsePluginManifest('{ "name": "x", "unknownField": 1, "packageManager": "npm" }')
  assert.deepEqual(r.unrecognized.sort(), ['packageManager', 'unknownField'])
  assert.equal(r.warnings.length, 2)
})

test('parsePluginManifest: missing name warns; invalid JSON reports', () => {
  const noName = parsePluginManifest('{ "version": "1.0.0" }')
  assert.deepEqual(noName.manifest, { version: '1.0.0' }) // preserved, name absent
  assert.ok(noName.warnings.some((w) => w.includes('"name" is required')))
  const badJson = parsePluginManifest('{ nope')
  assert.equal(badJson.manifest, undefined)
  assert.ok(badJson.warnings.some((w) => w.includes('invalid JSON')))
})

test('parsePluginManifest: non-kebab-case name warns but keeps value', () => {
  const r = parsePluginManifest('{ "name": "My Plugin!" }')
  assert.equal(r.manifest.name, 'My Plugin!')
  assert.ok(r.warnings.some((w) => w.includes('not kebab-case')))
})

// ─── parseMarketplace ────────────────────────────────────────────────────────

test('parseMarketplace: local source DIRECT, remote UNSUPPORTED', () => {
  const r = parseMarketplace(JSON.stringify({
    name: 'acme-tools',
    owner: { name: 'Acme', email: 'a@acme.com', url: 'https://acme.com' },
    description: 'Acme plugin catalog',
    metadata: { pluginRoot: './plugins' },
    plugins: [
      { name: 'local-one', source: './local-one', description: 'local' },
      { name: 'git-one', source: { source: 'github', repo: 'acme/git-one', ref: 'v1' } },
      { name: 'npm-one', source: { source: 'npm', package: 'npm-one' } },
      { name: 'bad-one', source: { source: 'ftp' } },
      { name: 'bad-two', source: 'no-leading-dot' },
    ],
  }))
  const mp = r.marketplace
  assert.equal(mp.name, 'acme-tools')
  assert.equal(mp.pluginRoot, './plugins')
  assert.deepEqual(mp.owner, { name: 'Acme', email: 'a@acme.com', url: 'https://acme.com' })
  const byName = Object.fromEntries(r.plugins.map((p) => [p.name, p]))
  assert.equal(byName['local-one'].status, STATUS.DIRECT)
  assert.equal(byName['local-one'].source.kind, 'local')
  assert.equal(byName['git-one'].status, STATUS.UNSUPPORTED)
  assert.equal(byName['git-one'].source.kind, 'github')
  assert.equal(byName['npm-one'].status, STATUS.UNSUPPORTED)
  assert.equal(byName['bad-one'].status, STATUS.UNSUPPORTED)
  assert.equal(byName['bad-two'].status, STATUS.UNSUPPORTED)
  assert.ok(byName['git-one'].reason.includes('remote fetch'))
})

test('parseMarketplace: reserved name warns', () => {
  assert.ok(RESERVED_MARKETPLACE_NAMES.has('anthropic-marketplace'))
  const r = parseMarketplace(JSON.stringify({
    name: 'anthropic-marketplace',
    owner: { name: 'x' },
    plugins: [],
  }))
  assert.ok(r.warnings.some((w) => w.includes('reserved')))
})

test('normalizePluginSource: shapes', () => {
  assert.equal(normalizePluginSource('./p').kind, 'local')
  assert.equal(normalizePluginSource('C:\\p').kind, 'local')
  assert.equal(normalizePluginSource('/abs/p').kind, 'local')
  assert.equal(normalizePluginSource({ source: 'git-subdir', url: 'x', path: 'y' }).kind, 'git-subdir')
  assert.equal(normalizePluginSource({ source: 'archive', url: 'x' }).kind, 'archive')
  assert.equal(normalizePluginSource({ source: 'command', command: 'make' }).kind, 'command')
  assert.equal(normalizePluginSource({ source: 'weird' }).kind, 'invalid')
  assert.equal(normalizePluginSource(42).kind, 'invalid')
})

test('pluginComponentName: DSH-safe plugin-<plugin>-<name> kebab', () => {
  assert.equal(pluginComponentName('superpowers', 'brainstorming'), 'plugin-superpowers-brainstorming')
  assert.equal(pluginComponentName('my-plugin', 'tdd'), 'plugin-my-plugin-tdd')
  // Names with illegal chars are sanitized to single-hyphen kebab (DSH
  // grammar rejects double hyphens and non-alphanumerics).
  assert.equal(pluginComponentName('My Plugin!', 'status'), 'plugin-my-plugin-status')
  assert.equal(pluginComponentName('a--b', 'x'), 'plugin-a-b-x')
  assert.equal(pluginComponentName('', 'x'), 'plugin-x')
  // Result must satisfy DSH's skill-name grammar.
  const dsh = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  assert.ok(dsh.test(pluginComponentName('superpowers', 'brainstorming')))
  assert.ok(dsh.test(pluginComponentName('Weird_Name!!', 'c-1')))
})

// ─── discoverPluginRoot ──────────────────────────────────────────────────────

test('discoverPluginRoot: full plugin tree', async () => {
  const t = tempTree()
  try {
    t.write('.claude-plugin/plugin.json', JSON.stringify({
      name: 'demo-plugin', version: '1.0.0', description: 'demo',
    }))
    t.write('skills/greet/SKILL.md', '---\nname: greet\ndescription: greeting\n---\nSay hi')
    t.write('commands/status.md', '---\ndescription: status\n---\nStatus report')
    t.write('agents/reviewer.md', '---\nname: reviewer\ndescription: reviews code\n---\nReview the diff')
    t.write('.mcp.json', JSON.stringify({ 'cc-echo': { command: 'node', args: ['server.mjs'] } }))
    t.write('.lsp.json', JSON.stringify({ typescript: { command: 'ts-ls', args: ['--stdio'] } }))
    t.write('hooks/hooks.json', JSON.stringify({ hooks: [] }))

    const plugin = await discoverPluginRoot(t.dir)
    assert.equal(plugin.name, 'demo-plugin')
    assert.equal(plugin.manifest.version, '1.0.0')
    assert.equal(plugin.components.skills.length, 1)
    assert.equal(plugin.components.skills[0].name, 'greet')
    assert.equal(plugin.components.skills[0].plugin, 'demo-plugin')
    assert.equal(plugin.components.commands.length, 1)
    assert.equal(plugin.components.commands[0].name, 'status')
    assert.equal(plugin.components.agents.length, 1)
    assert.equal(plugin.components.agents[0].name, 'reviewer')
    assert.equal(plugin.components.mcp.servers.length, 1)
    assert.equal(plugin.components.mcp.servers[0].serverName, 'cc-echo')
    assert.equal(plugin.components.mcp.servers[0].pluginName, 'demo-plugin')
    assert.equal(plugin.components.lsp.servers.length, 1)
    assert.equal(plugin.components.lsp.servers[0].language, 'typescript')
    assert.equal(plugin.components.lsp.servers[0].status, STATUS.UNSUPPORTED)
    assert.equal(plugin.components.hooks.paths.length, 1)
  } finally {
    t.cleanup()
  }
})

test('discoverPluginRoot: manifest commands REPLACES default dir', async () => {
  const t = tempTree()
  try {
    t.write('.claude-plugin/plugin.json', JSON.stringify({
      name: 'replacer', commands: ['./custom/c.md'],
    }))
    t.write('commands/ignored.md', '---\ndescription: ignored\n---\nx')
    t.write('custom/c.md', '---\ndescription: custom\n---\ny')
    const plugin = await discoverPluginRoot(t.dir)
    assert.equal(plugin.components.commands.length, 1)
    assert.equal(plugin.components.commands[0].name, 'c')
  } finally {
    t.cleanup()
  }
})

test('discoverPluginRoot: root SKILL.md single-skill plugin', async () => {
  const t = tempTree()
  try {
    t.write('.claude-plugin/plugin.json', JSON.stringify({ name: 'one-skill' }))
    t.write('SKILL.md', '---\nname: single\ndescription: one\n---\nx')
    const plugin = await discoverPluginRoot(t.dir)
    assert.equal(plugin.components.skills.length, 1)
    assert.equal(plugin.components.skills[0].name, 'single')
  } finally {
    t.cleanup()
  }
})

test('discoverPluginRoot: manifest mcpServers path + inline config', async () => {
  const t = tempTree()
  try {
    t.write('.claude-plugin/plugin.json', JSON.stringify({
      name: 'mcp-plugin',
      mcpServers: ['./extra-mcp.json', { 'inline-server': { command: 'node', args: ['in.js'] } }],
    }))
    t.write('extra-mcp.json', JSON.stringify({ mcpServers: { extra: { command: 'node', args: ['e.js'] } } }))
    const plugin = await discoverPluginRoot(t.dir)
    const names = plugin.components.mcp.servers.map((s) => s.serverName)
    assert.deepEqual(names.sort(), ['extra', 'inline-server'])
    assert.equal(plugin.components.mcp.servers[0].pluginName, 'mcp-plugin')
  } finally {
    t.cleanup()
  }
})

test('discoverPluginRoot: name falls back to directory basename', async () => {
  const t = tempTree()
  try {
    t.write('skills/a/SKILL.md', '---\nname: a\ndescription: a\n---\nx')
    const plugin = await discoverPluginRoot(t.dir)
    assert.equal(plugin.name, t.dir.split(/[\\/]/).pop())
    assert.equal(plugin.manifest, undefined)
  } finally {
    t.cleanup()
  }
})

test('discoverPluginRoot: unsupported component paths inventoried', async () => {
  const t = tempTree()
  try {
    t.write('.claude-plugin/plugin.json', JSON.stringify({
      name: 'misc-plugin', workflows: './workflows/', outputStyles: './styles/',
    }))
    t.write('workflows/release.js', 'export default {}')
    t.write('styles/terse.md', '# terse')
    const plugin = await discoverPluginRoot(t.dir)
    assert.equal(plugin.components.unsupported.length, 2)
    assert.ok(plugin.components.unsupported.every((u) => u.status === STATUS.UNSUPPORTED))
  } finally {
    t.cleanup()
  }
})

// ─── discoverMarketplace ─────────────────────────────────────────────────────

test('discoverMarketplace: resolves local plugin dirs', async () => {
  const t = tempTree()
  try {
    t.write('.claude-plugin/marketplace.json', JSON.stringify({
      name: 'local-mp', owner: { name: 'x' },
      metadata: { pluginRoot: './plugins' },
      plugins: [
        { name: 'p1', source: './p1' },
        { name: 'p2', source: { source: 'github', repo: 'x/p2' } },
      ],
    }))
    t.write('plugins/p1/.claude-plugin/plugin.json', JSON.stringify({ name: 'p1' }))
    const mp = await discoverMarketplace(t.dir)
    assert.equal(mp.marketplace.name, 'local-mp')
    const p1 = mp.plugins.find((p) => p.name === 'p1')
    assert.equal(p1.status, STATUS.DIRECT)
    assert.equal(p1.dir, join(t.dir, 'plugins', 'p1'))
    const p2 = mp.plugins.find((p) => p.name === 'p2')
    assert.equal(p2.status, STATUS.UNSUPPORTED)
    assert.equal(p2.dir, undefined)
  } finally {
    t.cleanup()
  }
})

test('discoverMarketplace: missing file returns empty', async () => {
  const t = tempTree()
  try {
    const mp = await discoverMarketplace(t.dir)
    assert.equal(mp.marketplace, undefined)
    assert.equal(mp.plugins.length, 0)
  } finally {
    t.cleanup()
  }
})

// ─── loadClaude wiring ───────────────────────────────────────────────────────

test('loadClaude: pluginRoots + marketplaceRoots populate components + report', async () => {
  const t = tempTree()
  try {
    t.write('.git/config', '[core]\n')
    t.write('.claude-plugin/plugin.json', JSON.stringify({ name: 'bp', version: '2.0.0' }))
    t.write('skills/tool/SKILL.md', '---\nname: tool\ndescription: t\n---\nx')
    t.write('.mcp.json', JSON.stringify({ srv: { command: 'node', args: ['s.mjs'] } }))
    const mpRoot = join(t.dir, 'marketplace')
    t.write('marketplace/.claude-plugin/marketplace.json', JSON.stringify({
      name: 'mp', owner: { name: 'o' }, plugins: [
        { name: 'lp', source: './lp' },
        { name: 'rp', source: { source: 'npm', package: 'rp' } },
      ],
    }))

    const ir = await loadClaude({ cwd: t.dir, enableGlobal: false, pluginRoots: [t.dir], marketplaceRoots: [mpRoot] })
    assert.equal(ir.components.plugins.length, 1)
    const plugin = ir.components.plugins[0]
    assert.equal(plugin.name, 'bp')
    assert.equal(plugin.components.skills.length, 1)
    assert.equal(plugin.components.mcp.servers.length, 1)
    // Plugin components stay namespaced — NOT merged into top-level.
    assert.equal(ir.components.skills.length, 0)
    assert.equal(ir.components.marketplaces.length, 1)
    const mp = ir.components.marketplaces[0]
    assert.equal(mp.marketplace.name, 'mp')
    assert.equal(mp.plugins.length, 2)

    // Report counts the plugin, marketplace and the remote entry.
    assert.equal(ir.report.direct >= 2, true)
    const mpUnsupported = ir.report.unsupported.filter((u) => u.kind === 'marketplace-plugin')
    assert.equal(mpUnsupported.length, 1)
    assert.equal(mpUnsupported[0].name, 'rp')
  } finally {
    t.cleanup()
  }
})
