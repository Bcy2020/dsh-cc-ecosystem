// Unit tests for dsh-cc-loader LSP discovery placeholder (.lsp.json):
// parsing, UNSUPPORTED classification, missing-command handling, and
// loadClaude IR integration (empty component shape).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverLspConfig } from '../packages/cc-loader/src/lsp.js'
import { loadClaude } from '../packages/cc-loader/src/load.js'
import { STATUS } from '../packages/cc-loader/src/classify.js'

function tmpTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-lsp-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('discoverLspConfig: parses {language → {command, args}} as UNSUPPORTED', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, '.lsp.json'), JSON.stringify({
      typescript: { command: 'typescript-language-server', args: ['--stdio'] },
      go: { command: 'gopls' },
    }))
    const { servers, sources, warnings } = await discoverLspConfig(t.dir)
    assert.equal(servers.length, 2)
    const ts = servers.find((s) => s.language === 'typescript')
    assert.equal(ts.command, 'typescript-language-server')
    assert.deepEqual(ts.args, ['--stdio'])
    assert.equal(ts.status, STATUS.UNSUPPORTED)
    assert.match(ts.reason, /LSP adapter not implemented/)
    const go = servers.find((s) => s.language === 'go')
    assert.equal(go.command, 'gopls')
    assert.deepEqual(go.args, [])
    assert.equal(sources.length, 1)
    assert.equal(warnings.length, 2, 'one advisory warning per language')
  } finally { t.cleanup() }
})

test('discoverLspConfig: extensionToLanguage preserved', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, '.lsp.json'), JSON.stringify({
      typescript: {
        command: 'typescript-language-server',
        extensionToLanguage: { tsx: 'typescript', jsx: 'typescript' },
      },
    }))
    const { servers } = await discoverLspConfig(t.dir)
    assert.deepEqual(servers[0].extensionToLanguage, { tsx: 'typescript', jsx: 'typescript' })
  } finally { t.cleanup() }
})

test('discoverLspConfig: missing command recorded with warning, still listed', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, '.lsp.json'), JSON.stringify({ weird: { args: ['--x'] } }))
    const { servers, warnings } = await discoverLspConfig(t.dir)
    assert.equal(servers.length, 1)
    assert.equal(servers[0].command, undefined)
    assert.equal(servers[0].status, STATUS.UNSUPPORTED)
    assert.ok(warnings.some((w) => w.includes('missing "command"')))
  } finally { t.cleanup() }
})

test('discoverLspConfig: no .lsp.json → empty result', async () => {
  const t = tmpTree()
  try {
    const { servers, sources, warnings } = await discoverLspConfig(t.dir)
    assert.deepEqual(servers, [])
    assert.deepEqual(sources, [])
    assert.deepEqual(warnings, [])
  } finally { t.cleanup() }
})

test('discoverLspConfig: invalid JSON → warning, no throw', async () => {
  const t = tmpTree()
  try {
    writeFileSync(join(t.dir, '.lsp.json'), '{ broken')
    const { servers, warnings } = await discoverLspConfig(t.dir)
    assert.deepEqual(servers, [])
    assert.ok(warnings.some((w) => w.includes('invalid JSON')))
  } finally { t.cleanup() }
})

test('loadClaude: components.lsp exists and is empty (no plugin roots)', async () => {
  const t = tmpTree()
  try {
    mkdirSync(join(t.dir, '.git'))
    writeFileSync(join(t.dir, '.lsp.json'), JSON.stringify({ go: { command: 'gopls' } }))
    const ir = await loadClaude({ cwd: t.dir, enableGlobal: false })
    assert.deepEqual(ir.components.lsp.servers, [])
    assert.deepEqual(ir.components.lsp.sources, [])
    assert.ok(ir.components.lsp, 'lsp component present in IR shape')
  } finally { t.cleanup() }
})
