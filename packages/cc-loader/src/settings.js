// settings.json discovery + scope merge for permission rules.
//
// Locations are FIXED, not searched: user settings live in the user config dir,
// project/local settings in `<cwd>/.claude/` — CC resolves the latter against
// the session cwd, never against an ancestor (module-0045.js:11331 → `ue(n.cwd)`).
// Running from a subdirectory therefore does NOT pick up the repository root's
// settings; that is CC's behaviour, copied rather than improved on.
//
// Precedence for scalar keys follows CC: managed > CLI > local > project > user.
// Managed/policy settings live in OS-specific locations and are out of scope
// here (reported, not enforced); rule arrays are concatenated in discovery
// order and evaluation order deny → ask → allow is the evaluator's business.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathExists, readTextSafe, settingsPaths } from './scopes.js'

/** Settings scopes in CC precedence order, most specific first. */
export const SETTINGS_PRECEDENCE = ['local', 'project', 'user']

/**
 * Discover the settings files for a cwd.
 * @param {string} cwd
 * @param {{ homeDir?: string, globalClaudeDir?: string }} [opts]
 * @returns {Promise<{ cwd: string, user?: Source, project?: Source, local?: Source }>}
 *   Source = { scope, path, data } or undefined when absent/unreadable.
 */
export async function discoverSettings(cwd, opts = {}) {
  const homeDir = opts.homeDir ?? homedir()
  const paths = settingsPaths(cwd, { homeDir, globalClaudeDir: opts.globalClaudeDir })
  return {
    cwd,
    user: await readSource('user', paths.user),
    project: await readSource('project', paths.project),
    local: await readSource('local', paths.local),
  }
}

async function readSource(scope, path) {
  if (!(await pathExists(path))) return undefined
  const raw = await readTextSafe(path)
  if (raw === undefined) return undefined
  let data
  try { data = JSON.parse(raw) } catch (error) {
    return { scope, path, data: null, error: `invalid JSON: ${String(error)}` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { scope, path, data: null, error: 'settings root must be an object' }
  }
  return { scope, path, data }
}

/**
 * Merge discovered settings into one permissions IR block.
 * Rule arrays are concatenated across scopes; each rule keeps its source scope.
 * Scalar keys resolve by CC precedence (local > project > user).
 * @returns {object} IR permissions component:
 *   { status, allow: Rule[], deny: Rule[], ask: Rule[], defaultMode,
 *     additionalDirectories: string[], disableBypassPermissionsMode,
 *     model, env, statusLine, outputStyle, enableAllProjectMcpServers,
 *     enabledMcpjsonServers: string[], disabledMcpjsonServers: string[],
 *     sources: Source[], warnings: string[] }
 *
 * The extra keys (model/env/statusLine/outputStyle and the MCP approval flags)
 * are parsed into the IR for the compatibility report only — this is a
 * read-only bridge and DSH never rewrites .claude. `model` maps to a
 * default-model hint; `enableAllProjectMcpServers` / `enabledMcpjsonServers` /
 * `disabledMcpjsonServers` are the `.mcp.json` approval gate CC applies to
 * project-scope servers (see cc-permissions), surfaced to adapters, never forced.
 */
export function mergeSettings(discovered) {
  const sources = [discovered.user, discovered.project, discovered.local].filter(Boolean)
  const warnings = []
  const perm = {
    allow: [], deny: [], ask: [], warnings, sources,
    defaultMode: undefined, additionalDirectories: [], disableBypassPermissionsMode: undefined,
    model: undefined, env: undefined, statusLine: undefined, outputStyle: undefined,
    enableAllProjectMcpServers: undefined,
    enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  }
  if (sources.length === 0) {
    perm.status = 'UNSUPPORTED' // no settings files → nothing to enforce
    return perm
  }
  // Scalars resolve by precedence, so the most specific scope must be visited
  // first; the arrays below are order-independent.
  const byScope = new Map(sources.map((s) => [s.scope, s]))
  for (const src of sources) {
    if (src.error !== undefined) warnings.push(`settings ${src.path}: ${src.error}`)
  }
  for (const scope of SETTINGS_PRECEDENCE) {
    const src = byScope.get(scope)
    if (src === undefined || src.error !== undefined) continue
    // defaultMode lives at the settings root (CC settings shape).
    if (perm.defaultMode === undefined && typeof src.data.defaultMode === 'string') perm.defaultMode = src.data.defaultMode
    // Report-only keys (read-only bridge; parsed for the compatibility report).
    if (perm.model === undefined && typeof src.data.model === 'string') perm.model = src.data.model
    if (perm.env === undefined && isPlainObject(src.data.env)) perm.env = { ...src.data.env }
    if (perm.statusLine === undefined && isPlainObject(src.data.statusLine)) perm.statusLine = { ...src.data.statusLine }
    if (perm.outputStyle === undefined && typeof src.data.outputStyle === 'string') perm.outputStyle = src.data.outputStyle
    if (perm.enableAllProjectMcpServers === undefined && src.data.enableAllProjectMcpServers !== undefined) {
      perm.enableAllProjectMcpServers = src.data.enableAllProjectMcpServers
    }
    if (perm.disableBypassPermissionsMode === undefined && src.data.permissions?.disableBypassPermissionsMode !== undefined) {
      perm.disableBypassPermissionsMode = src.data.permissions.disableBypassPermissionsMode
    }
  }
  for (const src of sources) {
    if (src.error !== undefined) continue
    const p = src.data.permissions
    if (p !== undefined && !isPlainObject(p)) {
      warnings.push(`settings ${src.path}: permissions must be an object`)
      continue
    }
    if (p !== undefined) {
      for (const bucket of ['allow', 'deny', 'ask']) {
        const rules = p[bucket]
        if (rules === undefined) continue
        if (!Array.isArray(rules) || rules.some((r) => typeof r !== 'string')) {
          warnings.push(`settings ${src.path}: permissions.${bucket} must be an array of strings`)
          continue
        }
        for (const raw of rules) perm[bucket].push({ raw, scope: src.scope, path: src.path })
      }
      if (Array.isArray(p.additionalDirectories)) {
        perm.additionalDirectories.push(...p.additionalDirectories.filter((d) => typeof d === 'string'))
      }
    }
    // `.mcp.json` approval lists (CC: top-level settings keys, arrays of names).
    for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
      const list = src.data[key]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.some((n) => typeof n !== 'string')) {
        warnings.push(`settings ${src.path}: ${key} must be an array of strings`)
        continue
      }
      perm[key].push(...list)
    }
  }
  perm.status = perm.deny.length + perm.ask.length + perm.allow.length > 0 ? 'DIRECT' : 'UNSUPPORTED'
  return perm
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
