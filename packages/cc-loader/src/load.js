// loadClaude: assemble the full IR from a cwd (project + global .claude).

import { homedir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot, collectClaudeDir, discoverRules } from './skills.js'
import { discoverSettings, mergeSettings } from './settings.js'
import { parseRulesFor, removedToolNames, classifyComponents } from './classify.js'
import { STATUS } from './classify.js'

/**
 * Load Claude Code `.claude/` assets (project + optional global ~/.claude)
 * into a standalone IR. Pure parse: no writes, no side effects beyond reads.
 * @param {object} [opts]
 * @param {string} opts.cwd - session workspace (project root discovery starts here).
 * @param {string} [opts.homeDir]
 * @param {string[]} [opts.projectRootMarkers]
 * @param {boolean} [opts.enableGlobal=true]
 * @param {string} [opts.globalClaudeDir]
 * @param {number} [opts.projectSkillRank=150]
 * @param {number} [opts.globalSkillRank=160]
 * @returns {Promise<object>} IR { cwd, projectRoot, components, warnings, report }
 */
export async function loadClaude(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const homeDir = opts.homeDir ?? homedir()
  const markers = opts.projectRootMarkers ?? ['.git']
  const projectSkillRank = opts.projectSkillRank ?? 150
  const globalSkillRank = opts.globalSkillRank ?? 160
  const warnings = []

  const projectRoot = await findProjectRoot(cwd, markers)
  const skills = []
  const commands = []
  const rules = []

  if (projectRoot !== undefined) {
    const claudeDir = join(projectRoot, '.claude')
    const dir = await collectClaudeDir(claudeDir, 'project-claude', projectSkillRank, warnings)
    skills.push(...dir.skills)
    commands.push(...dir.commands)
    rules.push(...await discoverRules(join(claudeDir, 'rules'), 'project'))
  }

  if (opts.enableGlobal !== false) {
    const globalDir = opts.globalClaudeDir ?? join(homeDir, '.claude')
    if (globalDir !== '' && globalDir !== '.claude') {
      const dir = await collectClaudeDir(globalDir, 'user-claude', globalSkillRank, warnings)
      skills.push(...dir.skills)
      commands.push(...dir.commands)
      rules.push(...await discoverRules(join(globalDir, 'rules'), 'user'))
    }
  }

  // Permissions: discover the three settings files and merge.
  const discovered = await discoverSettings(cwd, { homeDir, projectRootMarkers: markers })
  const merged = mergeSettings(discovered)
  const parsed = parseRulesFor(merged)
  for (const invalid of parsed.invalid) {
    warnings.push(`permission rule ignored: ${invalid.raw ?? ''} — ${invalid.reason}`)
  }
  const permissions = {
    status: merged.status === STATUS.DIRECT ? STATUS.DIRECT : STATUS.UNSUPPORTED,
    raw: { deny: merged.deny, ask: merged.ask, allow: merged.allow },
    parsed,
    removed: removedToolNames(parsed),
    defaultMode: merged.defaultMode,
    additionalDirectories: merged.additionalDirectories,
    disableBypassPermissionsMode: merged.disableBypassPermissionsMode,
    sources: merged.sources,
  }

  const components = {
    skills: skills.map((s) => ({ ...s, status: s.status ?? STATUS.DIRECT })),
    commands: commands.map((c) => ({ ...c, status: c.status ?? STATUS.DIRECT })),
    rules: rules.map((r) => ({ ...r, status: r.status ?? STATUS.DIRECT })),
    permissions,
    unsupported: [], // future: workflows/monitors/themes/bin classification lands here
  }

  const ir = { cwd, projectRoot, components, warnings }
  ir.report = classifyComponents(ir)
  return ir
}

/**
 * Load only the permission slice (settings.json → merged → parsed rules).
 * Cheaper than loadClaude; used by the permission gate on every tool call.
 * @returns {Promise<object>} { cwd, projectRoot, permissions, warnings }
 */
export async function loadPermissions(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const homeDir = opts.homeDir ?? homedir()
  const markers = opts.projectRootMarkers ?? ['.git']
  const warnings = []
  const discovered = await discoverSettings(cwd, { homeDir, projectRootMarkers: markers })
  const merged = mergeSettings(discovered)
  const parsed = parseRulesFor(merged)
  for (const invalid of parsed.invalid) {
    warnings.push(`permission rule ignored: ${invalid.raw ?? ''} — ${invalid.reason}`)
  }
  const permissions = {
    status: merged.status === STATUS.DIRECT ? STATUS.DIRECT : STATUS.UNSUPPORTED,
    raw: { deny: merged.deny, ask: merged.ask, allow: merged.allow },
    parsed,
    removed: removedToolNames(parsed),
    defaultMode: merged.defaultMode,
    additionalDirectories: merged.additionalDirectories,
    disableBypassPermissionsMode: merged.disableBypassPermissionsMode,
    sources: merged.sources,
  }
  return { cwd, projectRoot: discovered.projectRoot, permissions, warnings }
}
