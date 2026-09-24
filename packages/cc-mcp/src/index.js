// dsh-cc-mcp — load Claude Code MCP configs into DSH as runtime-registered
// tools, on the official @modelcontextprotocol/sdk.
//
// Sources (parsed by the shared dsh-cc-loader):
//   - project root .mcp.json            → mcp__<server>__<tool> (DSH-native)
//   - plugin roots (config.pluginRoots) → mcp__plugin_<name>_<server>__<tool>
//     (official CC plugin naming), from each plugin's .mcp.json / plugin.json
//
// Modeled on dsh-project-mcp-bridge (MIT): tools register eagerly into the
// agent scope layer (agent/created), connections are lazy with an idle
// timeout, and project .mcp.json changes hot-reload. Env values are expanded
// at runtime from process.env — nothing is written to disk.
//
// The management surface (see ./manage.js) rides on top of that registration
// path: every server keeps a status row (ready / error / disabled / skipped)
// with its tool list, the `/mcp` host command renders those rows as text, and
// the `/cc-mcp` Connection RPC channel serves the Web GUI panel — including
// manual reconnect and the persisted enable/disable decision (the only file
// this plugin writes).
//
// Safety: apply() never throws synchronously; per-agent failures are logged,
// never fatal to the host.

import { watchFile, unwatchFile } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { findProjectRoot, discoverProjectMcp, discoverPluginRoot } from 'dsh-cc-loader'

// Re-exported for callers that need the dir-basename fallback name without a
// manifest (discoverPluginRoot prefers manifest `name`; pluginNameOf is the
// no-manifest fallback).
export { pluginNameOf } from 'dsh-cc-loader'

// DSH's hot mount re-imports the ROW's module URL (…/src/index.js?v=N), but a
// plain `./manage.js` keeps the first load's module instance in Node's ESM
// cache — a reload would then pair new entry code with stale helpers. Hand the
// entry's own cache-buster to every relative import so the three modules always
// come from the same load. (Cold start: no query, single instance, unchanged.)
const MODULE_SUFFIX = new URL(import.meta.url).search

const {
  publicToolName, connectAndList, createDefinition, clearIdle,
} = await import(`./register.js${MODULE_SUFFIX}`)
const {
  RPC_CHANNEL, createDisabledStore, createRouteHandler, defaultStatePath, failuresOf, formatTextReport,
  rpcFail, rpcOk, serverEntry, serverKey, snapshotOf, unknownSnapshot,
} = await import(`./manage.js${MODULE_SUFFIX}`)

export const name = 'dsh-cc-mcp'
export const inject = []

export const Config = Schema.object({
  enableProject: Schema.boolean().default(true),
  pluginRoots: Schema.array(Schema.string()).default([]),
  idleTimeoutMs: Schema.number().default(300000),
  toolCallTimeoutMs: Schema.number().default(60000),
  watchProject: Schema.boolean().default(true),
  projectRootMarkers: Schema.array(Schema.string()).default(['.git', '.dsh', '.claude']),
  // Management surface: the `/mcp` command and the panel's route.
  enableManager: Schema.boolean().default(true),
  // List the host's `dsh-mcp-client` rows in the panel (and allow hiding them
  // for this workspace). They are the host's to connect; this plugin never
  // rewrites the profile config.
  manageHostRows: Schema.boolean().default(true),
  // Explicit state-file override. Empty = per workspace:
  // `<projectRoot>/.dsh/cc-mcp-state.json`.
  statePath: Schema.string().default(''),
})

const DEFAULT_CALL_TIMEOUT_MS = 60000
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const WATCH_DEBOUNCE_MS = 300
/** How long the panel's `check` call waits for the session's self-check. */
const CHECK_WAIT_MS = 20000

const VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// Per-agent live controllers; module-level because agent/created wiring must
// outlive one listener call. Cleanup on agent/disposed and plugin unload.
const agentStates = new Map()
const projectWatchers = new Map() // projectRoot -> { controllers: Set, timer }

// Enable/disable decisions are WORKSPACE-scoped: each project keeps its own
// `<projectRoot>/.dsh/cc-mcp-state.json`, so disabling github here does not
// touch another workspace and never edits the host's profile config. Sessions
// without a project root fall back to the machine-wide file.
const stores = new Map() // projectRoot -> { store, ready }
let globalStore = null
let globalStoreReady = Promise.resolve([])

// The resolved config of the live plugin instance, so late wiring (a session
// whose agent predates this plugin) can build a controller with the same
// options as the listener path.
let activeConfig = null

function log(ctx, level, message) {
  try { ctx.logger?.[level]?.(`dsh-cc-mcp: ${message}`) } catch { /* logger absence is not fatal */ }
}

/** Workspace state file: `<projectRoot>/.dsh/cc-mcp-state.json`. */
function workspaceStatePath(projectRoot) {
  return join(projectRoot, '.dsh', 'cc-mcp-state.json')
}

