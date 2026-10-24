// Structural contract of the dsh-cc-memory classic-script client bundle.
//
// The bundle is a plain `<script async src>` artifact executed inside DSH's
// lazy-CJS module table: it must register exactly one module, must not require
// anything, must export `{ name, inject: [], apply }`, and `apply` must survive
// an environment with no DOM (a throw there fails the whole GUI page boot).
//
// No jsdom: a bare fake `window` is installed before the bundle is imported,
// which is all the loader handshake needs.

import assert from 'node:assert/strict'
import test from 'node:test'

const registrations = []

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

await import(new URL('../client/index.js', import.meta.url).href)

test('registers exactly one lazy-CJS module under the package id', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-cc-memory')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('the factory needs no requires and exports the plugin shape', () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  assert.equal(exports.name, 'dsh-cc-memory-client')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.api, 'function')
  assert.deepEqual(exports.inject, [])
})

test('apply does not throw without a document', () => {
  assert.equal(typeof document, 'undefined')
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const ctx = {
    effect: (fn) => fn(),
    inject: () => {},
    logger: console,
  }
  assert.doesNotThrow(() => { exports.apply(ctx) })
})

test('the deferred injection registers /cc-memory as an action command', () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const contributions = []
  const ctx = {
    effect: (fn) => fn(),
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['commandUi'])
      callback({
        effect: (fn) => fn(),
        commandUi: {
          register(contribution) {
            contributions.push(contribution)
            return () => {}
          },
        },
      })
    },
    logger: console,
  }
  exports.apply(ctx)
  assert.equal(contributions.length, 1)
  const command = contributions[0]
  assert.equal(command.name, 'cc-memory')
  assert.equal(typeof command.description(), 'string')
  assert.equal(command.available({ sessionId: 's1' }), true)
  assert.equal(command.ui.kind, 'action')
  assert.equal(typeof command.ui.run, 'function')
  assert.doesNotThrow(() => command.ui.run({ sessionId: 's1' })) // no DOM: openPanel is a no-op
})

test('every call POSTs the plugin route with the caller header', async () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const requests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, value: { enabled: true, mode: 'read-only' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const result = await exports.api('state', { sessionId: 's1' })
    assert.deepEqual(result, { ok: true, value: { enabled: true, mode: 'read-only' } })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/cc-memory/state')
    assert.equal(requests[0].init.method, 'POST')
    assert.equal(requests[0].init.headers['x-cc-memory'], '1')
    assert.equal(requests[0].init.body, JSON.stringify({ sessionId: 's1' }))
    assert.equal(requests[0].init.credentials, 'same-origin')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a failure envelope is unwrapped, not thrown', async () => {
  const exports = registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: { code: 'cc-memory/untrusted-origin', message: 'refused', details: {} },
  }), { status: 403, headers: { 'content-type': 'application/json' } })
  try {
    const result = await exports.api('set', { enabled: false })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'cc-memory/untrusted-origin')
    assert.equal(result.error.message, 'refused')
  } finally {
    globalThis.fetch = previousFetch
  }
})
