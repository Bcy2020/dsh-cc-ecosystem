// Tests for the dsh-cc-mcp management surface (M5): the persisted
// enable/disable store, the status registry, the `/cc-mcp` Connection RPC
// endpoints behind the /mcp panel, and the `/mcp` host command's text report.
//
// The integration cases drive the REAL plugin (apply → agent/created → real
// stdio MCP server from packages/cc-mcp/test/mcp-echo-server.mjs) with fake
// `commands` and `connection` services, so the panel's contract is verified
// against live MCP connections rather than mocks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.js'
import {
  RPC_CHANNEL, createDisabledStore, failuresOf, formatTextReport, rpcFail, rpcOk, serverEntry,
  serverKey, snapshotOf, transportOf, unknownSnapshot,
} from '../src/manage.js'

const ECHO_SERVER = fileURLToPath(new URL('./mcp-echo-server.mjs', import.meta.url))
const FLAKY_SERVER = fileURLToPath(new URL('./mcp-flaky-server.mjs', import.meta.url))

// ─── pure projections ────────────────────────────────────────────────────────

test('serverKey: project and plugin scopes never collide', () => {
  assert.equal(serverKey({ serverName: 'github' }), 'project:github')
  assert.equal(serverKey({ serverName: 'asana', pluginName: 'asana' }), 'plugin:asana:asana')
})

test('transportOf: explicit transport wins, else infers url/command', () => {
  assert.equal(transportOf({ transport: 'stdio' }), 'stdio')
  assert.equal(transportOf({ url: 'https://x/mcp' }), 'http')
  assert.equal(transportOf({ command: 'npx' }), 'stdio')
  assert.equal(transportOf({}), 'unknown')
})

test('serverEntry: projects a live record into the panel row shape', () => {
  const entry = serverEntry({
    key: 'project:echo',
    entry: { serverName: 'echo', transport: 'stdio' },
    toolPrefix: 'mcp__echo__',
    source: 'C:/p/.mcp.json',
    status: 'ready',
    tools: [{ name: 'mcp__echo__echo', rawName: 'echo', description: 'Echo back' }],
    error: null,
    updatedAt: 42,
  })
  assert.deepEqual(entry, {
    key: 'project:echo',
    serverName: 'echo',
    pluginName: null,
    scope: 'project',
    transport: 'stdio',
    source: 'C:/p/.mcp.json',
    status: 'ready',
    disabled: false,
    managed: false,
    adoptable: false,
    rowId: null,
    toolPrefix: 'mcp__echo__',
    toolCount: 1,
    tools: [{ name: 'mcp__echo__echo', rawName: 'echo', description: 'Echo back' }],
    error: null,
    updatedAt: 42,
  })
})

test('serverEntry: host rows carry the host scope and their row id', () => {
  const entry = serverEntry({
    key: 'host:github',
    entry: { serverName: 'github', hostRow: true, rowId: 'mcp-github', transport: 'streamable-http' },
    source: 'host MCP client row "mcp-github" (profile config)',
    status: 'ready',
    managed: false,
    tools: [{ name: 'mcp__github__create_issue', rawName: 'create_issue', description: '' }],
  })
  assert.equal(entry.scope, 'host')
  assert.equal(entry.transport, 'http')
  assert.equal(entry.rowId, 'mcp-github')
  assert.equal(entry.managed, false)
  assert.equal(entry.toolCount, 1)
})

test('serverEntry: disabled status drives the disabled flag', () => {
  const entry = serverEntry({ key: 'project:x', entry: { serverName: 'x' }, status: 'disabled', tools: [] })
  assert.equal(entry.disabled, true)
  assert.equal(entry.toolCount, 0)
  assert.equal(entry.pluginName, null)
})

