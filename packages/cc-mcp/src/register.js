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
      const record = state.servers.get(entry.serverName)
      if (record === undefined) throw new Error(`server ${entry.serverName} is no longer configured — reload the project config`)
      const conn = await ensureConnected(state, record)
      conn.busy++
      try {
        armIdle(state, record, conn)
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
        armIdle(state, record, conn)
      }
    },
  }
}

// ─── connection lifecycle helpers (shared with the controller) ──────────────

const MAX_TIMER_DELAY_MS = 0x7fffffff

export function armIdle(state, record, conn) {
  clearIdle(conn)
  if (conn.busy > 0) return
  const timeout = record.entry.idleTimeoutMs
  if (timeout <= 0) return
  conn.idleTimer = setTimeout(() => {
    conn.idleTimer = null
    if (record.conn !== conn) return
    record.conn = null
    conn.client.close().catch(() => {})
  }, Math.min(timeout, MAX_TIMER_DELAY_MS))
  conn.idleTimer.unref?.()
}

export function clearIdle(conn) {
  if (conn.idleTimer !== null) {
    clearTimeout(conn.idleTimer)
    conn.idleTimer = null
  }
}

/** Get the live connection for a record, connecting lazily when absent. */
export function ensureConnected(state, record) {
  if (record.conn !== null) return Promise.resolve(record.conn)
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
  const conn = { client: null, idleTimer: null, busy: 0 }
  const { client, closed } = await connectAndList(entry, state.baseCwd, () => {
    if (record.conn === conn) {
      record.conn = null
      clearIdle(conn)
    }
  })
  conn.client = client
  if (state.disposed || state.servers.get(entry.serverName) !== record) {
    try { await client.close() } catch { /* best effort */ }
    throw new Error(`agent disposed or config reloaded during connect`)
  }
  record.conn = conn
  if (closed) {
    record.conn = null
    clearIdle(conn)
    try { await client.close() } catch { /* best effort */ }
    throw new Error(`connection closed during connect`)
  }
  armIdle(state, record, conn)
  return conn
}
