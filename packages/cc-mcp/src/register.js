// dsh-cc-mcp — tool definition / MCP client plumbing (ported from
// dsh-project-mcp-bridge, MIT, KYinCode, with plugin-namespace support).
//
// All functions here are pure-ish (no plugin wiring): they build tool
// definitions from MCP tool schemas and drive the official MCP SDK client.
// Env values are expanded at runtime from process.env (never inlined into
// any config); `${CLAUDE_PLUGIN_ROOT}` expands to the plugin directory.

import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Carry this module's own cache-buster into manage.js, so a DSH hot reload of
// `…/src/index.js?v=N` never mixes a fresh entry with a stale helper module.
const { serverKey } = await import(`./manage.js${new URL(import.meta.url).search}`)

export const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/**
 * CC tool naming: plugin MCP → mcp__plugin_<plugin>_<server>__<tool>;
 * project MCP → mcp__<server>__<tool> (DSH-native). Normalized per the
 * DeepSeek name contract: illegal chars → `_`, overlong → sha256 hash suffix.
 * @param {{serverName: string, pluginName?: string}} scope
 * @param {string} rawName
 * @returns {string}
 */
export function publicToolName(scope, rawName) {
  const prefix = scope.pluginName
    ? `mcp__plugin_${scope.pluginName}_${scope.serverName}__`
    : `mcp__${scope.serverName}__`
  const joined = prefix + rawName
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${prefix}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Replace ${NAME} with process.env.NAME; missing vars are left verbatim and warned. */
export function interpolateEnv(value, warn) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) => {
    const v = process.env[key]
    if (v === undefined) {
      warn(`environment variable ${key} is not set`)
      return match
    }
    return v
  })
}

/**
 * Expand ${CLAUDE_PLUGIN_ROOT} (plugin dir) in a command/arg/cwd string.
 * @param {string} value
 * @param {string} pluginRoot - absolute plugin directory
 * @returns {string}
 */
export function expandPluginRoot(value, pluginRoot) {
  if (!value.includes('${CLAUDE_PLUGIN_ROOT}')) return value
  return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
}

function createTransport(entry, baseCwd) {
  if (entry.transport === 'stdio') {
    const cwd = entry.cwd === undefined
      ? baseCwd
      : isAbsolute(entry.cwd) ? entry.cwd : join(baseCwd, entry.cwd)
    const warn = () => {}
    const env = {}
    for (const [k, v] of Object.entries(entry.env ?? {})) env[k] = interpolateEnv(v, warn)
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      // Privilege reduction (mirrors the official bridge): credential-shaped
      // and stale DSH_* variables dropped, then the config's explicit env on top.
      env: { ...scrubbedParentEnv(), ...env },
      cwd,
    })
  }
  return new StreamableHTTPClientTransport(new URL(entry.url), {
    headers: Object.fromEntries(
      Object.entries(entry.headers ?? {}).map(([k, v]) => [k, interpolateEnv(v, () => {})]),
    ),
  })
}

/** Connect a fresh client and drain tools/list; closes it on failure. */
export async function connectAndList(entry, baseCwd, onClose) {
  const client = new Client({ name: 'dsh-cc-mcp', version: '0.1.0' })
  const transport = createTransport(entry, baseCwd)
  let closed = false
  client.onclose = () => {
    closed = true
    if (onClose) onClose()
  }
  try {
    await client.connect(transport)
    const tools = []
    let cursor
    do {
      const page = await client.listTools({ cursor })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return { client, tools, closed }
  } catch (error) {
    try { await client.close() } catch { /* best effort */ }
    throw error
  }
}

/** MCP content blocks → model-facing text (mirrors dsh-mcp-client). */
export function extractText(mcpContent) {
  const parts = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    switch (value.type) {
      case 'text':
        parts.push(typeof value.text === 'string' ? value.text : '')
        break
      case 'image':
        parts.push(`[image: ${value.mimeType ?? 'unknown'}]`)
        break
      case 'audio':
        parts.push(`[audio: ${value.mimeType ?? 'unknown'}]`)
        break
      case 'resource':
        parts.push(`[resource: ${value.resource?.uri ?? 'unknown'}]`)
        break
      default:
        parts.push(`[unsupported content type: ${value.type ?? 'unknown'}]`)
    }
  }
  return parts.join('\n')
}

