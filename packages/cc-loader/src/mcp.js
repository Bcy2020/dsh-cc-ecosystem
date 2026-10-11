// dsh-cc-loader — MCP server discovery across Claude Code's scopes.
//
// CC resolves MCP config from five scopes (module-0316.js:61325) and looks a
// server up in this order (module-0316.js:61328):
//
//   enterprise > managed > local > project > user
//
// We read three of them. Enterprise (`managed-mcp.json`) and managed (managed
// settings) live in organisation-controlled system locations that DSH has no
// business reading:
//
//   user      ~/.claude.json top-level `mcpServers`            (:61362)
//   local     ~/.claude.json `projects[<key>].mcpServers`      (:61368)
//   project   every ancestor's `.mcp.json`, cwd → filesystem    (:61340)
//             root (the root itself excluded), the nearest file
//             assigning last so it WINS a name clash
//   plugin    plugin.json / plugin .mcp.json inline            (plugin.js)
//
// Every server is tagged with where it came from, in CC's own vocabulary:
// `scope`, `declaredIn`, `pluginSource`, `pluginPath`, `configError`,
// `configErrorReason` (CC's pick list, module-1115.js:9374). `declaredIn` is
// the session cwd for project and local, exactly as CC's annotator `bne`
// (module-0316.js:60617) sets it, so a server that was read for a different
// directory can be labelled "inherited from …".
//
// Pure parse: nothing is written, and env values are NEVER inlined —
// `${NAME}` placeholders are kept verbatim and the names they reference are
// recorded (envNames) for the adapter to bind at runtime.
//
// Classification (same vocabulary as the rest of the loader):
//   DIRECT      — stdio (command) and http (url) transports DSH can bridge
//   UNSUPPORTED — sse / ws transports the DSH MCP client does not speak
//   INVALID     — shape errors (skipped with a warning, never fatal)

import { join } from 'node:path'
import { fullAncestors, pathExists, readClaudeJsonScopes, readTextSafe } from './scopes.js'
import { STATUS } from './classify.js'

/** CC server names are simple identifiers; same bound as dsh-mcp-client. */
export const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** Environment placeholders CC expands: ${NAME}. */
export const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** CC's MCP lookup precedence, most authoritative first (:61328). */
export const MCP_SCOPE_PRECEDENCE = ['enterprise', 'managed', 'local', 'project', 'user']

/** Scopes whose servers need the `.mcp.json` approval gate — project only (:61405). */
export const GATED_MCP_SCOPE = 'project'

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
 * Normalize one servers map into ordered, classified server entries, tagged
 * with the scope they were read from.
 * Invalid entries are skipped with warnings (never thrown).
 * @param {Record<string, unknown>} servers - raw map from parseMcpText
 * @param {object} [opts] - { scope?, declaredIn?, sourcePath?, pluginName?,
 *   pluginSource?, pluginPath?, warn? }
 * @returns {object[]} entries, each:
 *   { serverName, scope?, declaredIn?, sourcePath?, pluginName?,
 *     transport: 'stdio'|'http'|'sse'|'ws', command?, args?, cwd?,
 *     env (placeholders kept), envNames: string[], url?, headers?,
 *     toolCallTimeoutMs?, idleTimeoutMs?, override?, status, reason? }
 */