/**
 * Resolve (and lazily load) the store that owns one session's decisions.
 * @param {object} state - the per-agent controller.
 * @returns {Promise<object|undefined>}
 */
async function storeFor(state) {
  const projectRoot = state.projectRoot
  if (projectRoot === undefined || projectRoot === null || projectRoot === '') {
    await globalStoreReady
    return globalStore ?? undefined
  }
  const pinned = typeof state.config.statePath === 'string' ? state.config.statePath.trim() : ''
  const key = pinned === '' ? String(projectRoot) : `path:${pinned}`
  let entry = stores.get(key)
  if (entry === undefined) {
    const store = createDisabledStore({
      path: pinned === '' ? workspaceStatePath(String(projectRoot)) : pinned,
      log: (level, message) => log(state.ctx, level, message),
    })
    entry = { store, ready: store.load() }
    stores.set(key, entry)
  }
  await entry.ready
  return entry.store
}

/** Whether a decision is recorded for this key — workspace first, then machine. */
function isDisabled(state, key) {
  if (state.store?.has(key) === true) return true
  return globalStore?.has(key) === true
}

// ─── per-agent controller ────────────────────────────────────────────────────

function createController(ctx, agent, agentCtx, baseCwd, config) {
  let resolveCheck = null
  const checkDone = new Promise((resolve) => { resolveCheck = resolve })
  return {
    ctx, agent, agentCtx, baseCwd, config,
    servers: new Map(),
    sources: [],
    queue: Promise.resolve(),
    disposed: false,
    watcherRef: null,
    checked: false,
    reported: true,
    checkDone,
    resolveCheck,
    // Resolved workspace store + this session's host-row hides (key -> disposer).
    store: null,
    hiddenHost: new Map(),
    // Host rows this session adopted (we own their registration) — remembered so
    // a hide/reveal round trip keeps the repaired connection.
    adopted: new Set(),
  }
}

function enqueue(state, fn) {
  state.queue = state.queue.then(fn).catch((error) => {
    if (!state.disposed) log(state.ctx, 'error', `agent ${state.agent.id}: ${String(error)}`)
  })
  return state.queue
}

function settleCheck(state) {
  state.checked = true
  state.reported = false
  const resolve = state.resolveCheck
  state.resolveCheck = null
  if (typeof resolve === 'function') resolve()
}

function cleanupState(ctx, state, reason) {
  if (state.disposed) return
  state.disposed = true
  agentStates.delete(state.agent.id)
  for (const record of [...state.servers.values()]) teardownServer(state, record, reason).catch(() => {})
  state.servers.clear()
  // Lift this session's host-row hides so nothing outlives the controller.
  for (const dispose of state.hiddenHost.values()) {
    try { dispose() } catch { /* the scope is going away anyway */ }
  }
  state.hiddenHost.clear()
  detachWatcher(state)
  settleCheck(state)
  log(ctx, 'info', `agent ${state.agent.id} (${state.baseCwd}): cleanup (${reason})`)
}

// ─── discovery → normalized entries ─────────────────────────────────────────

/** ${CLAUDE_PLUGIN_ROOT} expansion for plugin entries; project entries untouched. */
function expandEntry(entry, pluginRoot) {
  if (!pluginRoot) return entry
  const command = entry.command?.includes('${CLAUDE_PLUGIN_ROOT}')
    ? entry.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : entry.command
  const args = entry.args.map((a) => a.includes('${CLAUDE_PLUGIN_ROOT}')
    ? a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : a)
  const cwd = entry.cwd?.includes('${CLAUDE_PLUGIN_ROOT}')
    ? entry.cwd.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : entry.cwd
  return { ...entry, command, args, cwd }
}

