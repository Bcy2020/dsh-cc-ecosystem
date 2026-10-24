// Host route: state/set, caller-header defence, and error envelopes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRuntime } from '../src/runtime.js'
import { createRouteHandler } from '../src/route.js'

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-route-'))
  const memoryDirectory = join(root, 'memory')
  mkdirSync(memoryDirectory, { recursive: true })
  writeFileSync(join(memoryDirectory, 'MEMORY.md'), '- [A](a.md) — a\n')

  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    systemPrompt: { section() { return () => {} } },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => { if (tools.get(definition.name) === definition) tools.delete(definition.name) }
      },
    },
  }
  const runtime = new MemoryRuntime(ctx, {
    homeDir: root,
    globalClaudeDir: join(root, 'claude'),
    statePath: join(root, 'state.json'),
    memoryDirectory,
    enabled: true,
    mode: 'read-only',
  })
  runtime.start()
  const handler = createRouteHandler({
    runtime,
    resolveCwd: (sessionId) => (sessionId === 's1' ? root : undefined),
    log: () => {},
  })
  return {
    root,
    memoryDirectory,
    runtime,
    tools,
    handle: (options) => call(handler, options),
    cleanup: () => { runtime.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

function request({ method = 'POST', url = '/cc-memory/state', headers = {}, body } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}

function response() {
  const state = { status: 0, headers: null, text: '' }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(text) { state.text = text === undefined ? '' : String(text) },
    json() { return JSON.parse(state.text) },
  }
}

async function call(handler, options) {
  const res = response()
  await handler(request(options), res)
  return res
}

const CALLER = { 'x-cc-memory': '1', 'content-type': 'application/json' }

test('state returns both switches, the tool list and the resolved memory dir', async () => {
  const h = harness()
  try {
    const res = await h.handle({ headers: CALLER, body: { sessionId: 's1' } })
    assert.equal(res.state.status, 200)
    const payload = res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.value.enabled, true)
    assert.equal(payload.value.mode, 'read-only')
    assert.deepEqual(payload.value.tools, ['cc_memory_list', 'cc_memory_read'])
    assert.equal(payload.value.memoryDirectory, h.memoryDirectory)
    assert.equal(payload.value.statePath, join(h.root, 'state.json'))
  } finally { h.cleanup() }
})

test('set flips enabled and unregisters the tools immediately', async () => {
  const h = harness()
  try {
    const res = await h.handle({ url: '/cc-memory/set', headers: CALLER, body: { sessionId: 's1', enabled: false } })
    assert.equal(res.state.status, 200)
    assert.equal(res.json().value.enabled, false)
    assert.deepEqual(res.json().value.tools, [])
    assert.equal(h.tools.size, 0)

    const again = await h.handle({ url: '/cc-memory/set', headers: CALLER, body: { sessionId: 's1', enabled: true, mode: 'read-write' } })
    assert.equal(again.json().value.mode, 'read-write')
    assert.equal(h.tools.size, 4)
  } finally { h.cleanup() }
})

test('a POST without the plugin header is refused', async () => {
  const h = harness()
  try {
    const res = await h.handle({ body: { enabled: false } })
    assert.equal(res.state.status, 403)
    assert.equal(res.json().error.code, 'cc-memory/untrusted-origin')
    assert.equal(h.runtime.enabled, true)
  } finally { h.cleanup() }
})

test('an invalid mode is a 400 and changes nothing', async () => {
  const h = harness()
  try {
    const res = await h.handle({ url: '/cc-memory/set', headers: CALLER, body: { mode: 'write' } })
    assert.equal(res.state.status, 200)
    assert.equal(res.json().ok, false)
    assert.equal(res.json().error.code, 'cc-memory/bad-request')
    assert.equal(h.runtime.mode, 'read-only')
  } finally { h.cleanup() }
})

test('unknown endpoints are 404', async () => {
  const h = harness()
  try {
    const res = await h.handle({ url: '/cc-memory/nope', headers: CALLER, body: {} })
    assert.equal(res.state.status, 404)
    assert.equal(res.json().error.code, 'cc-memory/unknown-endpoint')
  } finally { h.cleanup() }
})

test('without a session cwd the configured override is still shown', async () => {
  const h = harness()
  try {
    const res = await h.handle({ headers: CALLER, body: { sessionId: 'unknown' } })
    assert.equal(res.state.status, 200)
    assert.equal(res.json().value.memoryDirectory, h.memoryDirectory)
  } finally { h.cleanup() }
})
