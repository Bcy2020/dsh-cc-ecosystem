// loadClaude: assemble the full IR for one session directory.
//
// Discovery is PER COMPONENT (see scopes.js) — Claude Code has no project root:
//   skills / commands / agents   bounded ancestors (cwd → home, git root)
//   rules                        full ancestors, root-first
//   settings                     fixed: user config dir + <cwd>/.claude
//   mcp                          user + local (~/.claude.json), plus every
//                                ancestor's .mcp.json with the nearest winning
//                                a name clash
//
// Markdown components merge in CC's order — policy → user → additional →
// project (near → far). We have no policy directory and no --add-dir yet, so
// the order is user, then project near → far. Same-named entries are NOT
// deduplicated: CC keeps every one and leaves the choice to the consumer.

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  boundedAncestors, findGitRoot, fullAncestors,
} from './scopes.js'
import { collectClaudeDir, discoverRules } from './skills.js'
import { discoverSettings, mergeSettings } from './settings.js'
import { parseRulesFor, removedToolNames, classifyComponents } from './classify.js'
import { STATUS } from './classify.js'
import { mergeAgentCatalog } from './agents.js'
import { discoverMcpScopes } from './mcp.js'
import { discoverPluginRoot, discoverMarketplace } from './plugin.js'

/** The `.claude` directory a user-scope read is anchored at. */
function globalClaudeDirOf(opts, homeDir) {
  const dir = opts.globalClaudeDir ?? join(homeDir, '.claude')
  return dir === '' || dir === '.claude' ? undefined : dir
}

/**
 * Load Claude Code `.claude/` assets into a standalone IR.
 * Pure parse: no writes, no side effects beyond reads.
 * @param {object} [opts]
 * @param {string} opts.cwd - session working directory; the anchor for every
 *   scope below (settings, the `.mcp.json` walk, the `~/.claude.json` key).
 * @param {string} [opts.homeDir]
 * @param {string} [opts.gitRoot] - pre-resolved repository root (skips a walk).
 * @param {boolean} [opts.enableGlobal=true]
 * @param {string} [opts.globalClaudeDir]
 * @param {string} [opts.claudeJsonPath] - override `~/.claude.json`.
 * @param {string[]} [opts.pluginRoots] - plugin dirs to inventory (M4).
 * @param {string[]} [opts.marketplaceRoots] - marketplace dirs to inventory (M4).
 * @returns {Promise<object>} IR { cwd, scopes, components, warnings, report }
 */