/** Fold loader entries into bridge-style runtime entries (defaults + expansion). */
export function toRuntimeEntries(servers, opts = {}) {
  const { pluginRoot, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, toolCallTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = opts
  const out = []
  for (const s of servers) {
    if (s.status !== 'DIRECT') continue // UNSUPPORTED (sse/ws) reported, not registered
    out.push({
      ...expandEntry(s, pluginRoot),
      toolCallTimeoutMs: s.toolCallTimeoutMs ?? toolCallTimeoutMs,
      idleTimeoutMs: s.idleTimeoutMs ?? idleTimeoutMs,
    })
  }
  return out
}

// ─── host rows (@deepseek-ai/dsh-mcp-client) ────────────────────────────────
//
// The host profile configures MCP servers as one `dsh-mcp-client` row each.
// They are NOT this plugin's to register — the host layer already owns their
// connections and their tools appear globally as `mcp__<server>__*`. The panel
// still lists them, and can act on them per workspace:
//   Disable → hide that row's tools for THIS workspace's sessions only
//             (`tools.restrict({ deny })`, lifted again on Enable);
//   Connect → when the row exposes no tools, adopt it: connect with the row's
//             own config and register the tools in the agent scope.

/** The host plugin each MCP server row is an instance of. */
const HOST_MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Host rows, read from the live Loader tree; empty when the service is absent. */
function hostRows(ctx) {
  let loader = null
  try {
    loader = typeof ctx.get === 'function' ? ctx.get('loader', false) : undefined
  } catch {
    loader = undefined
  }
  if (!loader || typeof loader.entries !== 'function') return []
  const rows = []
  let entries
  try {
    entries = [...loader.entries()]
  } catch {
    return []
  }
  for (const entry of entries) {
    const options = entry?.options
    if (options === undefined || options === null) continue
    if (options.name !== HOST_MCP_PLUGIN) continue
    const config = options.config
    if (config === null || typeof config !== 'object') continue
    const serverName = typeof config.serverName === 'string' ? config.serverName : ''
    if (serverName === '') continue
    rows.push({
      rowId: typeof options.id === 'string' ? options.id : '',
      serverName,
      transport: typeof config.transport === 'string' ? config.transport : undefined,
      command: typeof config.command === 'string' ? config.command : undefined,
      args: Array.isArray(config.args) ? config.args : undefined,
      env: config.env !== null && typeof config.env === 'object' ? config.env : undefined,
      cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
      url: typeof config.url === 'string' ? config.url : undefined,
      headers: config.headers !== null && typeof config.headers === 'object' ? config.headers : undefined,
      toolCallTimeoutMs: typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : undefined,
      idleTimeoutMs: typeof config.idleTimeoutMs === 'number' ? config.idleTimeoutMs : undefined,
      rowDisabled: options.disabled === true,
    })
  }
  return rows
}

/** Tools the host layer currently exposes for one server, from the agent view. */
function hostToolsOf(state, serverName) {
  const prefix = `mcp__${serverName}__`
  try {
    const schemas = state.agentCtx.tools.schemas(state.agent)
    if (!Array.isArray(schemas)) return []
    return schemas
      .filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith(prefix))
      .map((schema) => ({
        name: schema.name,
        rawName: schema.name.slice(prefix.length),
        description: typeof schema.description === 'string' ? schema.description : '',
      }))
  } catch {
    return []
  }
}

/** One host row as a runtime entry this plugin can describe (and adopt). */
function hostRuntimeEntry(row, state) {
  return {
    hostRow: true,
    serverName: row.serverName,
    rowId: row.rowId,
    transport: row.transport,
    command: row.command,
    args: row.args ?? [],
    env: row.env,
    cwd: row.cwd,
    url: row.url,
    headers: row.headers,
    toolCallTimeoutMs: row.toolCallTimeoutMs ?? state.config.toolCallTimeoutMs,
    idleTimeoutMs: row.idleTimeoutMs ?? state.config.idleTimeoutMs,
    source: `host MCP client row${row.rowId === '' ? '' : ` "${row.rowId}"`} (profile config)`,
  }
}

async function collectEntries(state) {
  const cfg = state.config
  const entries = []
  const sources = []
  if (cfg.enableProject && state.projectRoot !== undefined) {
    const found = await discoverProjectMcp(state.projectRoot, { warn: (m) => log(state.ctx, 'warn', `agent ${state.agent.id}: ${m}`) })
    for (const entry of toRuntimeEntries(found.servers, { idleTimeoutMs: cfg.idleTimeoutMs, toolCallTimeoutMs: cfg.toolCallTimeoutMs })) {
      entries.push({ ...entry, source: found.sources?.[0] ?? join(state.projectRoot, '.mcp.json') })
    }
    sources.push(...found.sources)
  }
  for (const root of cfg.pluginRoots) {
    // discoverPluginRoot inventories the whole plugin (M4): manifest name
    // wins over the directory name for the tool namespace, and manifest
    // `mcpServers` path/inline configs are included alongside .mcp.json.
    const plugin = await discoverPluginRoot(root, { warn: (m) => log(state.ctx, 'warn', `agent ${state.agent.id}: ${m}`) })
    for (const entry of toRuntimeEntries(plugin.components.mcp.servers, {
      pluginRoot: root,
      idleTimeoutMs: cfg.idleTimeoutMs,
      toolCallTimeoutMs: cfg.toolCallTimeoutMs,
    })) {
      const own = plugin.components.mcp.sources?.find((source) => source.includes(entry.serverName))
      entries.push({ ...entry, source: own ?? plugin.components.mcp.sources?.[0] ?? root })
    }
    sources.push(...plugin.components.mcp.sources)
  }
  if (cfg.manageHostRows !== false) {
    for (const row of hostRows(state.ctx)) entries.push(hostRuntimeEntry(row, state))
  }
  return { entries, sources }
}

// ─── schema sync + registration ──────────────────────────────────────────────

