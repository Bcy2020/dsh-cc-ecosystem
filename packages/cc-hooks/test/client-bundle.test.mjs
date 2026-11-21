// Structural and transport contract of the dsh-cc-hooks classic-script client.
//
// The bundle must register exactly one lazy-CJS module, need no requires, export
// `{ name, inject: [], apply }`, survive an environment with no DOM, and poll
// the plugin's own notice route with its caller header.

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

function factory() {
  return registrations[0].factory(() => {
    throw new Error('no requires expected')
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('registers exactly one lazy-CJS module under the package id', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-cc-hooks')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('the factory needs no requires and exports the plugin shape', () => {
  const exports = factory()
  assert.equal(exports.name, 'dsh-cc-hooks-client')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, [])
})

test('apply does not throw without a document', () => {
  assert.equal(typeof document, 'undefined')
  const exports = factory()
  globalThis.__dshCcHooksClient = false
  const ctx = {
    effect: (fn) => { fn() },
    inject: () => {},
    logger: console,
  }
  assert.doesNotThrow(() => { exports.apply(ctx) })
})

test('a second instance in the same document stands down', () => {
  globalThis.__dshCcHooksClient = false
  const first = factory()
  const second = factory()
  first.apply({ effect: (fn) => { fn() }, logger: console })
  assert.equal(globalThis.__dshCcHooksClient, true)
  second.apply({
    effect: () => { throw new Error('a second instance must not register effects') },
    logger: console,
  })
  assert.equal(globalThis.__dshCcHooksClient, true)
})

test('reads the current session from the persisted main selection and polls the notice route', async () => {
  const exports = factory()
  globalThis.__dshCcHooksClient = false
  const requests = []
  const previousFetch = globalThis.fetch
  const previousStorage = globalThis.localStorage
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, value: { notices: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  globalThis.localStorage = {
    getItem(key) {
      assert.equal(key, 'dsh.sessions.current')
      return JSON.stringify({ sessionId: 's1' })
    },
  }
  try {
    const ctx = {
      effect: (fn) => { fn() },
      inject: () => { throw new Error('the client half must not inject services') },
      logger: console,
    }
    exports.apply(ctx)
    exports.poll()
    await sleep(10)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/cc-hooks/notices?sessionId=s1')
    assert.equal(requests[0].init.method, 'GET')
    assert.equal(requests[0].init.headers['x-cc-hooks'], '1')
    assert.equal(requests[0].init.credentials, 'same-origin')
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousStorage
  }
})

test('polls nothing while the main selection names no session', async () => {
  const exports = factory()
  globalThis.__dshCcHooksClient = false
  const requests = []
  const previousFetch = globalThis.fetch
  const previousStorage = globalThis.localStorage
  globalThis.fetch = async (url) => { requests.push(String(url)) }
  globalThis.localStorage = { getItem: () => null }
  try {
    exports.apply({ effect: (fn) => { fn() }, logger: console })
    exports.poll()
    await sleep(10)
    assert.deepEqual(requests, [])
  } finally {
    globalThis.fetch = previousFetch
    globalThis.localStorage = previousStorage
  }
})
