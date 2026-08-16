// dsh-cc-loader — MCP server config discovery (.mcp.json / plugin.json inline).
//
// Claude Code surfaces MCP servers in three places, all sharing the mcpServers
// JSON shape used by Cursor and VS Code:
//   1. Project root .mcp.json            — { "mcpServers": { "<name>": {...} } }
//   2. Plugin root .mcp.json             — official plugin form is a BARE server
//      map { "<name>": {...} }; community plugins also wrap in mcpServers
//   3. plugin.json inline                — { ..., "mcpServers": { "<name>": {...} } }
//
// This module accepts BOTH the bare-map and the mcpServers-wrapped forms
// everywhere (detected structurally), so the same code covers project and
// plugin sources. It is a pure parse layer: nothing is written, env values
// are NEVER inlined — `${NAME}` placeholders are kept verbatim and the names
// they reference are recorded (envNames) for the adapter to bind at runtime.
//
// Classification (same vocabulary as the rest of the loader):
//   DIRECT      — stdio (command) and http (url) transports DSH can bridge
//   UNSUPPORTED — sse / ws transports the DSH MCP client does not speak
//   INVALID     — shape errors (skipped with a warning, never fatal)

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathExists } from './skills.js'
import { STATUS } from './classify.js'

/** CC server names are simple identifiers; same bound as dsh-mcp-client. */
export const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** Environment placeholders CC expands: ${NAME}. */
export const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Parse .mcp.json text into the raw servers map, accepting both forms:
 *   { "mcpServers": {...} }  (wrapped; project-level + community plugins)
 *   { "<name>": {...} }      (bare; official plugin form)
 * @returns {Record<string, unknown>} servers map
 * @throws {Error} invalid JSON / missing map
 */
export function parseMcpText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config must be a JSON object')
  }
  if (typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null && !Array.isArray(parsed.mcpServers)) {
    return parsed.mcpServers
  }
  // Bare map form: every value is a server config object (no "mcpServers" key).
  const values = Object.values(parsed)
  if (values.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error('expected "mcpServers" object or a bare server map')
  }
  return parsed
}

/**
 * Normalize one servers map into ordered, classified server entries.
 * Invalid entries are skipped with warnings (never thrown).
 * @param {Record<string, unknown>} servers - raw map from parseMcpText
 * @param {object} [opts] - { pluginName?, warn? }
 * @returns {object[]} entries, each:
 *   { serverName, pluginName?, transport: 'stdio'|'http'|'sse'|'ws',
 *     command?, args?, cwd?, env (placeholders kept), envNames: string[],
 *     url?, headers?, toolCallTimeoutMs?, idleTimeoutMs?, override?,
 *     status, reason? }
 */