/** callTool result → model-facing content (isError results throw). */
export function mapResult(result) {
  if (!Array.isArray(result.content)) {
    const rendered = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
    const text = typeof rendered === 'string' ? rendered : '(no output)'
    if (result.isError === true) throw new Error(text)
    return { content: [{ type: 'text', text }], ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
  }
  const text = extractText(result.content)
  if (result.isError === true) throw new Error(text)
  return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
}

/** Build the canonical output declaration (structured content falls back to JsonValue). */
export function createOutput(rawName) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: extractText(value.content) }]
    },
  }
}

/**
 * One tool definition. `execute` lazily connects (first call) and re-arms the
 * per-connection idle timer around the call. `state.servers` holds the live
 * records; see the controller in index.js.
 */
export function createDefinition(state, entry, rawName, publicName, tool) {
  return {
    name: publicName,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.inputSchema,
    output: createOutput(rawName),
    async execute(args, exec) {
      const record = state.servers.get(serverKey(entry))
      if (record === undefined) throw new Error(`server ${entry.serverName} is no longer configured — reload the project config`)
      if (record.status !== 'ready') {
        const detail = typeof record.error === 'string' && record.error !== '' ? `: ${record.error}` : ''
        throw new Error(`server ${entry.serverName} is not available (${record.status})${detail}`)
      }
      const conn = await ensureConnected(state, record)
      conn.busy++
      try {
        armIdle(conn)
        const signal = exec && exec.signal
          ? AbortSignal.any([exec.signal, AbortSignal.timeout(record.entry.toolCallTimeoutMs)])
          : AbortSignal.timeout(record.entry.toolCallTimeoutMs)
        const result = await conn.client.callTool(
          { name: rawName, arguments: typeof args === 'object' && args !== null ? args : {} },
          undefined,
          { signal },
        )
        return mapResult(result)
      } finally {
        conn.busy--
        armIdle(conn)
      }
    },
  }
}

// ─── pooled connections ──────────────────────────────────────────────────────
//
// One client per (server identity, config), shared by every session that wants
// that server — the same idea as Claude Code's process-global MCP clients,
// which it reconciles by config equality (module-1115.js `reconcileMcpServers`:
// an unchanged config RETAINS the live client; only `areMcpConfigsEqual` being
// false triggers `clearServerCache` and a fresh dial). That is why CC's `/mcp`
// shows servers instantly in a project it has already visited.
//
// Without this, every new DSH session re-dialed every server just to enumerate
// its tools, and closed the client again — measurable as a panel that filled in
// one row at a time, on every visit.
//
// The pool entry owns the client, the tool list, and the idle timer; a session's
// `record.conn` is a reference to it, so the existing call path is unchanged.
// A client is closed once it has been idle for `idleTimeoutMs`, or immediately
// when the server drops the connection itself.
//
// The spawn cwd is deliberately NOT part of the key: like CC, a stdio server
// keeps the working directory of whichever session dialed it first. Only an
// explicit `cwd` in the server config takes part in the fingerprint.

const MAX_TIMER_DELAY_MS = 0x7fffffff

/** @type {Map<string, object>} poolKey -> entry */
const pool = new Map()

/** Connection-relevant fields of an entry, in a stable order. */
function fingerprintOf(entry) {
  return JSON.stringify([
    entry.transport ?? '',
    entry.command ?? '',
    entry.args ?? [],
    entry.cwd ?? '',
    entry.url ?? '',
    entry.env ?? {},
    entry.headers ?? {},
  ])
}

/** Pool identity: the server (scope + name + plugin) plus its config. */
export function poolKeyOf(entry) {
  return `${serverKey(entry)} ${fingerprintOf(entry)}`
}

/**
 * The live pooled connection for `entry`, dialing once on a miss.
 * Concurrent callers for the same key share one dial attempt.
 * @param {object} entry - the runtime entry to connect.
 * @param {{ baseCwd?: string, idleTimeoutMs?: number }} [opts] - `baseCwd` is
 *   used only for the dial that actually happens (stdio servers default to it).
 * @returns {Promise<object>} the pool entry: { key, client, tools, busy,
 *   idleTimer, closed }
 */
