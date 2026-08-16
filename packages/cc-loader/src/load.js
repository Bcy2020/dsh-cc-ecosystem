// loadClaude: assemble the full IR from a cwd (project + global .claude).

import { homedir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot, collectClaudeDir, discoverRules } from './skills.js'
import { discoverSettings, mergeSettings } from './settings.js'
import { parseRulesFor, removedToolNames, classifyComponents } from './classify.js'
import { STATUS } from './classify.js'
import { mergeAgentCatalog } from './agents.js'
import { discoverProjectMcp } from './mcp.js'

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
  const agentRoots = []

  if (projectRoot !== undefined) {
    const claudeDir = join(projectRoot, '.claude')
    const dir = await collectClaudeDir(claudeDir, 'project-claude', projectSkillRank, warnings)
    skills.push(...dir.skills)
    commands.push(...dir.commands)
    rules.push(...await discoverRules(join(claudeDir, 'rules'), 'project'))
    agentRoots.push({ root: join(claudeDir, 'agents'), scope: 'project', rank: projectSkillRank })
  }

  if (opts.enableGlobal !== false) {
    const globalDir = opts.globalClaudeDir ?? join(homeDir, '.claude')
    if (globalDir !== '' && globalDir !== '.claude') {
      const dir = await collectClaudeDir(globalDir, 'user-claude', globalSkillRank, warnings)
      skills.push(...dir.skills)
      commands.push(...dir.commands)
      rules.push(...await discoverRules(join(globalDir, 'rules'), 'user'))
      agentRoots.push({ root: join(globalDir, 'agents'), scope: 'global', rank: globalSkillRank })
    }
  }

  // Agents: merge project + global into one catalog (project wins on name clash).
  const catalog = await mergeAgentCatalog(agentRoots, warnings)
  warnings.push(...catalog.warnings)

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
    model: merged.model,
    env: merged.env,
    statusLine: merged.statusLine,
    outputStyle: merged.outputStyle,
    enableAllProjectMcpServers: merged.enableAllProjectMcpServers,
    sources: merged.sources,
  }

  // MCP servers: project-root .mcp.json (CC project-level config).
  const mcp = { servers: [], sources: [] }
  if (projectRoot !== undefined) {
    const found = await discoverProjectMcp(projectRoot, { warn: (m) => warnings.push(m) })
    mcp.servers.push(...found.servers)
    mcp.sources.push(...found.sources)
    warnings.push(...found.warnings)
  }

  // LSP servers: plugin-root .lsp.json — discovered by the plugin scanner
  // (M4); loadClaude itself has no plugin roots, so this stays empty here.
  // discoverLspConfig() is exported for adapters that do scan plugin dirs.
  const lsp = { servers: [], sources: [] }

  const components = {
    skills: skills.map((s) => ({ ...s, status: s.status ?? STATUS.DIRECT })),
    commands: commands.map((c) => ({ ...c, status: c.status ?? STATUS.DIRECT })),
    rules: rules.map((r) => ({ ...r, status: r.status ?? STATUS.DIRECT })),
    agents: catalog.agents,
    mcp,
    lsp,
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
    model: merged.model,
    env: merged.env,
    statusLine: merged.statusLine,
    outputStyle: merged.outputStyle,
    enableAllProjectMcpServers: merged.enableAllProjectMcpServers,
    sources: merged.sources,
  }
  return { cwd, projectRoot: discovered.projectRoot, permissions, warnings }
}