export function serverEntries(servers, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const entries = []
  for (const [serverName, raw] of Object.entries(servers)) {
    const base = { serverName, pluginName: opts.pluginName }
    if (!VALID_SERVER_NAME.test(serverName)) {
      warn(`MCP server name ${JSON.stringify(serverName)} invalid (need 1-32 of [A-Za-z0-9_-]) — skipped`)
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      warn(`MCP server ${serverName}: config must be an object — skipped`)
      continue
    }
    const hasCommand = typeof raw.command === 'string' && raw.command.length > 0
    const hasUrl = typeof raw.url === 'string' && raw.url.length > 0
    if (hasCommand && hasUrl) {
      warn(`MCP server ${serverName}: provide exactly one of "command" (stdio) or "url" (remote) — skipped`)
      continue
    }
    if (!hasCommand && !hasUrl) {
      warn(`MCP server ${serverName}: missing both "command" and "url" — skipped`)
      continue
    }
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined
    let transport
    if (hasCommand) transport = 'stdio'
    else if (type === 'sse') transport = 'sse'
    else if (type === 'ws' || type === 'websocket') transport = 'ws'
    else transport = 'http' // url without type, or type http → streamable-http

    // env: keep placeholders verbatim, record referenced names only.
    const env = {}
    const envNames = []
    if (raw.env !== undefined) {
      if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
        warn(`MCP server ${serverName}: env must be an object — skipped`)
        continue
      }
      for (const [k, v] of Object.entries(raw.env)) {
        const value = String(v)
        env[k] = value
        for (const match of value.matchAll(ENV_PLACEHOLDER)) {
          if (!envNames.includes(match[1])) envNames.push(match[1])
        }
      }
    }
    const headers = {}
    if (raw.headers !== undefined) {
      if (typeof raw.headers !== 'object' || raw.headers === null || Array.isArray(raw.headers)) {
        warn(`MCP server ${serverName}: headers must be an object — skipped`)
        continue
      }
      for (const [k, v] of Object.entries(raw.headers)) headers[k] = String(v)
    }

    const entry = {
      ...base,
      transport,
      command: hasCommand ? raw.command : undefined,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      cwd: typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : undefined,
      env,
      envNames,
      url: hasUrl ? raw.url : undefined,
      headers,
      toolCallTimeoutMs: Number.isFinite(raw.toolCallTimeoutMs) ? raw.toolCallTimeoutMs : undefined,
      idleTimeoutMs: Number.isFinite(raw.idleTimeoutMs) ? raw.idleTimeoutMs : undefined,
      override: raw.override === true,
      status: transport === 'stdio' || transport === 'http' ? STATUS.DIRECT : STATUS.UNSUPPORTED,
      reason: transport === 'stdio' || transport === 'http' ? undefined
        : `transport "${transport}" is not supported by the DSH MCP client (stdio/streamable-http only)`,
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Discover MCP config from one directory: `.mcp.json` first, then plugin.json
 * inline `mcpServers` (unless opts.includePluginJson === false). Both parse
 * under the same dual-form parser.
 * @param {string} dir - project root or plugin root
 * @param {object} [opts] - { pluginName?, includePluginJson?, warn? }
 * @returns {Promise<{ servers: object[], sources: string[], warnings: string[] }>}
 */
export async function discoverMcpConfig(dir, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const includePluginJson = opts.includePluginJson !== false
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }
  const sources = []
  const servers = []

  const mcpPath = join(dir, '.mcp.json')
  if (await pathExists(mcpPath)) {
    let text
    try {
      text = await readFile(mcpPath, 'utf8')
    } catch (error) {
      warnings.push(`cannot read ${mcpPath}: ${String(error)}`)
      warn(`cannot read ${mcpPath}: ${String(error)}`)
    }
    if (text !== undefined) {
      try {
        const map = parseMcpText(text)
        servers.push(...serverEntries(map, { pluginName: opts.pluginName, warn: localWarn }))
        sources.push(mcpPath)
      } catch (error) {
        warnings.push(`${mcpPath}: ${error.message}`)
        warn(`${mcpPath}: ${error.message}`)
      }
    }
  }

  const pluginJsonPath = join(dir, 'plugin.json')
  if (includePluginJson && await pathExists(pluginJsonPath)) {
    let text
    try {
      text = await readFile(pluginJsonPath, 'utf8')
    } catch (error) {
      warnings.push(`cannot read ${pluginJsonPath}: ${String(error)}`)
      warn(`cannot read ${pluginJsonPath}: ${String(error)}`)
    }
    if (text !== undefined) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        warnings.push(`${pluginJsonPath}: invalid JSON: ${error.message}`)
        warn(`${pluginJsonPath}: invalid JSON: ${error.message}`)
      }
      if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null && !Array.isArray(parsed.mcpServers)) {
        servers.push(...serverEntries(parsed.mcpServers, { pluginName: opts.pluginName, warn: localWarn }))
        sources.push(pluginJsonPath)
      }
    }
  }

  return { servers, sources, warnings }
}

/**
 * Project-level MCP: `<projectRoot>/.mcp.json` (plugin.json is a
 * plugin-package concern, excluded here).
 * @returns {Promise<{ servers: object[], sources: string[], warnings: string[] }>}
 */
export async function discoverProjectMcp(projectRoot, opts = {}) {
  return discoverMcpConfig(projectRoot, { ...opts, includePluginJson: false })
}
