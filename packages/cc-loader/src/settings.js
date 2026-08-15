// settings.json discovery + scope merge for permission rules.
//
// CC scopes: managed > CLI > local > project > user. We discover user
// (~/.claude/settings.json), project (<root>/.claude/settings.json) and local
// (<root>/.claude/settings.local.json); managed is out of scope for now
// (reported, not enforced). Rules arrays are concatenated user → project →
// local; evaluation order deny → ask → allow is enforced by the evaluator,
// not by array order.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { findProjectRoot, pathExists, readTextSafe } from './skills.js'

/**
 * Discover the three settings files for a cwd.
 * @param {string} cwd
 * @param {{ homeDir?: string, projectRootMarkers?: string[] }} [opts]
 * @returns {Promise<{ projectRoot?: string, user?: Source, project?: Source, local?: Source }>}
 *   Source = { scope, path, data } or undefined when absent/unreadable.
 */
export async function discoverSettings(cwd, opts = {}) {
  const homeDir = opts.homeDir ?? homedir()
  const projectRoot = await findProjectRoot(cwd, opts.projectRootMarkers)
  const userPath = join(homeDir, '.claude', 'settings.json')
  const out = {}
  if (projectRoot !== undefined) {
    out.projectRoot = projectRoot
    const projectPath = join(projectRoot, '.claude', 'settings.json')
    const localPath = join(projectRoot, '.claude', 'settings.local.json')
    out.project = await readSource('project', projectPath)
    out.local = await readSource('local', localPath)
  }
  out.user = await readSource('user', userPath)
  return out
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
 * @returns {object} IR permissions component:
 *   { status, allow: Rule[], deny: Rule[], ask: Rule[], defaultMode,
 *     additionalDirectories: string[], disableBypassPermissionsMode,
 *     sources: Source[], warnings: string[] }
 */
export function mergeSettings(discovered) {
  const sources = [discovered.user, discovered.project, discovered.local].filter(Boolean)
  const warnings = []
  const perm = { allow: [], deny: [], ask: [], warnings, sources, defaultMode: undefined, additionalDirectories: [], disableBypassPermissionsMode: undefined }
  if (sources.length === 0) {
    perm.status = 'UNSUPPORTED' // no settings files → nothing to enforce
    return perm
  }
  for (const src of sources) {
    if (src.error !== undefined) {
      warnings.push(`settings ${src.path}: ${src.error}`)
      continue
    }
    const p = src.data.permissions
    if (p !== undefined && (typeof p !== 'object' || p === null || Array.isArray(p))) {
      warnings.push(`settings ${src.path}: permissions must be an object`)
      continue
    }
    if (p === undefined) continue
    for (const bucket of ['allow', 'deny', 'ask']) {
      const rules = p[bucket]
      if (rules === undefined) continue
      if (!Array.isArray(rules) || rules.some((r) => typeof r !== 'string')) {
        warnings.push(`settings ${src.path}: permissions.${bucket} must be an array of strings`)
        continue
      }
      for (const raw of rules) perm[bucket].push({ raw, scope: src.scope, path: src.path })
    }
    // defaultMode lives at the settings root (CC settings shape), while
    // additionalDirectories / disableBypassPermissionsMode live under permissions.
    if (typeof src.data.defaultMode === 'string') perm.defaultMode = src.data.defaultMode
    if (Array.isArray(p.additionalDirectories)) {
      perm.additionalDirectories.push(...p.additionalDirectories.filter((d) => typeof d === 'string'))
    }
    if (p.disableBypassPermissionsMode !== undefined) perm.disableBypassPermissionsMode = p.disableBypassPermissionsMode
  }
  perm.status = perm.deny.length + perm.ask.length + perm.allow.length > 0 ? 'DIRECT' : 'UNSUPPORTED'
  return perm
}