export async function acquire(entry, opts = {}) {
  const key = poolKeyOf(entry)
  let conn = pool.get(key)
  if (conn !== undefined && !conn.closed) {
    // A session wants this server: keep it warm while that session lives.
    clearIdle(conn)
    return conn
  }

  if (conn === undefined) {
    conn = {
      key,
      entry,
      client: null,
      tools: [],
      busy: 0,
      idleTimer: null,
      closed: false,
      dialing: null,
      idleTimeoutMs: opts.idleTimeoutMs ?? 0,
    }
    pool.set(key, conn)
  }
  if (conn.dialing === null) {
    const attempt = dial(conn, entry, opts.baseCwd)
    conn.dialing = attempt
    attempt.catch(() => {}).finally(() => {
      if (conn.dialing === attempt) conn.dialing = null
    })
  }
  await conn.dialing
  if (conn.closed) throw new Error(`connection to ${entry.serverName} closed during connect`)
  return conn
}

async function dial(conn, entry, baseCwd) {
  const { client, tools, closed } = await connectAndList(entry, baseCwd, () => {
    // The server hung up: drop it so the next acquire re-dials.
    conn.closed = true
    clearIdle(conn)
    if (pool.get(conn.key) === conn) pool.delete(conn.key)
  })
  if (closed) {
    try { await client.close() } catch { /* best effort */ }
    conn.closed = true
    if (pool.get(conn.key) === conn) pool.delete(conn.key)
    throw new Error(`connection to ${entry.serverName} closed during connect`)
  }
  conn.client = client
  conn.tools = tools
  armIdle(conn)
  return conn
}

/** A session is done with the connection; it closes once idle. */
export function release(conn) {
  if (conn !== null && conn !== undefined) armIdle(conn)
}

/** Close and forget a pooled connection (config change, manual reconnect). */
export async function invalidate(key) {
  const conn = pool.get(key)
  if (conn === undefined) return
  pool.delete(key)
  conn.closed = true
  clearIdle(conn)
  try { await conn.client?.close() } catch { /* best effort */ }
}

/** Close and forget every pooled connection (plugin unload). */
export async function drainPool() {
  await Promise.all([...pool.keys()].map((key) => invalidate(key)))
}

export function poolStats() {
  return [...pool.values()].map((conn) => ({
    key: conn.key,
    serverName: conn.entry?.serverName ?? null,
    tools: conn.tools.length,
    busy: conn.busy,
    idle: conn.idleTimer !== null,
  }))
}

export function clearIdle(conn) {
  if (conn.idleTimer !== null) {
    clearTimeout(conn.idleTimer)
    conn.idleTimer = null
  }
}

/** (Re)start the idle close for a pooled connection with no work in flight. */
export function armIdle(conn) {
  clearIdle(conn)
  if (conn.busy > 0) return
  const timeout = conn.idleTimeoutMs
  if (!(timeout > 0)) return
  conn.idleTimer = setTimeout(() => {
    conn.idleTimer = null
    // A call may have started since: the caller's own finally will re-arm.
    if (conn.busy > 0) return
    void invalidate(conn.key)
  }, Math.min(timeout, MAX_TIMER_DELAY_MS))
  conn.idleTimer.unref?.()
}

/** Get the live connection for a record, connecting lazily when absent. */
export function ensureConnected(state, record) {
  if (record.conn !== null && !record.conn.closed) return Promise.resolve(record.conn)
  if (record.connecting === null) {
    const attempt = openConnection(state, record)
    record.connecting = attempt
    attempt.catch(() => {}).finally(() => {
      if (record.connecting === attempt) record.connecting = null
    })
  }
  return record.connecting
}

export async function openConnection(state, record) {
  const entry = record.entry
  const conn = await acquire(entry, {
    baseCwd: state.baseCwd,
    idleTimeoutMs: entry.idleTimeoutMs,
  })
  if (state.disposed || state.servers.get(serverKey(entry)) !== record) {
    release(conn)
    throw new Error(`agent disposed or config reloaded during connect`)
  }
  record.conn = conn
  return conn
}