function hasUpperServerTools(state, prefix) {
  try {
    const schemas = state.agentCtx.tools.schemas(state.agent)
    return Array.isArray(schemas) && schemas.some((s) => typeof s.name === 'string' && s.name.startsWith(prefix))
  } catch {
    return false
  }
}

async function syncSchema(state, entry) {
  const { client, tools } = await connectAndList(entry, state.baseCwd)
  try {
    const definitions = new Map()
    const listed = []
    for (const tool of tools) {
      const publicName = publicToolName(
        { serverName: entry.serverName, pluginName: entry.pluginName },
        tool.name,
      )
      if (definitions.has(publicName)) {
        throw new Error(`server listed tool "${tool.name}" more than once — invalid tool list`)
      }
      definitions.set(publicName, createDefinition(state, entry, tool.name, publicName, tool))
      listed.push({
        name: publicName,
        rawName: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
      })
    }
    const disposers = []
    for (const [publicName, definition] of definitions) {
      try {
        disposers.push(state.agentCtx.tools.register(definition))
      } catch (error) {
        log(state.ctx, 'error', `agent ${state.agent.id}: registering ${publicName} failed: ${String(error)}`)
      }
    }
    return {
      tools: listed,
      unregister: () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* best effort */ }
        }
      },
    }
  } finally {
    try { await client.close() } catch { /* best effort */ }
  }
}

/**
 * Create (or replace) one server's status row and register its tools when it
 * is reachable. Every outcome — ready, error, disabled, skipped — leaves a row
 * behind, because the panel and the self-check report both read that row.
 * @returns {Promise<object>} the live record
 */
async function setupServer(state, entry) {
  const key = serverKey(entry)
  const previous = state.servers.get(key)
  const prefix = entry.pluginName ? `mcp__plugin_${entry.pluginName}_${entry.serverName}__` : `mcp__${entry.serverName}__`
  const record = {
    key,
    entry,
    toolPrefix: prefix,
    source: entry.source ?? null,
    unregister: null,
    conn: null,
    connecting: null,
    tools: previous?.tools ?? [],
    status: 'checking',
    error: null,
    updatedAt: Date.now(),
  }
  state.servers.set(key, record)

  if (isDisabled(state, key)) {
    record.status = 'disabled'
    log(state.ctx, 'info', `agent ${state.agent.id}: server ${entry.serverName} disabled in this workspace — not registered`)
    return record
  }

  if (entry.hostRow === true) {
    return setupHostRow(state, entry, record)
  }

  const upper = hasUpperServerTools(state, prefix)
  if (!entry.override && upper) {
    // Another layer already publishes this namespace. Report what is visible so
    // the panel is honest about it, and leave the registration alone.
    record.status = 'skipped'
    record.tools = hostToolsOf(state, entry.serverName)
    record.error = null
    record.updatedAt = Date.now()
    log(state.ctx, 'info', `agent ${state.agent.id}: server ${entry.serverName} already provided by preset/host MCP — skipped (set "override": true to force)`)
    return record
  }

  try {
    const { tools, unregister } = await syncSchema(state, entry)
    if (state.disposed) {
      unregister()
      return record
    }
    record.unregister = unregister
    record.tools = tools
    record.status = 'ready'
    record.managed = true
    const shadowed = upper ? ' (agent layer shadows upper-layer registration(s))' : ''
    log(state.ctx, 'info', `agent ${state.agent.id}: registered ${tools.length} tool(s) from server ${entry.serverName}${shadowed}`)
  } catch (error) {
    record.status = 'error'
    record.error = error instanceof Error ? error.message : String(error)
    log(state.ctx, 'error', `agent ${state.agent.id}: server ${entry.serverName} not loaded: ${record.error}`)
  }
  record.updatedAt = Date.now()
  return record
}

/**
 * A host `dsh-mcp-client` row: describe it in this workspace's panel, and —
 * only when the row exposes nothing and the caller asked to adopt — connect it
 * with the row's own config so this workspace keeps working tools.
 */
async function setupHostRow(state, entry, record) {
  const name = entry.serverName
  // An adopted row belongs to this session: every rebuild re-registers it
  // (a teardown cleared the previous registration). A plain host row is only
  // described — this plugin never reconnects what the host layer owns.
  const wantsAdopt = entry.adopt === true || state.adopted.has(name)
  const tools = hostToolsOf(state, name)
  if (!wantsAdopt) {
    if (tools.length > 0) {
      record.tools = tools
      record.status = 'ready'
      record.managed = false
      record.error = null
    } else {
      record.status = 'error'
      record.managed = false
      record.adoptable = true
      record.error = entry.rowDisabled === true
        ? 'the host row is disabled in the profile config'
        : 'the host MCP client row exposed no tools (its own connection failed or is still starting) — Connect adopts it for this workspace'
    }
    record.updatedAt = Date.now()
    return record
  }
  try {
    const { tools: listed, unregister } = await syncSchema(state, { ...entry, override: true })
    if (state.disposed) {
      unregister()
      return record
    }
    record.unregister = unregister
    record.tools = listed
    record.status = 'ready'
    record.managed = true
    record.adoptable = false
    record.error = null
    state.adopted.add(name)
    log(state.ctx, 'info', `agent ${state.agent.id}: adopted host row ${name} (${listed.length} tool(s))`)
  } catch (error) {
    record.status = 'error'
    record.managed = false
    record.adoptable = true
    record.error = error instanceof Error ? error.message : String(error)
    log(state.ctx, 'error', `agent ${state.agent.id}: host row ${name} not adopted: ${record.error}`)
  }
  record.updatedAt = Date.now()
  return record
}