export function serverEntries(servers, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const entries = []
  for (const [serverName, raw] of Object.entries(servers)) {
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
      serverName,
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.declaredIn !== undefined ? { declaredIn: opts.declaredIn } : {}),
      ...(opts.sourcePath !== undefined ? { sourcePath: opts.sourcePath } : {}),
      ...(opts.pluginName !== undefined ? { pluginName: opts.pluginName } : {}),
      ...(opts.pluginSource !== undefined ? { pluginSource: opts.pluginSource } : {}),
      ...(opts.pluginPath !== undefined ? { pluginPath: opts.pluginPath } : {}),
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
 * @param {string} dir - a project directory or a plugin root
 * @param {object} [opts] - { scope?, declaredIn?, pluginName?, pluginSource?,
 *   pluginPath?, includePluginJson?, warn? }
 * @returns {Promise<{ servers: object[], sources: string[], warnings: string[] }>}
 */
export async function discoverMcpConfig(dir, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const includePluginJson = opts.includePluginJson !== false
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }
  const sources = []
  const servers = []
  const tag = {
    scope: opts.scope,
    declaredIn: opts.declaredIn,
    pluginName: opts.pluginName,
    pluginSource: opts.pluginSource,
    pluginPath: opts.pluginPath,
    warn: localWarn,
  }

  const mcpPath = join(dir, '.mcp.json')
  if (await pathExists(mcpPath)) {
    const text = await readTextSafe(mcpPath)
    if (text === undefined) {
      warnings.push(`cannot read ${mcpPath}`)
      warn(`cannot read ${mcpPath}`)
    } else {
      try {
        const map = parseMcpText(text)
        servers.push(...serverEntries(map, { ...tag, sourcePath: mcpPath }))
        sources.push(mcpPath)
      } catch (error) {
        warnings.push(`${mcpPath}: ${error.message}`)
        warn(`${mcpPath}: ${error.message}`)
      }
    }
  }

  const pluginJsonPath = join(dir, 'plugin.json')
  if (includePluginJson && await pathExists(pluginJsonPath)) {
    const text = await readTextSafe(pluginJsonPath)
    if (text === undefined) {
      warnings.push(`cannot read ${pluginJsonPath}`)
      warn(`cannot read ${pluginJsonPath}`)
    } else {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        warnings.push(`${pluginJsonPath}: invalid JSON: ${error.message}`)
        warn(`${pluginJsonPath}: invalid JSON: ${error.message}`)
      }
      if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null && !Array.isArray(parsed.mcpServers)) {
        servers.push(...serverEntries(parsed.mcpServers, { ...tag, sourcePath: pluginJsonPath }))
        sources.push(pluginJsonPath)
      }
    }
  }

  return { servers, sources, warnings }
}

/**
 * Project scope: every ancestor's `.mcp.json`, cwd → filesystem root (the root
 * itself excluded), nearest file last so it WINS a name clash — CC's
 * `h.reverse()` + `Object.assign` (:61347-61356).
 *
 * `declaredIn` is the session cwd, not the file's directory: that is what CC's
 * annotator records, and it is what makes "inherited from <other dir>"  meaningful
 * when the same server list is shown for a different directory.
 * @param {string} cwd
 * @param {{ warn?: (m: string) => void }} [opts]
 * @returns {Promise<{ servers: object[], sources: string[], warnings: string[] }>}
 */
export async function discoverProjectMcp(cwd, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }
  const sources = []
  const byName = new Map()
  for (const dir of fullAncestors(cwd).reverse()) {
    const path = join(dir, '.mcp.json')
    if (!(await pathExists(path))) continue
    const text = await readTextSafe(path)
    if (text === undefined) {
      warnings.push(`cannot read ${path}`)
      warn(`cannot read ${path}`)
      continue
    }
    let map
    try {
      map = parseMcpText(text)
    } catch (error) {
      warnings.push(`${path}: ${error.message}`)
      warn(`${path}: ${error.message}`)
      continue
    }
    sources.push(path)
    for (const entry of serverEntries(map, { scope: 'project', declaredIn: cwd, sourcePath: path, warn: localWarn })) {
      byName.set(entry.serverName, entry) // nearest assigns last → wins
    }
  }
  return { servers: [...byName.values()], sources, warnings }
}

/**
 * The two file scopes inside `~/.claude.json`: `user` (top level) and `local`
 * (`projects[<key>]`, key = git root or, outside a repository, the parent of
 * cwd — see scopes.js).
 * @param {string} cwd
 * @param {{ homeDir?: string, gitRoot?: string, claudeJsonPath?: string, warn? }} [opts]
 * @returns {Promise<{ servers: object[], sources: string[], warnings: string[], present: boolean, key: string }>}
 */