test('snapshotOf: project rows before plugin rows, both name-sorted', () => {
  const record = (key, entry, status) => ({ key, entry, status, tools: [] })
  const snapshot = snapshotOf({
    agent: { id: 's1' },
    projectRoot: 'C:/p',
    sources: ['C:/p/.mcp.json'],
    checked: true,
    servers: new Map([
      ['plugin:p:b', record('plugin:p:b', { serverName: 'b', pluginName: 'p' }, 'ready')],
      ['project:z', record('project:z', { serverName: 'z' }, 'ready')],
      ['project:a', record('project:a', { serverName: 'a' }, 'error')],
      ['plugin:p:a', record('plugin:p:a', { serverName: 'a', pluginName: 'p' }, 'ready')],
    ]),
  })
  assert.deepEqual(snapshot.servers.map((s) => s.key), ['project:a', 'project:z', 'plugin:p:a', 'plugin:p:b'])
  assert.equal(snapshot.sessionId, 's1')
  assert.equal(snapshot.known, true)
  assert.equal(snapshot.checked, true)
})

test('failuresOf: only error rows with a message, name-sorted', () => {
  const record = (name, status, error) => ({ entry: { serverName: name }, status, error, tools: [] })
  const failures = failuresOf({
    servers: new Map([
      ['project:b', record('b', 'error', 'boom')],
      ['project:a', record('a', 'error', 'bang')],
      ['project:c', record('c', 'ready', null)],
      ['project:d', record('d', 'error', '')],
    ]),
  })
  assert.deepEqual(failures, [
    { key: undefined, serverName: 'a', error: 'bang' },
    { key: undefined, serverName: 'b', error: 'boom' },
  ])
})

test('unknownSnapshot: the panel empty state is not an error', () => {
  const snapshot = unknownSnapshot('nope')
  assert.equal(snapshot.known, false)
  assert.deepEqual(snapshot.servers, [])
  assert.equal(snapshot.sessionId, 'nope')
})

test('rpcOk/rpcFail: Connection RPC envelopes', () => {
  assert.deepEqual(rpcOk({ a: 1 }), { ok: true, value: { a: 1 } })
  assert.deepEqual(rpcFail('cc-mcp/x', 'nope'), { ok: false, error: { code: 'cc-mcp/x', message: 'nope', details: {} } })
})

test('formatTextReport: marks each status and carries the error', () => {
  const text = formatTextReport({
    projectRoot: 'C:/p',
    servers: [
      { serverName: 'ok', scope: 'project', transport: 'stdio', status: 'ready', toolCount: 2, error: null },
      { serverName: 'bad', scope: 'project', transport: 'http', status: 'error', toolCount: 0, error: 'ECONNREFUSED' },
      { serverName: 'off', scope: 'plugin', transport: 'stdio', status: 'disabled', toolCount: 0, error: null },
    ],
  })
  assert.match(text, /MCP servers \(3\) — C:\/p/)
  assert.match(text, /✓ ok \[project\/stdio\] connected · 2 tool\(s\)/)
  assert.match(text, /✗ bad \[project\/http\] not connected/)
  assert.match(text, /ECONNREFUSED/)
  assert.match(text, /– off \[plugin\/stdio\] disabled/)
  assert.match(formatTextReport({ projectRoot: null, servers: [] }), /no MCP server configured/)
})

// ─── persisted enable/disable store ──────────────────────────────────────────

