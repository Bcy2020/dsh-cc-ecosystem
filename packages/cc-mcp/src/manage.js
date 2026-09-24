// dsh-cc-mcp — management surface for the `/mcp` panel.
//
// This module owns everything the browser half needs and nothing that touches
// the MCP wire itself (that stays in register.js):
//
//   - the stable server identity used by the panel, the persisted
//     enable/disable set, and its JSON projections;
//   - the persisted enable/disable store (the ONLY file this plugin writes —
//     never a Claude Code config);
//   - the Connection RPC endpoint handler behind the `/cc-mcp` channel, which
//     DSH mounts behind its own Host/Origin fence and browser authentication;
//   - the plain-text report behind the `/mcp` host command (CLI + `/mcp <args>`).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** RPC channel the browser half calls (DSH requires /^\/[A-Za-z0-9._~-]+$/). */
export const RPC_CHANNEL = '/cc-mcp'

/** Largest accepted request body; the panel only ever sends small JSON. */
const MAX_BODY_BYTES = 4096

/** One request path segment: the endpoint name. */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Shape version of the persisted state file. */
export const STATE_VERSION = 1

/**
 * Default state-file location: `$DSH_HOME/cc-mcp-state.json`, falling back to
 * `~/.dsh/cc-mcp-state.json` when the environment does not set DSH_HOME.
 * @returns {string} absolute path
 */
export function defaultStatePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'cc-mcp-state.json')
}

/**
 * Identity of a host `@deepseek-ai/dsh-mcp-client` row. Disabling it hides the
 * row's tools for the current workspace only — the host row itself is untouched.
 * @param {string} serverName
 * @returns {string}
 */
export function hostKey(serverName) {
  return `host:${serverName}`
}

/**
 * Stable identity of one configured server. Project servers are unique per
 * project config, plugin servers per (plugin, server) pair, host rows per
 * server name — the same identity a disable decision must survive across
 * sessions and restarts.
 * @param {{serverName: string, pluginName?: string, hostRow?: boolean}} entry
 * @returns {string}
 */
export function serverKey(entry) {
  if (entry.hostRow === true) return hostKey(entry.serverName)
  return entry.pluginName
    ? `plugin:${entry.pluginName}:${entry.serverName}`
    : `project:${entry.serverName}`
}

/**
 * Transport label used by the panel's Type column.
 * @param {object} entry
 * @returns {string}
 */
export function transportOf(entry) {
  const raw = typeof entry.transport === 'string' && entry.transport !== ''
    ? entry.transport
    : typeof entry.url === 'string' && entry.url !== ''
      ? 'http'
      : typeof entry.command === 'string' && entry.command !== ''
        ? 'stdio'
        : 'unknown'
  return raw === 'streamable-http' || raw === 'streamableHttp' ? 'http' : raw
}

/** One JSON-safe server row for the panel. */
export function serverEntry(record) {
  const tools = Array.isArray(record.tools) ? record.tools : []
  const scope = record.entry.hostRow === true ? 'host' : record.entry.pluginName ? 'plugin' : 'project'
  return {
    key: record.key,
    serverName: record.entry.serverName,
    pluginName: record.entry.pluginName ?? null,
    scope,
    transport: transportOf(record.entry),
    source: record.source ?? null,
    status: record.status,
    disabled: record.status === 'disabled',
    // A host row the host layer itself connected (managed false) is listed and
    // hidden/enabled here, but not re-registered by this plugin; a row this
    // plugin adopted on demand is managed true.
    managed: record.managed === true,
    adoptable: record.adoptable === true,
    rowId: record.entry.rowId ?? null,
    toolPrefix: record.toolPrefix ?? null,
    toolCount: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      rawName: tool.rawName,
      description: typeof tool.description === 'string' ? tool.description : '',
    })),
    error: record.error ?? null,
    updatedAt: record.updatedAt ?? null,
  }
}

/** Panel row order: project servers, then plugin servers, then host rows. */
const SCOPE_ORDER = { project: 0, plugin: 1, host: 2 }

/** Sort servers by scope, then name — the panel's stable row order. */
function compareServers(left, right) {
  const byScope = (SCOPE_ORDER[left.scope] ?? 3) - (SCOPE_ORDER[right.scope] ?? 3)
  if (byScope !== 0) return byScope
  return left.serverName.localeCompare(right.serverName)
}

/**
 * JSON snapshot of one session's MCP surface.
 * @param {object} state - the per-agent controller.
 * @returns {object}
 */
export function snapshotOf(state) {
  const servers = [...state.servers.values()].map(serverEntry).sort(compareServers)
  return {
    sessionId: String(state.agent.id),
    known: true,
    projectRoot: state.projectRoot ?? null,
    sources: [...(state.sources ?? [])],
    checked: state.checked === true,
    servers,
  }
}

/**
 * Snapshot for a session that has no live agent (or none this plugin wired):
 * the panel renders its empty state from this instead of an error.
 * @param {unknown} sessionId
 * @returns {object}
 */
export function unknownSnapshot(sessionId) {
  return {
    sessionId: sessionId === undefined || sessionId === null ? null : String(sessionId),
    known: false,
    projectRoot: null,
    sources: [],
    checked: true,
    servers: [],
  }
}

/**
 * Failures from the most recent check pass, in panel order.
 * @param {object} state
 * @returns {Array<{key: string, serverName: string, error: string}>}
 */
export function failuresOf(state) {
  return [...state.servers.values()]
    .filter((record) => record.status === 'error' && typeof record.error === 'string' && record.error !== '')
    .map((record) => ({ key: record.key, serverName: record.entry.serverName, error: record.error }))
    .sort((left, right) => left.serverName.localeCompare(right.serverName))
}

