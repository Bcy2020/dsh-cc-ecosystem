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
// Safety: apply() never throws synchronously; per-agent failures are logged,
// never fatal to the host.

import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { findProjectRoot, discoverProjectMcp, discoverMcpConfig } from 'dsh-cc-loader'
import {
  publicToolName, connectAndList, createDefinition, clearIdle,
} from './register.js'

export const name = 'dsh-cc-mcp'
export const inject = []

export const Config = Schema.object({
  enableProject: Schema.boolean().default(true),
  pluginRoots: Schema.array(Schema.string()).default([]),
  idleTimeoutMs: Schema.number().default(300000),
  toolCallTimeoutMs: Schema.number().default(60000),
  watchProject: Schema.boolean().default(true),
})

const DEFAULT_CALL_TIMEOUT_MS = 60000
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const WATCH_DEBOUNCE_MS = 300

// Per-agent live controllers; module-level because agent/created wiring must
// outlive one listener call. Cleanup on agent/disposed and plugin unload.
const agentStates = new Map()
const projectWatchers = new Map() // projectRoot -> { controllers: Set, timer }

function log(ctx, level, message) {
  try { ctx.logger?.[level]?.(`dsh-cc-mcp: ${message}`) } catch { /* logger absence is not fatal */ }
}

// ─── per-agent controller ────────────────────────────────────────────────────

function createController(ctx, agent, agentCtx, baseCwd, config) {
  return {
    ctx, agent, agentCtx, baseCwd, config,
    servers: new Map(),
    queue: Promise.resolve(),
    disposed: false,
    watcherRef: null,
  }
}

function enqueue(state, fn) {
  state.queue = state.queue.then(fn).catch((error) => {
    if (!state.disposed) log(state.ctx, 'error', `agent ${state.agent.id}: ${String(error)}`)
  })
  return state.queue
}

function cleanupState(ctx, state, reason) {
  if (state.disposed) return
  state.disposed = true
  agentStates.delete(state.agent.id)
  for (const record of [...state.servers.values()]) teardownServer(state, record, reason).catch(() => {})
  detachWatcher(state)
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

async function collectEntries(state) {
  const cfg = state.config
  const entries = []
  const sources = []
  if (cfg.enableProject && state.projectRoot !== undefined) {
    const found = await discoverProjectMcp(state.projectRoot, { warn: (m) => log(state.ctx, 'warn', `agent ${state.agent.id}: ${m}`) })
    entries.push(...toRuntimeEntries(found.servers, { idleTimeoutMs: cfg.idleTimeoutMs, toolCallTimeoutMs: cfg.toolCallTimeoutMs }))
    sources.push(...found.sources)
  }
  for (const root of cfg.pluginRoots) {
    const found = await discoverMcpConfig(root, { pluginName: pluginNameOf(root), warn: (m) => log(state.ctx, 'warn', `agent ${state.agent.id}: ${m}`) })
    entries.push(...toRuntimeEntries(found.servers, {
      pluginRoot: root,
      idleTimeoutMs: cfg.idleTimeoutMs,
      toolCallTimeoutMs: cfg.toolCallTimeoutMs,
    }))
    sources.push(...found.sources)
  }
  return { entries, sources }
}

/** Plugin directory name as the CC plugin name used in tool namespaces. */
export function pluginNameOf(root) {
  const base = root.split(/[\\/]/).filter(Boolean).pop() ?? 'plugin'
  return base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'plugin'
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
    const prefix = entry.pluginName ? `mcp__plugin_${entry.pluginName}_${entry.serverName}__` : `mcp__${entry.serverName}__`
    for (const tool of tools) {
      const publicName = publicToolName(
        { serverName: entry.serverName, pluginName: entry.pluginName },
        tool.name,
      )
      if (definitions.has(publicName)) {
        throw new Error(`server listed tool "${tool.name}" more than once — invalid tool list`)
      }
      definitions.set(publicName, createDefinition(state, entry, tool.name, publicName, tool))
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
      toolCount: disposers.length,
      prefix,
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

async function setupServer(state, entry) {
  const serverName = entry.serverName
  const prefix = entry.pluginName ? `mcp__plugin_${entry.pluginName}_${serverName}__` : `mcp__${serverName}__`
  const upper = hasUpperServerTools(state, prefix)
  if (!entry.override && upper) {
    log(state.ctx, 'info', `agent ${state.agent.id}: server ${serverName} already provided by preset/host MCP — skipped (set "override": true to force)`)
    return
  }
  try {
    const { toolCount, unregister } = await syncSchema(state, entry)
    if (state.disposed) {
      unregister()
      return
    }
    state.servers.set(serverName, { entry, unregister, conn: null, connecting: null })
    const shadowed = upper ? ' (agent layer shadows upper-layer registration(s))' : ''
    log(state.ctx, 'info', `agent ${state.agent.id}: registered ${toolCount} tool(s) from server ${serverName}${shadowed}`)
  } catch (error) {
    log(state.ctx, 'error', `agent ${state.agent.id}: server ${serverName} not loaded: ${String(error)}`)
  }
}

async function teardownServer(state, record, reason) {
  state.servers.delete(record.entry.serverName)
  try { record.unregister() } catch { /* best effort */ }
  const conn = record.conn
  if (conn !== null) {
    record.conn = null
    clearIdle(conn)
    try { await conn.client.close() } catch { /* best effort */ }
  }
  log(state.ctx, 'info', `agent ${state.agent.id}: server ${record.entry.serverName}: ${reason}`)
}

// ─── config application (initial load + hot reload share one path) ──────────

async function applyConfig(state) {
  if (state.disposed) return
  const { entries } = await collectEntries(state)
  for (const record of [...state.servers.values()]) {
    await teardownServer(state, record, 'config change — rebuilding')
  }
  for (const entry of entries) {
    await setupServer(state, entry)
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
          if (!controller.disposed) enqueue(controller, () => reloadFromDisk(controller))
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
  if (w === undefined) return
  state.watcherRef = undefined
  w.controllers.delete(state)
  if (w.controllers.size === 0 && state.projectRoot !== undefined) {
    if (w.timer !== null) clearTimeout(w.timer)
    try { unwatchFile(join(state.projectRoot, '.mcp.json')) } catch { /* best effort */ }
    projectWatchers.delete(state.projectRoot)
  }
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
  const projectRoot = config.enableProject ? await findProjectRoot(cwd) : undefined
  state.projectRoot = projectRoot
  agentStates.set(agent.id, state)
  attachWatcher(state)
  enqueue(state, () => reloadFromDisk(state))
}

export function apply(ctx, config) {
  // apply() must never throw synchronously: a throw here kills the host.
  const wire = async (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    try {
      await wireAgent(ctx, agent, config)
    } catch (error) {
      log(ctx, 'error', `agent ${agent.id}: unexpected failure: ${String(error)}`)
    }
  }
  try {
    ctx.on('agent/created', (payload) => { void wire(payload) })
    ctx.on('agent/disposed', (payload) => {
      const agent = payload && payload.agent
      if (!agent) return
      const state = agentStates.get(agent.id)
      if (state !== undefined) cleanupState(ctx, state, 'agent disposed')
    })
    ctx.effect(() => () => {
      for (const state of [...agentStates.values()]) cleanupState(ctx, state, 'plugin reloaded')
    })
    log(ctx, 'info', `plugin active — project .mcp.json ${config.enableProject ? 'enabled' : 'disabled'}, ${config.pluginRoots.length} plugin root(s)`)
  } catch (error) {
    log(ctx, 'error', `apply failed: ${String(error)}`)
  }
}