async function teardownServer(state, record, reason) {
  const dispose = record.unregister
  record.unregister = null
  if (typeof dispose === 'function') {
    try { dispose() } catch { /* best effort */ }
  }
  record.managed = false
  const conn = record.conn
  record.conn = null
  record.connecting = null
  if (conn !== null && conn !== undefined) {
    clearIdle(conn)
    try { await conn.client.close() } catch { /* best effort */ }
  }
  log(state.ctx, 'info', `agent ${state.agent.id}: server ${record.entry.serverName}: ${reason}`)
}

// ─── management operations (the panel's verbs) ──────────────────────────────

/**
 * Reconnect one server on this session and report its post-attempt row.
 * For a host row that exposes nothing, this is the adoption path: this plugin
 * connects with the row's own config and registers the tools in the agent scope.
 */
async function connectServer(state, key) {
  const record = state.servers.get(key)
  if (record === undefined) {
    return { ok: false, code: 'cc-mcp/unknown-server', message: `unknown server ${JSON.stringify(key)}` }
  }
  if (isDisabled(state, key)) {
    return { ok: false, code: 'cc-mcp/disabled', message: `server ${record.entry.serverName} is disabled in this workspace — enable it first` }
  }
  await enqueue(state, async () => {
    await teardownServer(state, record, record.entry.hostRow === true ? 'adopting host row' : 'manual reconnect')
    await setupServer(state, record.entry.hostRow === true ? { ...record.entry, adopt: true } : record.entry)
  })
  return { ok: true, entry: serverEntry(state.servers.get(key) ?? record) }
}

/**
 * Enable/disable one server in this WORKSPACE and persist the decision to the
 * workspace's own state file. A managed server simply stops being registered;
 * a host row is hidden with a per-session tool restriction (the host row's own
 * connection is never touched, so other workspaces keep it).
 */
async function setServerDisabled(state, key, disabled) {
  const record = state.servers.get(key)
  if (record === undefined) {
    return { ok: false, code: 'cc-mcp/unknown-server', message: `unknown server ${JSON.stringify(key)}` }
  }
  const store = state.store ?? globalStore
  if (store === null || store === undefined) {
    return { ok: false, code: 'cc-mcp/no-store', message: 'the workspace state store is unavailable in this deployment' }
  }
  await store.set(key, disabled === true)
  for (const target of [...agentStates.values()]) {
    const targetRecord = target.servers.get(key)
    if (targetRecord === undefined) continue
    // A workspace store only governs sessions in that same workspace; a session
    // rooted elsewhere keeps its own decision.
    if (target.store !== store) continue
    await enqueue(target, async () => {
      if (targetRecord.entry.hostRow === true) {
        await applyHostVisibility(target, targetRecord, disabled === true)
        return
      }
      await teardownServer(target, targetRecord, disabled === true ? 'disabled in this workspace' : 'enabled in this workspace')
      await setupServer(target, targetRecord.entry)
    })
  }
  return { ok: true, entry: serverEntry(state.servers.get(key) ?? record) }
}

/**
 * Hide or reveal one host row's tools for this session.
 * `tools.restrict` is the platform's per-scope mask and returns the disposer
 * that lifts it, so Enable is exactly Hide undone.
 */
