/**
 * Structural contract of the dsh-cc-mcp classic-script client bundle.
 *
 * The bundle is a plain `<script async src>` artifact executed inside DSH's
 * lazy-CJS module table: it must register exactly one module, must not require
 * anything, must export `{ name, inject: [], apply }`, and `apply` must survive
 * an environment with no DOM (a throw there fails the whole GUI page boot).
 *
 * No jsdom: a bare fake `window` is installed before the bundle is imported,
 * which is all the loader handshake needs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One registration captured from the bundle's single top-level statement. */
const registrations = []

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

// Classic script, but valid module-free JS: importing it runs the loader call.
await import(new URL('../client/index.js', import.meta.url).href)

test('registers exactly one lazy-CJS module under the package id', () => {
  assert.equal(registrations.length, 1)
  const captured = registrations[0]
  assert.equal(captured.id, 'dsh-cc-mcp')
  assert.equal(typeof captured.factory, 'function')
})

test('the factory needs no requires and exports the plugin shape', () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  assert.ok(exports && typeof exports === 'object')
  assert.equal(exports.name, 'dsh-cc-mcp-client')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, [])
})

test('apply does not throw without a document', () => {
  assert.equal(typeof document, 'undefined')
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      return disposer
    },
    inject: () => {},
    get: () => undefined,
    on: () => {},
    logger: console,
  }
  assert.doesNotThrow(() => { exports.apply(ctx) })
})

test('the deferred injection registers the command decoration and session watch', () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const injected = []
  const ctx = {
    effect: (fn) => fn(),
    inject: (deps, callback) => {
      injected.push(deps.slice())
      callback({
        effect: (fn) => fn(),
        get: () => undefined,
        commandUi: { decorate: () => () => {} },
        sessions: undefined,
      })
    },
    on: () => {},
    logger: console,
  }
  exports.apply(ctx)

  assert.deepEqual(
    injected.map(deps => deps[0]).sort(),
    ['commandUi', 'sessions'],
    'the panel needs no host service beyond the command UI and the session list',
  )
})

test('every call POSTs the plugin route and unwraps the result envelope', async () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const requests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, value: { plugin: 'dsh-cc-mcp' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const result = await exports.api('ping', {})
    assert.deepEqual(result, { ok: true, value: { plugin: 'dsh-cc-mcp' } })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/cc-mcp/ping')
    assert.equal(requests[0].init.method, 'POST')
    assert.equal(requests[0].init.headers['x-cc-mcp'], '1')
    assert.equal(requests[0].init.body, '{}')
    assert.equal(requests[0].init.credentials, 'same-origin')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('with no fetch at all every call resolves to a {ok:false} envelope', async () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const previousFetch = globalThis.fetch
  delete globalThis.fetch
  try {
    const state = await exports.api('state', { sessionId: 's1' })
    assert.equal(state.ok, false)
    assert.equal(state.error.code, 'cc-mcp/no-transport')

    const check = await exports.api('check', { sessionId: 's1' })
    assert.equal(check.ok, false)
    assert.equal(check.error.code, 'cc-mcp/no-transport')
    assert.ok(Array.isArray(Object.keys(check.error.details)))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a rejected request and a malformed body both stay inside the envelope contract', async () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('socket closed') }
    const rejected = await exports.api('connect', { sessionId: 's1', key: 'project:x' })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'cc-mcp/transport')
    assert.match(rejected.error.message, /socket closed/)

    globalThis.fetch = async () => new Response('not json', { status: 200 })
    const malformed = await exports.api('disable', { sessionId: 's1', key: 'project:x', disabled: true })
    assert.equal(malformed.ok, false)
    assert.equal(malformed.error.code, 'cc-mcp/envelope')

    // A host-side business failure keeps its own code and message.
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'cc-mcp/unknown-server', message: 'unknown server', details: {} },
    }), { status: 200 })
    const business = await exports.api('connect', { sessionId: 's1', key: 'project:nope' })
    assert.equal(business.ok, false)
    assert.equal(business.error.code, 'cc-mcp/unknown-server')
    assert.equal(business.error.message, 'unknown server')
  } finally {
    globalThis.fetch = previousFetch
  }
})

// ─── packaging contract (the rules DSH's client-module scanner applies) ──────
//
// `packages/client/modules/src/index.ts` (DSH 0.1.5-rc.2) drops a Loader entry
// unless: the nearest package.json above the resolved module is named the same
// as the entry, that manifest declares `dsh.client.platform === 'web'`, and
// `exports["./client"]` resolves to a bundle file that exists. These assertions
// mirror that scan so a broken declaration can never reach a live host (where a
// missing bundle fails the whole GUI boot).

const packageRoot = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const bundlePath = fileURLToPath(new URL('client/index.js', packageRoot))
const bundleSource = readFileSync(bundlePath, 'utf8')

test('package.json declares a web client half the scanner can resolve', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  for (const field of ['inject', 'external']) {
    const value = manifest.dsh.client[field]
    assert.ok(value === undefined || (Array.isArray(value) && value.every(entry => typeof entry === 'string')),
      `dsh.client.${field} is a string array when present`)
  }
  const clientExport = manifest.exports?.['./client']
  const relative = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof relative, 'string', 'exports["./client"] is a path or { default: path }')
  assert.equal(resolve(dirname(fileURLToPath(new URL('package.json', packageRoot))), relative), resolve(bundlePath))
  assert.ok(existsSync(bundlePath), 'the declared client bundle exists on disk')
})

test('the bundle is shipped and keeps the one-statement classic-script shape', () => {
  assert.ok(manifest.files?.includes('client'), 'npm publish must ship the client directory')
  const lines = bundleSource.split(/\r?\n/).filter(line => line.trim() !== '')
  assert.ok(lines[0].startsWith('window.__ModuleLoader__.load({ id: "dsh-cc-mcp"'), `unexpected banner: ${lines[0]}`)
  assert.match(lines[lines.length - 1], /^\}\s*\}\);$/, 'the factory closes on the last line')
  assert.equal(/\brequire\(/.test(bundleSource), false, 'a plugin bundle must not require anything')
  assert.equal(bundleSource.includes('import.meta'), false, 'import.meta is a syntax error in a classic script')
  assert.equal(/^\s*(import|export)\s/m.test(bundleSource), false, 'no ESM statements at any level')
})

