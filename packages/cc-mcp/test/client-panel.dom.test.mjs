// Real-DOM verification of the `/mcp` panel (the browser half's contract in
// packages/cc-mcp/client/index.js): the list view, the Connect button, the
// detail view with its tool list, the Disable/Enable toggle, Escape/backdrop
// closing, and the auto-dismissing self-check toast.
//
// jsdom is NOT a dependency of this package, so the suite SKIPS unless it can
// be resolved — point JSDOM_PATH at a jsdom install (or `npm i -D jsdom`) to
// run it. Everything else about the browser half is asserted by the transport
// test in client-bundle.test.mjs and by the host-side integration suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const DEFAULT_JSDOM_PATH = process.env.JSDOM_PATH ?? 'jsdom'

/** Resolve jsdom from the environment, this package, or the workspace root. */
async function loadJsdom() {
  const candidates = [DEFAULT_JSDOM_PATH, 'jsdom']
  for (const candidate of candidates) {
    try {
      return await import(candidate)
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

const jsdomModule = await loadJsdom()

if (jsdomModule === null) {
  test('client panel DOM suite', { skip: 'jsdom not resolvable — set JSDOM_PATH to run it' }, () => {})
} else {
  await runSuite(jsdomModule)
}

async function runSuite({ JSDOM }) {
  const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

  /** A minimal in-memory stand-in for the host's `/cc-mcp` channel. */
  function hostSim() {
    const servers = [
      {
        key: 'project:echo',
        serverName: 'echo',
        pluginName: null,
        scope: 'project',
        transport: 'stdio',
        source: 'C:/p/.mcp.json',
        status: 'ready',
        disabled: false,
        toolPrefix: 'mcp__echo__',
        toolCount: 1,
        tools: [{ name: 'mcp__echo__echo', rawName: 'echo', description: 'Echo the given text back' }],
        error: null,
        updatedAt: 1,
      },
      {
        key: 'project:broken',
        serverName: 'broken',
        pluginName: null,
        scope: 'project',
        transport: 'stdio',
        source: 'C:/p/.mcp.json',
        status: 'error',
        disabled: false,
        toolPrefix: 'mcp__broken__',
        toolCount: 0,
        tools: [],
        error: 'spawn nope ENOENT',
        updatedAt: 1,
      },
    ]
    const calls = []
    const find = (key) => servers.find((server) => server.key === key)
    return {
      calls,
      servers,
      /** Stand-in for one `POST /cc-mcp/<endpoint>` answered by the host half. */
      async dispatch(endpoint, payload) {
        calls.push({ endpoint, payload })
        const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })
        if (endpoint === 'state') {
          return {
            ok: true,
            value: {
              sessionId: 's1',
              known: true,
              projectRoot: 'C:/p',
              sources: ['C:/p/.mcp.json'],
              checked: true,
              servers: servers.map((server) => ({ ...server })),
            },
          }
        }
        if (endpoint === 'check') {
          return {
            ok: true,
            value: { checked: true, failures: [{ key: 'project:broken', serverName: 'broken', error: 'spawn nope ENOENT' }] },
          }
        }
        if (endpoint === 'connect') {
          const server = find(payload.key)
          if (server === undefined) return fail('cc-mcp/unknown-server', payload.key)
          server.status = 'ready'
          server.error = null
          server.toolCount = 1
          server.tools = [{ name: 'mcp__' + server.serverName + '__echo', rawName: 'echo', description: 'Echo the given text back' }]
          return { ok: true, value: { entry: { ...server } } }
        }
        if (endpoint === 'disable') {
          const server = find(payload.key)
          if (server === undefined) return fail('cc-mcp/unknown-server', payload.key)
          server.disabled = payload.disabled === true
          server.status = payload.disabled === true ? 'disabled' : 'ready'
          return { ok: true, value: { entry: { ...server } } }
        }
        return fail('cc-mcp/unknown-endpoint', endpoint)
      },
    }
  }

  let bootCount = 0

  /** Boot the bundle against fresh DOM + services; returns the panel handles. */
  async function boot() {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/' })
    globalThis.window = dom.window
    globalThis.document = dom.window.document

    let registration = null
    dom.window.__ModuleLoader__ = { load: (value) => { registration = value } }
    // The bundle is a classic script that registers into `window` at import
    // time, so every boot needs a fresh module instance (ESM caches otherwise).
    bootCount += 1
    await import(`${new URL('../client/index.js', import.meta.url).href}?boot=${bootCount}`)
    assert.notEqual(registration, null, 'the bundle registered its lazy-CJS factory')
    const plugin = registration.factory(() => { throw new Error('the bundle must not require anything') })

    const host = hostSim()
    const decorations = []
    const disposers = []
    const sessions = {
      current: 's1',
      getSnapshot: () => ({ current: sessions.current, ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {} }),
      subscribe: () => () => {},
    }
    // The bundle POSTs to the plugin's own route; the stub answers the same
    // envelope the host half builds.
    const previousFetch = globalThis.fetch
    const requests = []
    globalThis.fetch = async (url, init) => {
      const endpoint = String(url).replace('/cc-mcp/', '')
      requests.push({ endpoint, init })
      const body = JSON.parse(init.body === '' ? '{}' : init.body)
      return new Response(JSON.stringify(await host.dispatch(endpoint, body)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const scope = {
      effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return disposer },
      commandUi: { decorate: (decoration) => { decorations.push(decoration); return () => {} } },
      sessions: { list: sessions },
    }
    const ctx = {
      effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return disposer },
      inject: (deps, callback) => { callback(scope) },
      get: () => undefined,
      on: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }

    plugin.apply(ctx)
    await tick()

    const document_ = dom.window.document
    const q = (selector) => document_.querySelector(selector)
    const qa = (selector) => [...document_.querySelectorAll(selector)]
    const click = (node) => {
      assert.ok(node, 'the element to click exists')
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    }

    return {
      dom,
      document: document_,
      host,
      requests,
      decorations,
      restoreFetch: () => { globalThis.fetch = previousFetch },
      session: () => sessions,
      q,
      qa,
      click,
      tick,
      dispose: async () => {
        for (const disposer of disposers.reverse()) { try { await disposer() } catch { /* best effort */ } }
        globalThis.fetch = previousFetch
      },
    }
  }

  test('the /mcp decoration opens the panel with a row per server', async () => {
    const app = await boot()
    try {
      assert.equal(app.decorations.length, 1, 'one decoration registered')
      const decoration = app.decorations[0]
      assert.equal(decoration.name, 'mcp')
      assert.equal(decoration.ui.kind, 'action')
      assert.equal(app.q('.ccmcp-overlay'), null, 'panel starts closed')

      decoration.ui.run({ sessionId: 's1' })
      await app.tick()

      assert.ok(app.q('.ccmcp-overlay'), 'panel opened')
      assert.ok(app.q('.ccmcp-panel'), 'panel card mounted')
      assert.match(app.q('.ccmcp-title').textContent, /MCP servers/)
      assert.equal(app.q('.ccmcp-subtitle').textContent, 'C:/p', 'subtitle shows the project root')

      const rows = app.qa('[data-role="row"]')
      assert.deepEqual(rows.map((row) => row.getAttribute('data-key')), ['project:echo', 'project:broken'])
      assert.equal(rows[0].querySelector('.ccmcp-name').textContent, 'echo')
      assert.match(rows[0].querySelector('.ccmcp-type').textContent, /Project · stdio/)
      // ready → the ✓ re-check button; error → the Connect button
      assert.ok(rows[0].querySelector('[data-role="status-ready"]'), 'ready row shows the check button')
      const connect = rows[1].querySelector('[data-role="status-error"]')
      assert.equal(connect.textContent, 'Connect')
    } finally { await app.dispose() }
  })

  test('Connect reconnects a failed server and the row settles to ready', async () => {
    const app = await boot()
    try {
      app.decorations[0].ui.run({ sessionId: 's1' })
      await app.tick()

      const before = app.qa('[data-role="row"]').find((row) => row.getAttribute('data-key') === 'project:broken')
      app.click(before.querySelector('[data-role="status-error"]'))
      await app.tick(60)

      const after = app.qa('[data-role="row"]').find((row) => row.getAttribute('data-key') === 'project:broken')
      assert.ok(after.querySelector('[data-role="status-ready"]'), 'the row now shows the connected check mark')
      assert.ok(app.host.calls.some((call) => call.endpoint === 'connect'), 'the host was asked to reconnect')
    } finally { await app.dispose() }
  })

  test('a row opens the detail view: status, source, tool list and Disable/Enable', async () => {
    const app = await boot()
    try {
      app.decorations[0].ui.run({ sessionId: 's1' })
      await app.tick()

      app.click(app.qa('[data-role="row"]')[0])
      await app.tick()

      assert.equal(app.q('[data-role="statusline"]').textContent, 'Connected · 1 tools')
      assert.match(app.q('.ccmcp-source').textContent, /Configured in C:\/p\/\.mcp\.json/)
      assert.match(app.q('.ccmcp-tools-head').textContent, /Tools \(1\)/)
      assert.equal(app.qa('.ccmcp-tool-name').map((node) => node.textContent)[0], 'mcp__echo__echo')
      assert.match(app.q('.ccmcp-tool-desc').textContent, /Echo the given text back/)

      const toggle = app.q('[data-role="toggle"]')
      assert.equal(toggle.textContent, 'Disable')

      app.click(toggle)
      await app.tick(60)
      assert.equal(app.q('[data-role="toggle"]').textContent, 'Enable', 'Disable flips to Enable')
      assert.equal(app.q('[data-role="statusline"]').textContent, 'Disabled — tools are not in the model context')
      assert.ok(app.q('.ccmcp-tools-muted'), 'the tool list stays visible but muted')
      assert.ok(app.host.servers.find((server) => server.key === 'project:echo').disabled, 'the host recorded the disable')

      app.click(app.q('[data-role="toggle"]'))
      await app.tick(60)
      assert.equal(app.q('[data-role="toggle"]').textContent, 'Disable', 'Enable flips back')
      assert.equal(app.q('[data-role="statusline"]').textContent, 'Connected · 1 tools')

      // Back to the list, then close with Escape.
      app.click(app.q('[data-role="back"]'))
      await app.tick()
      assert.equal(app.qa('[data-role="row"]').length, 2, 'the back button returns to the list')
      app.document.dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await app.tick()
      assert.equal(app.q('.ccmcp-overlay'), null, 'Escape closes the panel')
    } finally { await app.dispose() }
  })

  test('the detail view of a failed server shows its error and no tools', async () => {
    const app = await boot()
    try {
      app.decorations[0].ui.run({ sessionId: 's1' })
      await app.tick()
      const broken = app.qa('[data-role="row"]').find((row) => row.getAttribute('data-key') === 'project:broken')
      app.click(broken.querySelector('.ccmcp-name'))
      await app.tick()

      assert.equal(app.q('[data-role="statusline"]').textContent, 'Disconnected— spawn nope ENOENT')
      assert.match(app.q('.ccmcp-tools').textContent, /This server reported no tools/)
      assert.equal(app.q('[data-role="toggle"]').textContent, 'Disable', 'a failed server can still be disabled')
    } finally { await app.dispose() }
  })

  test('a start-up self-check failure raises an auto-dismissing toast', async () => {
    const app = await boot()
    try {
      const toast = app.q('.ccmcp-toast')
      assert.ok(toast, 'the session self-check raised a toast')
      assert.equal(toast.querySelector('.ccmcp-toast-title').textContent, 'MCP server failed to connect')
      assert.match(toast.querySelector('.ccmcp-toast-body').textContent, /broken/)
      assert.match(toast.querySelector('.ccmcp-toast-body').textContent, /spawn nope ENOENT/)
      assert.ok(app.host.calls.some((call) => call.endpoint === 'check'), 'the toast came from the check endpoint')

      // TOAST_TTL_MS is 6000; the toast must retire itself without a click.
      await app.tick(6400)
      assert.equal(app.q('.ccmcp-toast'), null, 'the toast auto-dismissed')
      assert.equal(app.q('.ccmcp-toast-root'), null, 'the empty toast stack was removed')
    } finally { await app.dispose() }
  })

  test('a failed action degrades to a toast instead of throwing', async () => {
    const app = await boot()
    try {
      app.decorations[0].ui.run({ sessionId: 's1' })
      await app.tick()
      // Break the transport after the panel is open: the action must surface a
      // toast and keep the panel alive.
      globalThis.fetch = async () => { throw new Error('socket exploded') }
      app.click(app.qa('[data-role="row"]')[0])
      await app.tick()
      app.click(app.q('[data-role="toggle"]'))
      await app.tick(80)
      assert.ok(app.q('.ccmcp-overlay'), 'the panel survives a failed action')
      // The self-check toast from boot may still be on screen, so look for the
      // action-failure toast among the stack rather than the first one.
      const toasts = app.qa('.ccmcp-toast').map((node) => ({
        title: node.querySelector('.ccmcp-toast-title').textContent,
        body: node.querySelector('.ccmcp-toast-body').textContent,
      }))
      const failure = toasts.find((toast) => toast.title === 'MCP server action failed')
      assert.ok(failure, `a failed action raises its own toast (saw ${JSON.stringify(toasts)})`)
      assert.match(failure.body, /socket exploded/)
    } finally { await app.dispose() }
  })
}