async function applyHostVisibility(state, record, hidden) {
  const name = record.entry.serverName
  if (hidden) {
    if (record.managed === true) {
      // An adopted row is ours: dropping the registration is the honest hide.
      await teardownServer(state, record, 'disabled in this workspace')
    }
    const names = hostToolsOf(state, name).map((tool) => tool.name)
    if (names.length > 0) {
      let dispose = null
      try {
        dispose = state.agentCtx.tools.restrict({ deny: names })
      } catch {
        // Unknown names are rejected per call, so fall back to one at a time.
        const disposers = []
        for (const toolName of names) {
          try { disposers.push(state.agentCtx.tools.restrict({ deny: [toolName] })) } catch { /* unknown tool: not visible anyway */ }
        }
        if (disposers.length > 0) {
          dispose = () => {
            for (const lifted of disposers.reverse()) {
              try { lifted() } catch { /* already gone */ }
            }
          }
        }
      }
      if (dispose === null) {
        log(state.ctx, 'warn', `agent ${state.agent.id}: could not restrict ${name} tools — they stay visible`)
      } else {
        const previous = state.hiddenHost.get(name)
        if (typeof previous === 'function') {
          try { previous() } catch { /* replaced */ }
        }
        state.hiddenHost.set(name, dispose)
      }
    }
    record.status = 'disabled'
    record.error = null
    record.updatedAt = Date.now()
    log(state.ctx, 'info', `agent ${state.agent.id}: host row ${name} hidden in this workspace`)
    return record
  }

  const dispose = state.hiddenHost.get(name)
  if (typeof dispose === 'function') {
    state.hiddenHost.delete(name)
    try { dispose() } catch (error) { log(state.ctx, 'warn', `agent ${state.agent.id}: lifting the ${name} restriction failed: ${String(error)}`) }
  }
  await setupServer(state, record.entry)
  return state.servers.get(record.key) ?? record
}

/**
 * Failures from the session's self-check, reported at most once per check
 * pass so a reconnecting panel cannot re-raise yesterday's toasts.
 */
async function pendingFailures(state) {
  await Promise.race([
    state.checkDone,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, CHECK_WAIT_MS)
      timer.unref?.()
    }),
  ])
  if (state.reported === true) return []
  const failures = failuresOf(state)
  if (failures.length > 0) state.reported = true
  return failures
}

// ─── config application (initial load + hot reload share one path) ──────────

async function applyConfig(state) {
  if (state.disposed) return
  // The workspace store must be loaded before anything registers, so a server
  // disabled in this workspace is never briefly visible.
  if (state.store === null) state.store = await storeFor(state)
  const { entries, sources } = await collectEntries(state)
  state.sources = sources
  for (const record of [...state.servers.values()]) {
    await teardownServer(state, record, 'config change — rebuilding')
  }
  for (const entry of entries) {
    // setupServer itself answers `disabled` for any key recorded in this
    // workspace's store, host rows included.
    await setupServer(state, entry)
  }
  // A server removed from the config must not linger as a stale panel row.
  const live = new Set(entries.map((entry) => serverKey(entry)))
  for (const key of [...state.servers.keys()]) {
    if (!live.has(key)) state.servers.delete(key)
  }
}

async function reloadFromDisk(state) {
  if (state.disposed) return
  try {
    await applyConfig(state)
  } catch (error) {
    log(state.ctx, 'error', `agent ${state.agent.id}: reload failed: ${String(error)}`)
  }
}

// ─── watcher (project .mcp.json hot reload) ──────────────────────────────────

function attachWatcher(state) {
  if (!state.config.watchProject || state.projectRoot === undefined) return
  const root = state.projectRoot
  let w = projectWatchers.get(root)
  if (w === undefined) {
    w = { controllers: new Set(), timer: null }
    projectWatchers.set(root, w)
    const configPath = join(root, '.mcp.json')
    const onChange = () => {
      if (w.timer !== null) clearTimeout(w.timer)
      w.timer = setTimeout(() => {
        w.timer = null
        for (const controller of [...w.controllers]) {
          if (!controller.disposed) {
            enqueue(controller, async () => {
              await reloadFromDisk(controller)
              settleCheck(controller)
            })
          }
        }
      }, WATCH_DEBOUNCE_MS)
    }
    try {
      watchFile(configPath, { interval: 500 }, onChange)
    } catch (error) {
      log(state.ctx, 'warn', `watch ${configPath} failed: ${String(error)} — hot reload disabled`)
    }
  }
  w.controllers.add(state)
  state.watcherRef = w
}

function detachWatcher(state) {
  const w = state.watcherRef
  // `null` is the "never attached" value createController writes; only an
  // attached watcher has controllers to detach from.
  if (w === undefined || w === null) return
  state.watcherRef = undefined
  w.controllers.delete(state)
  if (w.controllers.size === 0 && state.projectRoot !== undefined) {
    if (w.timer !== null) clearTimeout(w.timer)
    try { unwatchFile(join(state.projectRoot, '.mcp.json')) } catch { /* best effort */ }
    projectWatchers.delete(state.projectRoot)
  }
}

// ─── management wiring (command + plugin-owned HTTP route) ──────────────────
//
// The panel's data channel is a route this plugin registers on the host's
// `webServer` service — the pattern the shipped marketplace plugin uses
// (`ctx.inject(['webServer'], …)` → `hostCtx.webServer.register(…)`). The
// generic `connection` RPC service is NOT visible to a profile-level plugin in
// this host (verified against a running `dsh web`), so it cannot carry this
// plugin's traffic.

/** Registration facts the `diag` endpoint reports, for support and tests. */
const manager = {
  enabled: false,
  webServerAvailable: false,
  routeRegistered: false,
  routeError: null,
  agentsServiceAvailable: false,
}