export async function discoverClaudeJsonMcp(cwd, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }
  const found = await readClaudeJsonScopes(cwd, opts)
  if (found.error !== undefined) {
    warnings.push(`${found.path}: ${found.error}`)
    warn(`${found.path}: ${found.error}`)
  }
  const servers = []
  const sources = []
  if (found.user !== undefined) {
    servers.push(...serverEntries(found.user, { scope: 'user', sourcePath: found.path, warn: localWarn }))
    sources.push(found.path)
  }
  if (found.local !== undefined) {
    const label = `${found.path} (projects["${found.key}"])`
    servers.push(...serverEntries(found.local, { scope: 'local', declaredIn: cwd, sourcePath: label, warn: localWarn }))
    sources.push(label)
  }
  return { servers, sources, warnings, present: found.present, key: found.key }
}

/**
 * All scopes we read, in one call: user + local (`~/.claude.json`) and project
 * (every ancestor's `.mcp.json`).
 *
 * `servers` holds the EFFECTIVE set — one entry per name, the winner by CC's
 * lookup precedence. Entries that lost a name clash are kept in `shadowed` so
 * the UI can say why a server the user wrote down is not the one in use.
 *
 * @returns {Promise<{ servers: object[], shadowed: object[], byScope: object,
 *   sources: string[], warnings: string[], claudeJson: object }>}
 */
export async function discoverMcpScopes(cwd, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }
  const collected = []

  const fromJson = await discoverClaudeJsonMcp(cwd, { ...opts, warn: localWarn })
  warnings.push(...fromJson.warnings)
  collected.push(...fromJson.servers)

  let project = { servers: [], sources: [], warnings: [] }
  if (opts.enableProject !== false) {
    project = await discoverProjectMcp(cwd, { warn: localWarn })
    warnings.push(...project.warnings)
    collected.push(...project.servers)
  }

  const servers = []
  const shadowed = []
  for (const name of new Set(collected.map((e) => e.serverName))) {
    const candidates = collected.filter((e) => e.serverName === name)
    const winner = resolveMcpServer(candidates, name)
    servers.push(winner)
    shadowed.push(...candidates.filter((e) => e !== winner))
  }
  // Stable output order: precedence first, then read order within a scope.
  servers.sort((a, b) => MCP_SCOPE_PRECEDENCE.indexOf(a.scope) - MCP_SCOPE_PRECEDENCE.indexOf(b.scope))

  return {
    servers,
    shadowed,
    byScope: {
      user: collected.filter((e) => e.scope === 'user'),
      local: collected.filter((e) => e.scope === 'local'),
      project: collected.filter((e) => e.scope === 'project'),
    },
    sources: [...new Set([...fromJson.sources, ...project.sources])],
    warnings,
    claudeJson: { present: fromJson.present, key: fromJson.key },
  }
}

/**
 * CC's lookup precedence (:61411): the first scope in precedence order that
 * defines `name` wins.
 */
export function resolveMcpServer(entries, name) {
  for (const scope of MCP_SCOPE_PRECEDENCE) {
    const hit = entries.find((e) => e.serverName === name && e.scope === scope)
    if (hit !== undefined) return hit
  }
  return entries[0]
}

/**
 * The `.mcp.json` approval state for one server name — CC's `gLe`
 * (module-0316.js:60523), applied only to project scope by `FXt` (:61405).
 *
 * This reports CC's three states; it does not decide anything by itself. Note
 * that cc-permissions deliberately reads only `rejected` as blocking — CC also
 * blocks `pending`, but CC prompts for approval interactively and DSH does not,
 * so `pending` is default-open here. Only a project `.mcp.json` that names the
 * server in `disabledMcpjsonServers` loses its tools; see
 * cc-permissions/src/index.js for the policy and why it deviates.
 *
 * @param {string} name
 * @param {{ enabledMcpjsonServers?: string[], disabledMcpjsonServers?: string[],
 *   enableAllProjectMcpServers?: boolean } | undefined} permissions
 * @returns {'approved' | 'rejected' | 'pending'}
 */
export function projectMcpApproval(name, permissions) {
  if (permissions?.disabledMcpjsonServers?.includes(name) === true) return 'rejected'
  if (permissions?.enabledMcpjsonServers?.includes(name) === true) return 'approved'
  if (permissions?.enableAllProjectMcpServers === true) return 'approved'
  return 'pending'
}