/**
 * Persisted enable/disable decisions. One JSON file, written atomically
 * (temp file + rename) and only when a decision actually changes.
 * @param {{path: string, log?: (level: string, message: string) => void}} options
 */
export function createDisabledStore(options) {
  const path = options.path
  const log = options.log ?? (() => {})
  let disabled = new Set()
  let writeChain = Promise.resolve()

  async function persist() {
    const payload = `${JSON.stringify({ version: STATE_VERSION, disabled: [...disabled].sort() }, null, 2)}\n`
    const temp = `${path}.tmp-${process.pid}`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, payload, 'utf8')
    await rename(temp, path)
  }

  return {
    path,
    /** Read the file once; a missing or malformed file is an empty set, not a failure. */
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        const list = Array.isArray(parsed?.disabled) ? parsed.disabled : []
        disabled = new Set(list.filter((key) => typeof key === 'string' && key !== ''))
      } catch (error) {
        if (error?.code !== 'ENOENT') log('warn', `state file ${path} unreadable: ${String(error)} — starting empty`)
        disabled = new Set()
      }
      return [...disabled]
    },
    has(key) {
      return disabled.has(key)
    },
    list() {
      return [...disabled].sort()
    },
    /**
     * Record one decision, persisting only a real change.
     * @returns {Promise<boolean>} whether the stored set changed.
     */
    async set(key, value) {
      const changed = value === true ? !disabled.has(key) : disabled.has(key)
      if (value === true) disabled.add(key)
      else disabled.delete(key)
      if (changed) {
        writeChain = writeChain.then(persist, persist).catch((error) => {
          log('error', `could not persist ${path}: ${String(error)}`)
        })
        await writeChain
      }
      return changed
    },
  }
}

/** `{ok:true,value}` success envelope for the Connection RPC transport. */
export function rpcOk(value) {
  return { ok: true, value }
}

/** `{ok:false,error}` failure envelope; `details` must be a record. */
export function rpcFail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/** One status word + qualifier for the text report. */
function statusText(entry) {
  switch (entry.status) {
    case 'ready': return `connected · ${entry.toolCount} tool(s)`
    case 'disabled': return 'disabled — tools are not in the model context'
    case 'skipped': return 'provided by a host MCP client'
    case 'checking': return 'checking…'
    default: return 'not connected'
  }
}

/**
 * Plain-text report for the `/mcp` host command (CLI and `/mcp <args>`).
 * @param {object} snapshot
 * @returns {string}
 */
export function formatTextReport(snapshot) {
  const lines = [
    `MCP servers (${snapshot.servers.length}) — ${snapshot.projectRoot ?? 'no project root resolved'}`,
  ]
  if (snapshot.servers.length === 0) {
    lines.push('  (no MCP server configured for this session)')
  }
  for (const entry of snapshot.servers) {
    const mark = entry.status === 'ready' ? '✓' : entry.status === 'disabled' ? '–' : entry.status === 'skipped' ? '»' : '✗'
    lines.push(`  ${mark} ${entry.serverName} [${entry.scope}/${entry.transport}] ${statusText(entry)}`)
    if (entry.error !== null && entry.error !== undefined && entry.error !== '') {
      lines.push(`      ${entry.error}`)
    }
  }
  lines.push('Open the interactive panel with /mcp in the Web GUI.')
  return lines.join('\n')
}

// ─── plugin-owned HTTP transport ────────────────────────────────────────────
//
// The panel talks to this plugin over a route the plugin registers on the
// host's `webServer` service — the same pattern the shipped marketplace plugin
// uses (`ctx.inject(['webServer'], …) → hostCtx.webServer.register(…)`).
// The generic `connection` RPC service is NOT visible to a profile-level
// plugin, so it cannot carry this panel's traffic.

/** One JSON response with no caching. */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** True when the request's Origin matches its Host — required on every POST. */
function sameOrigin(request) {
  const origin = request.headers?.origin
  const host = request.headers?.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a JSON request body, rejecting anything over the cap. */
async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Build the `webServer` handler for the plugin's channel.
 * @param {{dispatch: (endpoint: string, payload: object) => Promise<object>, log?: Function}} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRouteHandler(options) {
  const dispatch = options.dispatch
  const log = options.log ?? (() => {})
  return async function handle(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const endpoint = url.pathname.startsWith(`${RPC_CHANNEL}/`)
        ? url.pathname.slice(RPC_CHANNEL.length + 1)
        : ''
      if (endpoint === '' || !ENDPOINT_PATTERN.test(endpoint)) {
        sendJson(response, 404, rpcFail('cc-mcp/unknown-endpoint', `unknown endpoint ${JSON.stringify(url.pathname)}`))
        return
      }
      const method = request.method ?? 'GET'
      if (method !== 'GET' && method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }
      if (method === 'POST' && !sameOrigin(request)) {
        sendJson(response, 403, rpcFail('cc-mcp/untrusted-origin', 'the request Origin does not match its Host'))
        return
      }
      let payload = {}
      if (method === 'POST') {
        try {
          payload = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, rpcFail('cc-mcp/bad-request', error instanceof Error ? error.message : String(error)))
          return
        }
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) payload = {}
      sendJson(response, 200, await dispatch(endpoint, payload))
    } catch (error) {
      log('error', `management request failed: ${String(error)}`)
      try {
        sendJson(response, 500, rpcFail('cc-mcp/internal', error instanceof Error ? error.message : String(error)))
      } catch {
        /* the response is already gone; nothing left to report to */
      }
    }
  }
}