/**
 * Resolve a live Agent for a session id through the host's `ctx.agents`
 * registry. Used to wire a session whose agent already existed when this
 * plugin activated (a host restart restores sessions before user-layer
 * plugins mount, so their `agent/created` was never observable).
 */
function resolveLiveAgent(ctx, sessionId) {
  if (sessionId === '') return undefined
  let agents = null
  try {
    agents = typeof ctx.get === 'function' ? ctx.get('agents', false) : undefined
  } catch {
    agents = undefined
  }
  if (!agents || typeof agents !== 'object') return undefined
  manager.agentsServiceAvailable = true
  try {
    if (typeof agents.get === 'function') return agents.get(sessionId)
    // `store` is the registry's private Map; reading it keeps this working on a
    // host that exposes no accessor. Both paths are best-effort by design.
    const store = agents.store
    if (store instanceof Map) {
      const entry = store.get(sessionId)
      if (entry === undefined) return undefined
      return entry.agent ?? entry
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The controller for one session, wiring it on demand when it was missed.
 * A late wiring waits for the queued self-check, so the first panel open shows
 * settled rows instead of a screen full of spinners.
 * @returns {Promise<object|undefined>}
 */
async function ensureState(ctx, sessionId, agent) {
  const existing = agentStates.get(sessionId)
  if (existing !== undefined) return existing
  if (!agent || agentCwd(agent) === undefined) return undefined
  await wireAgent(ctx, agent, activeConfig ?? {})
  const wired = agentStates.get(sessionId)
  if (wired !== undefined) {
    await Promise.race([
      wired.checkDone,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, CHECK_WAIT_MS)
        timer.unref?.()
      }),
    ])
  }
  return wired
}

function registerCommand(ctx, config) {
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'mcp',
      description: 'List the session\'s MCP servers and their connection status',
      handler: async (invocation) => {
        try {
          const agent = invocation?.agent
          const state = await ensureState(ctx, String(agent?.id ?? ''), agent)
          if (state === undefined) {
            return { kind: 'success', text: 'MCP servers: this session has no project MCP context yet.' }
          }
          return { kind: 'success', text: formatTextReport(snapshotOf(state)) }
        } catch (error) {
          return { kind: 'error', text: `mcp: ${error instanceof Error ? error.message : String(error)}` }
        }
      },
    }), 'cc-mcp: /mcp command')
  })
}

/** Endpoints the panel may call; anything else is refused before any work. */
const RPC_ENDPOINTS = new Set(['ping', 'diag', 'state', 'check', 'connect', 'disable'])

async function handleRpc(ctx, endpoint, payload) {
  const request = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  if (!RPC_ENDPOINTS.has(endpoint)) {
    return rpcFail('cc-mcp/unknown-endpoint', `unknown endpoint ${JSON.stringify(String(endpoint))}`)
  }
  if (endpoint === 'ping') {
    return rpcOk({
      plugin: name,
      version: VERSION,
      sessions: agentStates.size,
      manager: manager.enabled,
      route: manager.routeRegistered,
    })
  }
  if (endpoint === 'diag') {
    const visible = {}
    for (const state of agentStates.values()) {
      try {
        const schemas = state.agentCtx.tools.schemas(state.agent)
        visible[String(state.agent.id)] = Array.isArray(schemas)
          ? schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string' && name.startsWith('mcp__'))
          : []
      } catch {
        visible[String(state.agent.id)] = null
      }
    }
    return rpcOk({
      version: VERSION,
      manager: { ...manager },
      wiredSessions: [...agentStates.keys()].map(String),
      projectRoots: [...agentStates.values()].map((entry) => entry.projectRoot ?? null),
      visibleMcpTools: visible,
    })
  }
  const sessionId = request.sessionId === undefined || request.sessionId === null ? '' : String(request.sessionId)
  const state = await ensureState(ctx, sessionId, resolveLiveAgent(ctx, sessionId))
  if (state === undefined) {
    if (endpoint === 'state') return rpcOk(unknownSnapshot(request.sessionId))
    return rpcFail('cc-mcp/unknown-session', `no live agent is observable for session ${sessionId === '' ? '(none)' : sessionId}`)
  }
  switch (endpoint) {
    case 'state':
      return rpcOk(snapshotOf(state))
    case 'check': {
      // Await the self-check BEFORE reading the flag: object-literal properties
      // evaluate in order, so inlining the await would report the pre-wait state.
      const failures = await pendingFailures(state)
      return rpcOk({ checked: state.checked === true, failures })
    }
    case 'connect': {
      const result = await connectServer(state, String(request.key ?? ''))
      return result.ok ? rpcOk({ entry: result.entry }) : rpcFail(result.code, result.message)
    }
    case 'disable': {
      const result = await setServerDisabled(state, String(request.key ?? ''), request.disabled === true)
      return result.ok ? rpcOk({ entry: result.entry }) : rpcFail(result.code, result.message)
    }
    default:
      // Unreachable: the endpoint allowlist above rejects anything else first.
      return rpcFail('cc-mcp/unknown-endpoint', `unknown endpoint ${JSON.stringify(String(endpoint))}`)
  }
}