export async function loadClaude(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const homeDir = opts.homeDir ?? homedir()
  const warnings = []
  const gitRoot = opts.gitRoot !== undefined ? opts.gitRoot : await findGitRoot(cwd)
  const projectDirs = await boundedAncestors(cwd, { homeDir, gitRoot })
  const ancestors = fullAncestors(cwd)
  const globalClaudeDir = opts.enableGlobal === false ? undefined : globalClaudeDirOf(opts, homeDir)

  const skills = []
  const commands = []
  const rules = []
  const agentRoots = []

  // Markdown components, in CC's merge order: user first, then project
  // near → far. Every contributing directory is read; nothing shadows anything.
  const markdownRoots = []
  if (globalClaudeDir !== undefined) markdownRoots.push({ claudeDir: globalClaudeDir, source: 'user-claude' })
  for (const dir of projectDirs) markdownRoots.push({ claudeDir: join(dir, '.claude'), source: 'project-claude' })

  for (const { claudeDir, source } of markdownRoots) {
    const collected = await collectClaudeDir(claudeDir, { source, warnings })
    skills.push(...collected.skills)
    commands.push(...collected.commands)
    agentRoots.push({
      root: join(claudeDir, 'agents'),
      scope: source === 'user-claude' ? 'global' : 'project',
      baseDir: claudeDir,
    })
  }

  // Rules walk the FULL ancestor chain, root-first (CC :76362 + :76364), with
  // the user dir ahead of every project dir — the same order CC builds.
  if (globalClaudeDir !== undefined) {
    rules.push(...await discoverRules(join(globalClaudeDir, 'rules'), {
      source: 'user',
      baseDir: globalClaudeDir,
    }))
  }
  for (const dir of ancestors.slice().reverse()) {
    const claudeDir = join(dir, '.claude')
    rules.push(...await discoverRules(join(claudeDir, 'rules'), { source: 'project', baseDir: claudeDir }))
  }

  // Agents: one catalog, unique names (see mergeAgentCatalog for the order).
  const catalog = await mergeAgentCatalog(agentRoots, warnings)

  // Permissions: settings live at fixed locations anchored on cwd.
  const discovered = await discoverSettings(cwd, {
    homeDir,
    ...(opts.globalClaudeDir !== undefined ? { globalClaudeDir: opts.globalClaudeDir } : {}),
  })
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
    enabledMcpjsonServers: merged.enabledMcpjsonServers,
    disabledMcpjsonServers: merged.disabledMcpjsonServers,
    sources: merged.sources,
  }

  // MCP servers: the scopes we read (user / local / project), effective set
  // plus the entries a nearer or more authoritative scope shadowed.
  const mcpFound = await discoverMcpScopes(cwd, {
    homeDir,
    gitRoot,
    ...(opts.claudeJsonPath !== undefined ? { claudeJsonPath: opts.claudeJsonPath } : {}),
    warn: (m) => warnings.push(m),
  })
  warnings.push(...mcpFound.warnings)
  const mcp = {
    servers: mcpFound.servers,
    shadowed: mcpFound.shadowed,
    byScope: mcpFound.byScope,
    sources: mcpFound.sources,
    claudeJson: mcpFound.claudeJson,
  }

  // LSP servers: plugin-root .lsp.json — discovered by the plugin scanner
  // (M4); loadClaude itself has no plugin roots, so this stays empty here.
  // discoverLspConfig() is exported for adapters that do scan plugin dirs.
  const lsp = { servers: [], sources: [] }

  // Plugins + marketplaces (M4): each plugin root is inventoried into its own
  // IR block. Plugin components stay namespaced by plugin (components.plugins)
  // and are NOT merged into the top-level skills/commands/agents — adapters
  // consume them through the plugin block and apply CC's <plugin>:<name>
  // namespacing themselves.
  const plugins = []
  const marketplaces = []
  for (const root of opts.pluginRoots ?? []) {
    const plugin = await discoverPluginRoot(root, { warn: (m) => warnings.push(m) })
    warnings.push(...plugin.warnings)
    plugins.push(plugin)
  }
  for (const root of opts.marketplaceRoots ?? []) {
    const mp = await discoverMarketplace(root, { warn: (m) => warnings.push(m) })
    warnings.push(...mp.warnings)
    marketplaces.push(mp)
  }

  const components = {
    skills: skills.map((s) => ({ ...s, status: s.status ?? STATUS.DIRECT })),
    commands: commands.map((c) => ({ ...c, status: c.status ?? STATUS.DIRECT })),
    rules: rules.map((r) => ({ ...r, status: r.status ?? STATUS.DIRECT })),
    agents: catalog.agents,
    mcp,
    lsp,
    permissions,
    plugins,
    marketplaces,
    unsupported: [], // future: workflows/monitors/themes/bin classification lands here
  }

  const ir = {
    cwd,
    scopes: {
      gitRoot,
      homeDir,
      project: projectDirs,   // bounded ancestors: skills/commands/agents
      ancestors,              // full ancestors: rules, .mcp.json
      globalClaudeDir,
      claudeJsonKey: mcpFound.claudeJson.key,
    },
    components,
    warnings,
  }
  ir.report = classifyComponents(ir)
  return ir
}

/**
 * Load only the permission slice (settings.json → merged → parsed rules).
 * Cheaper than loadClaude; used by the permission gate on every tool call.
 * @returns {Promise<object>} { cwd, permissions, warnings }
 */
export async function loadPermissions(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const homeDir = opts.homeDir ?? homedir()
  const warnings = []
  const discovered = await discoverSettings(cwd, {
    homeDir,
    ...(opts.globalClaudeDir !== undefined ? { globalClaudeDir: opts.globalClaudeDir } : {}),
  })
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
    enabledMcpjsonServers: merged.enabledMcpjsonServers,
    disabledMcpjsonServers: merged.disabledMcpjsonServers,
    sources: merged.sources,
  }
  return { cwd, permissions, warnings }
}