test('createDisabledStore: missing file loads empty, set() persists atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-state-'))
  const path = join(dir, 'nested', 'cc-mcp-state.json')
  try {
    const store = createDisabledStore({ path })
    assert.deepEqual(await store.load(), [])
    assert.equal(store.has('project:x'), false)

    assert.equal(await store.set('project:x', true), true)
    assert.equal(store.has('project:x'), true)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(written.version, 1)
    assert.deepEqual(written.disabled, ['project:x'])
    assert.equal(existsSync(`${path}.tmp-${process.pid}`), false, 'temp file is renamed away')

    assert.equal(await store.set('project:x', true), false, 'same decision is not rewritten')
    assert.equal(await store.set('project:x', false), true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).disabled, [])

    const reloaded = createDisabledStore({ path })
    await reloaded.load()
    assert.deepEqual(reloaded.list(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('createDisabledStore: unreadable file warns and starts empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-state-'))
  const path = join(dir, 'cc-mcp-state.json')
  try {
    writeFileSync(path, '{ not json')
    const warnings = []
    const store = createDisabledStore({ path, log: (level, message) => warnings.push(`${level}:${message}`) })
    assert.deepEqual(await store.load(), [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /unreadable/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─── integration harness ─────────────────────────────────────────────────────

/**
 * Drive the plugin's registered route the way the Web server does: a POST with
 * a JSON body, same-origin headers, and a captured response.
 */
async function invokeRoute(route, endpoint, payload, options = {}) {
  const body = typeof options.rawBody === 'string' ? options.rawBody : JSON.stringify(payload ?? {})
  const request = {
    method: options.method ?? 'POST',
    url: options.url ?? `/cc-mcp/${endpoint}`,
    headers: {
      host: options.host ?? '127.0.0.1:3080',
      origin: options.origin ?? 'http://127.0.0.1:3080',
      ...(options.headers ?? {}),
    },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  let status = 0
  let text = ''
  const response = {
    writeHead(code) { status = code },
    end(chunk) { if (chunk !== undefined) text = String(chunk) },
  }
  await route.handler(request, response)
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* non-JSON bodies stay as text */ }
  return { status, body: parsed, text }
}

/**
 * Boot the real plugin over a temp project, with fake `commands` and
 * `webServer` services that capture the plugin's registrations.
 */
async function harness(servers, options = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'cc-mcp-mgr-'))
  mkdirSync(join(projectDir, '.git'))
  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
  const pinnedStatePath = typeof options.statePath === 'string' ? options.statePath : null
  /** The file the plugin actually writes: pinned, else the workspace default. */
  const activeStatePath = () => pinnedStatePath ?? join(projectDir, '.dsh', 'cc-mcp-state.json')

  const ctx = new Context()
  const logs = []
  ctx.logger = {
    info: (m) => logs.push(`info:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
    error: (m) => logs.push(`error:${m}`),
    debug: () => {},
  }
  let commandDefinition = null
  const routes = []
  ctx.provide('commands', {
    register(definition) {
      commandDefinition = definition
      return () => { commandDefinition = null }
    },
  })
  ctx.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
  })

  // Host `dsh-mcp-client` rows, plus the globally visible tools they expose.
  // The fake agent's `schemas()` merges them with this plugin's own
  // registrations, exactly as the real tools service does.
  const hostTools = new Map(Object.entries(options.hostTools ?? {}))
  const restrictCalls = []
  if (options.hostRows !== undefined) {
    ctx.provide('loader', {
      entries: () => options.hostRows.map((row) => ({
        options: {
          id: row.id,
          name: '@deepseek-ai/dsh-mcp-client',
          config: row.config,
          ...(row.disabled === true ? { disabled: true } : {}),
        },
      })),
    })
  }

  apply(ctx, Config({
    ...(pinnedStatePath === null ? {} : { statePath: pinnedStatePath }),
    watchProject: false,
    idleTimeoutMs: 10000,
    toolCallTimeoutMs: 15000,
  }))

  const registered = new Map()
  const agent = {
    id: 'session-1',
    session: { header: { cwd: projectDir } },
    ctx: {
      tools: {
        schemas: () => [...hostTools.values()].flat().concat([...registered.keys()]).map((name) => ({ name })),
        register(definition) {
          registered.set(definition.name, definition)
          return () => { registered.delete(definition.name) }
        },
        restrict(filter) {
          restrictCalls.push({ kind: 'restrict', filter })
          let lifted = false
          return () => {
            if (lifted) return
            lifted = true
            restrictCalls.push({ kind: 'lift', filter })
          }
        },
      },
    },
  }
  // The lazy-wiring path resolves a live agent through the host's `agents`
  // registry; the bundle test below proves it is only consulted when needed.
  if (options.exposeAgents !== false) {
    ctx.provide('agents', { get: (id) => (id === agent.id ? agent : undefined) })
  }

  const deadline = Date.now() + 5000
  while (routes.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.notEqual(routes.length, 0, 'the plugin registered its route')

  async function send(endpoint, payload, requestOptions) {
    return invokeRoute(routes[0], endpoint, payload, requestOptions)
  }

  // `agent/created` wiring is asynchronous (project-root discovery, then the
  // queued self-check), so every test waits for the session to be known AND
  // its first check to have settled before asserting rows.
  async function started() {
    ctx.emit('agent/created', { agent })
    const limit = Date.now() + 15000
    while (Date.now() < limit) {
      const probe = await send('state', { sessionId: agent.id })
      if (probe.body?.ok === true && probe.body.value.known === true && probe.body.value.checked === true) {
        return probe.body.value
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('the session was never wired')
  }

  return {
    ctx,
    projectDir,
    activeStatePath,
    logs,
    routes,
    agent,
    registered,
    hostTools,
    restrictCalls,
    started,
    send,
    /** The result envelope of one route call, as the browser half sees it. */
    rpc: async (endpoint, payload) => (await send(endpoint, payload)).body,
    command: () => commandDefinition,
    state: () => JSON.parse(readFileSync(activeStatePath(), 'utf8')),
    stateFileExists: () => existsSync(activeStatePath()),
    /** `<projectRoot>/.dsh/cc-mcp-state.json` when the default path is active. */
    workspaceStatePath: () => join(projectDir, '.dsh', 'cc-mcp-state.json'),
    async cleanup() {
      ctx.emit('agent/disposed', { agent })
      await new Promise((resolve) => setTimeout(resolve, 50))
      try { await ctx.fiber.dispose() } catch { /* root disposal is best effort in tests */ }
      // A just-reaped MCP child can still hold the project directory as its cwd
      // on Windows for a moment, which makes an immediate recursive delete EPERM.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          rmSync(projectDir, { recursive: true, force: true })
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      }
      rmSync(projectDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    },
  }
}

// ─── integration: the panel's verbs against a real MCP server ────────────────

test('rpc state: reachable server is ready with its tools, and the check is clean', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    assert.deepEqual(h.routes.map((route) => route.path), [RPC_CHANNEL])
    await h.started()

    const ping = await h.rpc('ping', {})
    assert.equal(ping.ok, true)
    assert.equal(ping.value.plugin, 'dsh-cc-mcp')
    assert.equal(ping.value.manager, true)

    // `check` waits for the session's self-check; `state` is immediate and may
    // legitimately report `checking` rows before it settles.
    const check = await h.rpc('check', { sessionId: 'session-1' })
    assert.equal(check.ok, true)
    assert.equal(check.value.checked, true)
    assert.deepEqual(check.value.failures, [])

    const state = await h.rpc('state', { sessionId: 'session-1' })
    assert.equal(state.ok, true)
    assert.equal(state.value.known, true)
    assert.equal(state.value.projectRoot, h.projectDir)
    assert.equal(state.value.servers.length, 1)
    const [server] = state.value.servers
    assert.equal(server.serverName, 'echo')
    assert.equal(server.status, 'ready')
    assert.equal(server.scope, 'project')
    assert.equal(server.transport, 'stdio')
    assert.equal(server.key, 'project:echo')
    assert.equal(server.toolCount, 1)
    assert.equal(server.tools[0].name, 'mcp__echo__echo')
    assert.equal(server.tools[0].description, 'Echo the given text back')
    assert.ok(h.registered.has('mcp__echo__echo'), 'the tool is registered for the model')
  } finally { await h.cleanup() }
})

test('rpc state: an unknown session renders the panel empty state, not an error', async () => {
  const h = await harness({})
  try {
    const state = await h.rpc('state', { sessionId: 'missing' })
    assert.equal(state.ok, true)
    assert.equal(state.value.known, false)
    assert.deepEqual(state.value.servers, [])

    const connect = await h.rpc('connect', { sessionId: 'missing', key: 'project:echo' })
    assert.equal(connect.ok, false)
    assert.equal(connect.error.code, 'cc-mcp/unknown-session')
  } finally { await h.cleanup() }
})

test('self-check: a failing server is reported once, then the row carries the error', async () => {
  const h = await harness({ broken: { command: process.execPath, args: ['-e', 'process.exit(1)'] } })
  try {
    await h.started()

    const check = await h.rpc('check', { sessionId: 'session-1' })
    assert.equal(check.ok, true)
    assert.equal(check.value.checked, true)
    assert.equal(check.value.failures.length, 1)
    assert.equal(check.value.failures[0].serverName, 'broken')
    assert.equal(check.value.failures[0].key, 'project:broken')
    assert.ok(check.value.failures[0].error.length > 0)

    const again = await h.rpc('check', { sessionId: 'session-1' })
    assert.deepEqual(again.value.failures, [], 'the same failure is not re-raised as a toast')

    const state = await h.rpc('state', { sessionId: 'session-1' })
    const [server] = state.value.servers
    assert.equal(server.status, 'error')
    assert.ok(server.error.length > 0)
    assert.equal(server.toolCount, 0)
    assert.equal(h.registered.size, 0, 'a failed server registers no tools')
  } finally { await h.cleanup() }
})

test('connect: a failing server reports the fresh row, and Connect really re-attempts', async () => {
  // The flaky fixture refuses to start until its marker exists, so the first
  // launch fails and the second (after the marker appears) succeeds — the exact
  // sequence the panel's Connect button drives.
  const marker = join(tmpdir(), `cc-mcp-marker-${process.pid}-${Date.now()}`)
  const h = await harness({ flaky: { command: process.execPath, args: [FLAKY_SERVER, marker] } })
  try {
    await h.started()
    await h.rpc('check', { sessionId: 'session-1' })

    let state = await h.rpc('state', { sessionId: 'session-1' })
    assert.equal(state.value.servers[0].status, 'error')
    assert.equal(h.registered.size, 0)
    assert.equal(existsSync(`${marker}.attempted`), true, 'the fixture really was launched')

    // Still failing: Connect answers ok:true with the error row (never throws).
    const again = await h.rpc('connect', { sessionId: 'session-1', key: 'project:flaky' })
    assert.equal(again.ok, true)
    assert.equal(again.value.entry.status, 'error')
    assert.ok(again.value.entry.error.length > 0)

    // Heal the server: one more Connect brings the tools back.
    writeFileSync(marker, 'ready')
    const restored = await h.rpc('connect', { sessionId: 'session-1', key: 'project:flaky' })
    assert.equal(restored.ok, true)
    assert.equal(restored.value.entry.status, 'ready')
    assert.equal(restored.value.entry.toolCount, 1)
    assert.ok(h.registered.has('mcp__flaky__echo'))

    state = await h.rpc('state', { sessionId: 'session-1' })
    assert.equal(state.value.servers[0].status, 'ready')
  } finally {
    await h.cleanup()
    rmSync(marker, { force: true })
    rmSync(`${marker}.attempted`, { force: true })
  }
})

test('connect: an unknown key is a business error', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    await h.started()
    await h.rpc('check', { sessionId: 'session-1' })
    const result = await h.rpc('connect', { sessionId: 'session-1', key: 'project:nope' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'cc-mcp/unknown-server')
  } finally { await h.cleanup() }
})

test('disable/enable: unregisters tools, persists the decision, and survives a reload', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    await h.started()
    await h.rpc('check', { sessionId: 'session-1' })
    assert.ok(h.registered.has('mcp__echo__echo'))

    const off = await h.rpc('disable', { sessionId: 'session-1', key: 'project:echo', disabled: true })
    assert.equal(off.ok, true)
    assert.equal(off.value.entry.status, 'disabled')
    assert.equal(off.value.entry.disabled, true)
    assert.equal(h.registered.size, 0, 'disabling removes the tools from the model context')
    assert.deepEqual(h.state().disabled, ['project:echo'])

    const blocked = await h.rpc('connect', { sessionId: 'session-1', key: 'project:echo' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error.code, 'cc-mcp/disabled')

    const state = await h.rpc('state', { sessionId: 'session-1' })
    assert.equal(state.value.servers[0].status, 'disabled')

    const on = await h.rpc('disable', { sessionId: 'session-1', key: 'project:echo', disabled: false })
    assert.equal(on.value.entry.status, 'ready')
    assert.ok(h.registered.has('mcp__echo__echo'))
    assert.deepEqual(h.state().disabled, [])
  } finally { await h.cleanup() }
})

test('disable: a persisted decision applies to a fresh session with no config write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-seed-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify({ version: 1, disabled: ['project:echo'] }))
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } }, { statePath })
  try {
    await h.started()
    const state = await h.rpc('state', { sessionId: 'session-1' })
    assert.equal(state.value.servers[0].status, 'disabled')
    assert.equal(h.registered.size, 0, 'a disabled server never registers tools')
    // The only file this plugin writes is its own state — never the CC config.
    assert.equal(JSON.parse(readFileSync(join(h.projectDir, '.mcp.json'), 'utf8')).mcpServers.echo.command, process.execPath)
  } finally {
    await h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host command: /mcp renders the text report for a wired agent only', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    await h.started()
    await h.rpc('check', { sessionId: 'session-1' })

    const definition = h.command()
    assert.equal(definition.name, 'mcp')
    assert.equal(typeof definition.handler, 'function')

    const report = await definition.handler({ agent: h.agent })
    assert.equal(report.kind, 'success')
    assert.match(report.text, /MCP servers \(1\)/)
    assert.match(report.text, /✓ echo \[project\/stdio\] connected · 1 tool\(s\)/)

    // An agent the registry cannot resolve never gets a controller.
    const unknown = await definition.handler({ agent: { id: 'nope' } })
    assert.equal(unknown.kind, 'success')
    assert.match(unknown.text, /no project MCP context/)
  } finally { await h.cleanup() }
})

test('plugin unload: tools are released and the agent row is dropped', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    await h.started()
    await h.rpc('check', { sessionId: 'session-1' })
    assert.equal(h.registered.size, 1)

    h.ctx.emit('agent/disposed', { agent: h.agent })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(h.registered.size, 0, 'agent disposal releases the MCP tools')
  } finally { await h.cleanup() }
})

// ─── late wiring: a session whose agent predates this plugin ─────────────────
//
// A host restart resumes the last session before user-layer plugins mount, so
// that session's `agent/created` was never observable. The panel must still
// resolve it through the host's `agents` registry instead of reporting "not
// wired" (the exact failure this endpoint pair was rewritten for).

test('a session whose agent already existed is wired on demand', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    // No `agent/created` / `agent/session-start` was ever emitted.
    const state = await h.rpc('state', { sessionId: 'session-1' })
    assert.equal(state.ok, true)
    assert.equal(state.value.known, true, 'the registry lookup wired the live agent')
    assert.equal(state.value.servers.length, 1)
    assert.equal(state.value.servers[0].status, 'ready')
    assert.ok(h.registered.has('mcp__echo__echo'), 'late wiring still registers the tools')
  } finally { await h.cleanup() }
})

test('a session the registry does not know stays the panel empty state', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } }, { exposeAgents: false })
  try {
    const state = await h.rpc('state', { sessionId: 'session-1' })
    assert.equal(state.ok, true)
    assert.equal(state.value.known, false)
    assert.deepEqual(state.value.servers, [])

    const connect = await h.rpc('connect', { sessionId: 'session-1', key: 'project:echo' })
    assert.equal(connect.ok, false)
    assert.equal(connect.error.code, 'cc-mcp/unknown-session')
  } finally { await h.cleanup() }
})

// ─── the transport itself (the browser half's real contract) ─────────────────

test('route: exposes diagnostics and answers GET without a body', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    const ping = await h.rpc('ping', {})
    assert.equal(ping.value.manager, true)
    assert.equal(ping.value.route, true)

    const diag = await h.rpc('diag', {})
    assert.equal(diag.ok, true)
    assert.equal(diag.value.manager.routeRegistered, true)
    assert.equal(diag.value.manager.webServerAvailable, true)

    const viaGet = await h.send('ping', undefined, { method: 'GET' })
    assert.equal(viaGet.status, 200)
    assert.equal(viaGet.body.value.plugin, 'dsh-cc-mcp')
  } finally { await h.cleanup() }
})

test('route: refuses cross-origin POSTs and rejects malformed requests', async () => {
  const h = await harness({ echo: { command: process.execPath, args: [ECHO_SERVER] } })
  try {
    const crossOrigin = await h.send('state', { sessionId: 'session-1' }, { origin: 'http://evil.example' })
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.body.error.code, 'cc-mcp/untrusted-origin')

    const noOrigin = await h.send('state', { sessionId: 'session-1' }, { origin: undefined, headers: { origin: '' } })
    assert.equal(noOrigin.status, 403, 'a POST without an Origin is refused')

    // A well-formed path naming no endpoint answers an error envelope, so the
    // panel can render it instead of hitting a bare HTTP failure.
    const unknown = await h.send('nope', {})
    assert.equal(unknown.status, 200)
    assert.equal(unknown.body.error.code, 'cc-mcp/unknown-endpoint')

    const badMethod = await h.send('state', {}, { method: 'PUT' })
    assert.equal(badMethod.status, 405)

    const badBody = await h.send('state', undefined, { rawBody: '{ not json' })
    assert.equal(badBody.status, 400)
    assert.equal(badBody.body.error.code, 'cc-mcp/bad-request')

    const outsideChannel = await h.send(undefined, {}, { url: '/other/state' })
    assert.equal(outsideChannel.status, 404)
  } finally { await h.cleanup() }
})

// ─── host rows: listed, hidden per workspace, adopted on demand ─────────────
//
// A host row is one `@deepseek-ai/dsh-mcp-client` instance in the profile
// config. The panel lists it; Disable hides its tools for THIS workspace only
// (`tools.restrict`, lifted again on Enable); Connect adopts a row that exposes
// nothing by connecting with the row's own config.

const HOST_ROW_READY = {
  id: 'mcp-github',
  config: { serverName: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' },
}
const HOST_ROW_BROKEN = {
  id: 'mcp-echo-host',
  config: { serverName: 'echo-host', transport: 'stdio', command: process.execPath, args: [ECHO_SERVER] },
}

test('host rows: listed with the host scope, their tools and their source', async () => {
  const h = await harness({}, {
    hostRows: [HOST_ROW_READY],
    hostTools: { github: ['mcp__github__create_issue', 'mcp__github__get_issue'] },
    statePath: join(mkdtempSync(join(tmpdir(), 'cc-mcp-host-')), 'state.json'),
  })
  try {
    await h.started()
    const state = await h.rpc('state', { sessionId: 'session-1' })
    const row = state.value.servers.find((server) => server.key === 'host:github')
    assert.ok(row, 'the host row is listed')
    assert.equal(row.scope, 'host')
    assert.equal(row.transport, 'http')
    assert.equal(row.status, 'ready')
    assert.equal(row.managed, false, 'the host layer owns this connection')
    assert.equal(row.rowId, 'mcp-github')
    assert.equal(row.toolCount, 2)
    assert.deepEqual(row.tools.map((tool) => tool.rawName), ['create_issue', 'get_issue'])
    assert.match(row.source, /host MCP client row "mcp-github"/)
  } finally { await h.cleanup() }
})

test('host rows: Disable hides the tools for this workspace only, Enable lifts it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-hoststate-'))
  const h = await harness({}, {
    hostRows: [HOST_ROW_READY],
    hostTools: { github: ['mcp__github__create_issue', 'mcp__github__get_issue'] },
    statePath: join(dir, 'state.json'),
  })
  try {
    await h.started()

    const off = await h.rpc('disable', { sessionId: 'session-1', key: 'host:github', disabled: true })
    assert.equal(off.ok, true)
    assert.equal(off.value.entry.status, 'disabled')
    assert.deepEqual(h.restrictCalls[0], {
      kind: 'restrict',
      filter: { deny: ['mcp__github__create_issue', 'mcp__github__get_issue'] },
    })
    assert.deepEqual(h.state().disabled, ['host:github'], 'the decision lands in this workspace state file')

    // The host row itself is never touched: its tools are only masked here.
    assert.equal(h.hostTools.get('github').length, 2)

    const on = await h.rpc('disable', { sessionId: 'session-1', key: 'host:github', disabled: false })
    assert.equal(on.value.entry.status, 'ready')
    assert.equal(h.restrictCalls.at(-1).kind, 'lift', 'the restriction disposer lifts it again')
    assert.deepEqual(h.state().disabled, [])
  } finally {
    await h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host rows: a disabled row stays hidden across a config rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-hostpersist-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify({ version: 1, disabled: ['host:github'] }))
  const h = await harness({}, {
    hostRows: [HOST_ROW_READY],
    hostTools: { github: ['mcp__github__create_issue'] },
    statePath,
  })
  try {
    await h.started()
    const state = await h.rpc('state', { sessionId: 'session-1' })
    const row = state.value.servers.find((server) => server.key === 'host:github')
    assert.equal(row.status, 'disabled')
    assert.equal(h.restrictCalls.filter((call) => call.kind === 'restrict').length, 0,
      'a row disabled from the store is hidden without a redundant restriction')
  } finally {
    await h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host rows: Connect adopts a row that exposes nothing, and Disable drops it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-hostadopt-'))
  const h = await harness({}, { hostRows: [HOST_ROW_BROKEN], statePath: join(dir, 'state.json') })
  try {
    await h.started()

    const before = await h.rpc('state', { sessionId: 'session-1' })
    const pending = before.value.servers.find((server) => server.key === 'host:echo-host')
    assert.equal(pending.status, 'error')
    assert.equal(pending.adoptable, true)
    assert.match(pending.error, /exposed no tools/)
    assert.equal(h.registered.size, 0, 'nothing is registered while the row is broken')

    // Connect = adopt: this plugin connects with the row's own config.
    const adopted = await h.rpc('connect', { sessionId: 'session-1', key: 'host:echo-host' })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.value.entry.status, 'ready')
    assert.equal(adopted.value.entry.managed, true, 'this plugin owns the adopted connection')
    assert.equal(adopted.value.entry.toolCount, 1)
    assert.ok(h.registered.has('mcp__echo-host__echo'), 'the tool is registered for the model')

    // Disabling an adopted row drops the registration (no mask needed: the
    // tools were ours, so they simply disappear).
    const off = await h.rpc('disable', { sessionId: 'session-1', key: 'host:echo-host', disabled: true })
    assert.equal(off.value.entry.status, 'disabled')
    assert.equal(h.registered.size, 0)
    assert.deepEqual(h.state().disabled, ['host:echo-host'])

    // Enable re-adopts the same row.
    const on = await h.rpc('disable', { sessionId: 'session-1', key: 'host:echo-host', disabled: false })
    assert.equal(on.value.entry.status, 'ready')
    assert.equal(on.value.entry.managed, true)
    assert.ok(h.registered.has('mcp__echo-host__echo'))
  } finally {
    await h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