function registerManager(ctx, config) {
  manager.enabled = true
  registerCommand(ctx, config)
  ctx.inject(['webServer'], (scope) => {
    manager.webServerAvailable = true
    try {
      scope.effect(() => scope.webServer.register({
        kind: 'prefix',
        path: RPC_CHANNEL,
        handler: createRouteHandler({
          dispatch: (endpoint, payload) => handleRpc(ctx, endpoint, payload),
          log: (level, message) => log(ctx, level, message),
        }),
      }), 'cc-mcp: management routes')
      manager.routeRegistered = true
      manager.routeError = null
    } catch (error) {
      manager.routeRegistered = false
      manager.routeError = error instanceof Error ? error.message : String(error)
      log(ctx, 'error', `could not register ${RPC_CHANNEL}: ${manager.routeError}`)
    }
  })
}

// ─── agent wiring ────────────────────────────────────────────────────────────

function agentCwd(agent) {
  return (agent && agent.session && agent.session.header && agent.session.header.cwd) ||
    (agent && agent.header && agent.header.cwd) ||
    undefined
}

async function wireAgent(ctx, agent, config) {
  const cwd = agentCwd(agent)
  if (!cwd) {
    log(ctx, 'warn', `agent ${agent.id}: no session cwd found — project MCP skipped`)
    return
  }
  const agentCtx = agent.ctx
  if (!agentCtx || typeof agentCtx.tools?.register !== 'function' || typeof agentCtx.tools?.schemas !== 'function') {
    log(ctx, 'warn', `agent ${agent.id} (${cwd}): agent tools service unavailable — project MCP skipped`)
    return
  }
  const state = createController(ctx, agent, agentCtx, cwd, config)
  const projectRoot = config.enableProject ? await findProjectRoot(cwd, config.projectRootMarkers) : undefined
  state.projectRoot = projectRoot
  agentStates.set(agent.id, state)
  attachWatcher(state)
  // The self-check runs beside the conversation, never in front of it: the
  // queue serializes it with config reloads, and `checkDone` is what the
  // panel's `check` endpoint waits on.
  enqueue(state, async () => {
    await reloadFromDisk(state)
    settleCheck(state)
  })
}

export function apply(ctx, config) {
  // apply() must never throw synchronously: a throw here kills the host.
  activeConfig = config
  // Idempotent wiring: `agent/created` covers sessions started after this
  // plugin activates; `agent/session-start` is the startup-driving boundary and
  // catches a session the host resumed in the same boot. A session whose agent
  // predates both is wired on demand by ensureState().
  const wire = async (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    if (agentStates.has(agent.id)) return
    try {
      await wireAgent(ctx, agent, config)
    } catch (error) {
      log(ctx, 'error', `agent ${agent.id}: unexpected failure: ${String(error)}`)
    }
  }
  try {
    const pinned = typeof config.statePath === 'string' ? config.statePath.trim() : ''
    globalStore = createDisabledStore({
      path: pinned === '' ? defaultStatePath() : pinned,
      log: (level, message) => log(ctx, level, message),
    })
    globalStoreReady = globalStore.load().catch((error) => {
      log(ctx, 'error', `state load failed: ${String(error)}`)
      return []
    })
    stores.clear()
    ctx.on('agent/created', (payload) => { void wire(payload) })
    ctx.on('agent/session-start', (payload) => { void wire(payload) })
    ctx.on('agent/disposed', (payload) => {
      const agent = payload && payload.agent
      if (!agent) return
      const state = agentStates.get(agent.id)
      if (state !== undefined) cleanupState(ctx, state, 'agent disposed')
    })
    if (config.enableManager) registerManager(ctx, config)
    ctx.effect(() => () => {
      for (const state of [...agentStates.values()]) cleanupState(ctx, state, 'plugin reloaded')
      globalStore = null
      globalStoreReady = Promise.resolve([])
      stores.clear()
      activeConfig = null
      manager.enabled = false
      manager.routeRegistered = false
      manager.webServerAvailable = false
    })
    log(ctx, 'info', `plugin active — project .mcp.json ${config.enableProject ? 'enabled' : 'disabled'}, ${config.pluginRoots.length} plugin root(s), host rows ${config.manageHostRows === false ? 'ignored' : 'listed'}${config.enableManager ? ', management surface on' : ''}`)
  } catch (error) {
    log(ctx, 'error', `apply failed: ${String(error)}`)
  }
}

export { RPC_CHANNEL }
