// dsh-cc-loader — plugin manifest + marketplace discovery (.claude-plugin/).
//
// Claude Code plugins are self-contained directories with an optional
// `.claude-plugin/plugin.json` manifest; a marketplace adds
// `.claude-plugin/marketplace.json` listing distributable plugins.
//
// This module parses both files into IR and discovers a plugin root's
// components by reusing the existing skills/commands/agents/mcp/lsp scanners,
// so one entry point (discoverPluginRoot) inventories a whole plugin and the
// manifest's component-path fields are honored per the official path
// behavior rules (verified against code.claude.com/docs/en/plugins-reference):
//   - skills   ADD to the default skills/ scan (root SKILL.md single-skill
//     case included: no skills/ dir, no manifest skills field, SKILL.md at
//     the plugin root → the root itself is one skill bundle)
//   - commands / agents / workflows / outputStyles / themes / monitors
//     REPLACE their default directories when the manifest names them
//   - hooks / mcpServers / lspServers have their own merge rules
//
// Classification vocabulary (same as the rest of the loader):
//   DIRECT      — metadata + component path fields DSH can inventory now
//   ADAPTED     — userConfig / dependencies (reported, not executed)
//   UNSUPPORTED — workflows/output-styles/themes/monitors (M5 misc),
//                 channels (needs an MCP channel bridge), remote marketplace
//                 sources (github/url/npm/… fetch not implemented in DSH)
//   INVALID     — shape errors (skipped with a warning, never fatal)

import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathExists, readTextSafe, discoverSkills, discoverCommands, parseFrontmatter, isSkillName } from './skills.js'
import { discoverAgents, buildAgentEntry } from './agents.js'
import { parseMcpText, serverEntries, discoverMcpConfig } from './mcp.js'
import { parseLspText, discoverLspConfig } from './lsp.js'
import { STATUS } from './classify.js'

/** CC plugin-name grammar: kebab-case, no spaces. */
export const PLUGIN_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Plugin name from a root directory name (used when no manifest exists, or as
 * a fallback). Mirrors CC: name derives from the directory name when the
 * manifest is absent; discoverPluginRoot prefers manifest `name` when present.
 */
export function pluginNameOf(root) {
  const base = root.split(/[\\/]/).filter(Boolean).pop() ?? 'plugin'
  return base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'plugin'
}

/**
 * Namespace a plugin component name for DSH exposure.
 *
 * CC uses `<plugin>:<component>` (e.g. `/superpowers:brainstorming`), but DSH
 * skill/command names are strict kebab-case (no colons, no double hyphens —
 * host grammar is /^[a-z0-9]+(?:-[a-z0-9]+)*$/), and the host is NOT modified
 * by the ecosystem. The agreed mapping is a literal `plugin-` prefix followed
 * by the plugin name and the component name, all single-hyphen kebab:
 *   plugin-superpowers-brainstorming
 *
 * @param {string} pluginName - plugin name (manifest name or dir fallback).
 * @param {string} componentName - the component's own kebab-case name.
 * @returns {string} DSH-safe namespaced name.
 */
export function pluginComponentName(pluginName, componentName) {
  const clean = String(pluginName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (clean.length === 0) return `plugin-${componentName}`
  return `plugin-${clean}-${componentName}`
}

/** Marketplace names Claude reserves for official Anthropic use. */
export const RESERVED_MARKETPLACE_NAMES = new Set([
  'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official',
  'claude-plugins-community', 'claude-community', 'anthropic-marketplace',
  'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills',
  'knowledge-work-plugins', 'life-sciences', 'claude-for-legal',
  'claude-for-financial-services', 'financial-services-plugins',
  'first-party-plugins', 'healthcare',
])

/** Manifest fields that are pure metadata (classified DIRECT). */
const METADATA_FIELDS = new Set([
  '$schema', 'name', 'displayName', 'version', 'description', 'author',
  'homepage', 'repository', 'license', 'keywords', 'metadata', 'defaultEnabled',
])

/**
 * Component path fields → how they interact with the default directory.
 * 'add'     — default dir always scanned, manifest paths scanned alongside.
 * 'replace' — manifest paths replace the default dir when present.
 * 'merge'   — own merge rules (extra files / inline objects).
 */
const COMPONENT_FIELDS = {
  skills: 'add', commands: 'replace', agents: 'replace',
  hooks: 'merge', mcpServers: 'merge', lspServers: 'merge',
  workflows: 'replace', outputStyles: 'replace',
}

/** Component path fields DSH cannot honor yet (classified UNSUPPORTED, M5). */
const UNSUPPORTED_PATH_FIELDS = new Set(['workflows', 'outputStyles'])

const RECOGNIZED_TOP_LEVEL = new Set([
  ...METADATA_FIELDS, ...Object.keys(COMPONENT_FIELDS),
  'experimental', 'userConfig', 'channels', 'dependencies',
])

/** Manifest field → { status, reason? }. */
function classifyManifestField(field) {
  if (METADATA_FIELDS.has(field)) return { status: STATUS.DIRECT }
  if (COMPONENT_FIELDS[field] !== undefined) {
    if (UNSUPPORTED_PATH_FIELDS.has(field)) {
      return { status: STATUS.UNSUPPORTED, reason: `${field}: not bridged yet (M5 misc inventory)` }
    }
    return { status: STATUS.DIRECT }
  }
  if (field === 'experimental') {
    return { status: STATUS.UNSUPPORTED, reason: 'experimental.* components (themes/monitors): not bridged yet (M5 misc inventory)' }
  }
  if (field === 'userConfig') {
    return { status: STATUS.ADAPTED, reason: 'userConfig reported; ${user_config.*} substitution not implemented (report-only)' }
  }
  if (field === 'channels') {
    return { status: STATUS.UNSUPPORTED, reason: 'channels need an MCP message-injection bridge — not implemented' }
  }
  if (field === 'dependencies') {
    return { status: STATUS.ADAPTED, reason: 'plugin dependencies reported; enable/disable graph not implemented (report-only)' }
  }
  return undefined
}

/** Normalize a string|array manifest value into a string array (or undefined). */
function stringListField(value) {
  if (value === undefined) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value
  return undefined // wrong type → warning at call site
}

/**
 * Normalize hooks/mcpServers/lspServers manifest values: a string path, an
 * array of strings and/or inline config objects, or one inline object.
 */
function mixedConfigField(value) {
  if (value === undefined) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return value
    if (value.every((v) => typeof v === 'string' || (v !== null && typeof v === 'object' && !Array.isArray(v)))) {
      return value
    }
    return undefined
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return [value]
  return undefined
}

/** Normalize an author object: { name, email?, url? } → string → undefined. */
function authorField(value) {
  if (typeof value === 'string') return { name: value }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  if (typeof value.name === 'string') out.name = value.name
  if (typeof value.email === 'string') out.email = value.email
  if (typeof value.url === 'string') out.url = value.url
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Parse `.claude-plugin/plugin.json` text into a structured manifest IR.
 * Pure parse; shape errors are reported, never thrown.
 * @param {string} text - raw plugin.json text.
 * @param {object} [opts] - { warn? }
 * @returns {object} {
 *   manifest: { name, displayName?, version?, description?, author?, homepage?,
 *               repository?, license?, keywords?, metadata?, defaultEnabled? },
 *   paths: { skills?: string[], commands?, agents?, workflows?, outputStyles?,
 *            hooks?: (string|object)[], mcpServers?: (string|object)[],
 *            lspServers?: (string|object)[], themes?, monitors? },
 *   classification: [{ field, status, reason? }],
 *   unrecognized: string[],
 *   warnings: string[],
 * }
 *   `manifest` is undefined when the JSON is invalid or not an object.
 */
export function parsePluginManifest(text, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    localWarn(`plugin.json: invalid JSON: ${error.message}`)
    return { manifest: undefined, paths: {}, classification: [], unrecognized: [], warnings }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    localWarn('plugin.json: manifest must be a JSON object')
    return { manifest: undefined, paths: {}, classification: [], unrecognized: [], warnings }
  }

  const classification = []
  const unrecognized = []
  const paths = {}
  const manifest = {}

  for (const [key, value] of Object.entries(parsed)) {
    const cls = classifyManifestField(key)
    if (cls === undefined) {
      unrecognized.push(key)
      localWarn(`plugin.json: unrecognized field "${key}" (Claude Code ignores it; validate would warn)`)
      continue
    }
    classification.push({ field: key, ...cls })

    if (key === 'name') {
      if (typeof value !== 'string' || value.length === 0) {
        localWarn('plugin.json: "name" must be a non-empty string')
        continue
      }
      manifest.name = value
      if (!PLUGIN_NAME_RE.test(value)) {
        localWarn(`plugin.json: name "${value}" is not kebab-case — components may not namespace correctly`)
      }
      continue
    }
    if (key === 'displayName' || key === 'version' || key === 'description'
      || key === 'homepage' || key === 'repository' || key === 'license') {
      if (typeof value === 'string') manifest[key] = value
      else localWarn(`plugin.json: "${key}" must be a string`)
      continue
    }
    if (key === 'author') {
      const a = authorField(value)
      if (a === undefined) localWarn('plugin.json: "author" must be an object {name, email?, url?} or string')
      else manifest.author = a
      continue
    }
    if (key === 'keywords') {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) manifest.keywords = value
      else localWarn('plugin.json: "keywords" must be an array of strings')
      continue
    }
    if (key === 'metadata') {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) manifest.metadata = value
      else localWarn('plugin.json: "metadata" must be an object (Claude Code ignores a non-object)')
      continue
    }
    if (key === 'defaultEnabled') {
      if (typeof value === 'boolean') manifest.defaultEnabled = value
      else localWarn('plugin.json: "defaultEnabled" must be a boolean')
      continue
    }
    if (key === '$schema') continue // ignored at load time by CC as well

    // Component path fields.
    if (key === 'skills' || key === 'commands' || key === 'agents'
      || key === 'workflows' || key === 'outputStyles' || key === 'themes') {
      const list = stringListField(value)
      if (list === undefined) localWarn(`plugin.json: "${key}" must be a string or array of strings`)
      else paths[key] = list
      continue
    }
    if (key === 'hooks' || key === 'mcpServers' || key === 'lspServers') {
      const list = mixedConfigField(value)
      if (list === undefined) localWarn(`plugin.json: "${key}" must be a string, array of strings/objects, or inline object`)
      else paths[key] = list
      continue
    }
    if (key === 'experimental') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        localWarn('plugin.json: "experimental" must be an object (Claude Code ignores a non-object)')
        continue
      }
      for (const [sub, v] of Object.entries(value)) {
        const list = stringListField(v)
        if (list === undefined) localWarn(`plugin.json: "experimental.${sub}" must be a string or array of strings`)
        else paths[sub] = list // themes / monitors
      }
      continue
    }
    if (key === 'userConfig' || key === 'channels' || key === 'dependencies') {
      // Reported only — kept verbatim for the IR inventory.
      manifest[key] = value
    }
  }

  if (manifest.name === undefined) {
    localWarn('plugin.json: "name" is required (only required field)')
  }
  return { manifest: Object.keys(manifest).length > 0 ? manifest : undefined, paths, classification, unrecognized, warnings }
}

/**
 * Normalize one marketplace plugin entry's `source` into a classified shape.
 * @returns {{ kind: string, raw: unknown, fields: object }} kind is one of
 *   'local' | 'github' | 'url' | 'git-subdir' | 'npm' | 'archive' | 'command' | 'invalid'
 */
export function normalizePluginSource(source) {
  if (typeof source === 'string') {
    if (source.startsWith('./') || source.startsWith('.\\')) return { kind: 'local', raw: source, fields: { path: source } }
    if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('/')) return { kind: 'local', raw: source, fields: { path: source } }
    return { kind: 'invalid', raw: source, fields: { reason: 'relative source must start with "./"' } }
  }
  if (source !== null && typeof source === 'object' && !Array.isArray(source) && typeof source.source === 'string') {
    const kind = source.source
    const known = new Set(['github', 'url', 'git-subdir', 'npm', 'archive', 'command'])
    if (!known.has(kind)) return { kind: 'invalid', raw: source, fields: { reason: `unknown source type "${kind}"` } }
    return { kind, raw: source, fields: { ...source } }
  }
  return { kind: 'invalid', raw: source, fields: { reason: 'source must be a relative path string or an object {source, …}' } }
}

/**
 * Parse `.claude-plugin/marketplace.json` text into a marketplace IR.
 * @param {string} text - raw marketplace.json text.
 * @param {object} [opts] - { warn? }
 * @returns {object} {
 *   marketplace: { name, owner?, description?, version?, metadata?, pluginRoot?,
 *                  allowCrossMarketplaceDependenciesOn?, renames? },
 *   plugins: [{ name, source: normalized, status, reason?, ...manifestFields }],
 *   classification: [{ name, sourceKind, status, reason? }],
 *   warnings: string[],
 * }
 */
export function parseMarketplace(text, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    localWarn(`marketplace.json: invalid JSON: ${error.message}`)
    return { marketplace: undefined, plugins: [], classification: [], warnings }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    localWarn('marketplace.json: must be a JSON object')
    return { marketplace: undefined, plugins: [], classification: [], warnings }
  }

  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    localWarn('marketplace.json: "name" is required')
    return { marketplace: undefined, plugins: [], classification: [], warnings }
  }
  if (RESERVED_MARKETPLACE_NAMES.has(parsed.name)) {
    localWarn(`marketplace.json: name "${parsed.name}" is reserved for official Anthropic use`)
  }

  const marketplace = { name: parsed.name }
  const owner = authorField(parsed.owner)
  if (owner !== undefined) marketplace.owner = owner
  if (typeof parsed.description === 'string') marketplace.description = parsed.description
  if (typeof parsed.version === 'string') marketplace.version = parsed.version
  if (parsed.metadata !== null && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)) {
    marketplace.metadata = parsed.metadata
    if (typeof parsed.metadata.pluginRoot === 'string') marketplace.pluginRoot = parsed.metadata.pluginRoot
    if (marketplace.description === undefined && typeof parsed.metadata.description === 'string') {
      marketplace.description = parsed.metadata.description
    }
    if (marketplace.version === undefined && typeof parsed.metadata.version === 'string') {
      marketplace.version = parsed.metadata.version
    }
  }
  if (Array.isArray(parsed.allowCrossMarketplaceDependenciesOn)) {
    marketplace.allowCrossMarketplaceDependenciesOn = parsed.allowCrossMarketplaceDependenciesOn
  }
  if (parsed.renames !== null && typeof parsed.renames === 'object' && !Array.isArray(parsed.renames)) {
    marketplace.renames = parsed.renames
  }

  const plugins = []
  const classification = []
  if (!Array.isArray(parsed.plugins)) {
    localWarn('marketplace.json: "plugins" must be an array')
    return { marketplace, plugins, classification, warnings }
  }
  for (const entry of parsed.plugins) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') {
      localWarn('marketplace.json: each plugin entry needs a string "name"')
      continue
    }
    const src = normalizePluginSource(entry.source)
    const status = src.kind === 'local' ? STATUS.DIRECT : STATUS.UNSUPPORTED
    const reason = src.kind === 'local' ? undefined
      : `marketplace plugin source "${src.kind}" requires a remote fetch DSH does not implement (local "./path" sources work)`
    if (src.kind === 'invalid') {
      localWarn(`marketplace.json: plugin "${entry.name}": ${src.fields.reason ?? 'invalid source'}`)
    }
    const manifestFields = {}
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'name' || k === 'source') continue
      manifestFields[k] = v
    }
    plugins.push({ name: entry.name, source: src, status, reason, ...manifestFields })
    classification.push({ name: entry.name, sourceKind: src.kind, status, reason })
  }
  return { marketplace, plugins, classification, warnings }
}

/** Default component directories at a plugin root (relative to root). */
const DEFAULT_DIRS = {
  skills: 'skills', commands: 'commands', agents: 'agents',
  workflows: 'workflows', outputStyles: 'output-styles',
  themes: 'themes', monitors: 'monitors',
}

/** Resolve a manifest-relative path (`./x`) against the plugin root. */
function resolveManifestPath(root, p) {
  if (typeof p !== 'string' || p.length === 0) return undefined
  const cleaned = p.replace(/^\.\//, '').replace(/^[\\/]+/, '')
  return join(root, cleaned)
}

/** Mirror of skills.js stringField (frontmatter string value). */
function strField(data, key) {
  const v = data[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Mirror of skills.js stringList (frontmatter string/array-of-strings). */
function strList(data, key) {
  const v = data[key]
  if (v === undefined) return []
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.length > 0)
  return []
}

/** True when the path exists and is a regular file (not a directory). */
async function isFile(path) {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * Parse one flat command `.md` file (manifest `commands` may name individual
 * files, not just directories). Mirrors discoverCommands' per-file shape.
 */
async function discoverCommandFile(filePath, source, rank, warnings = []) {
  const raw = await readTextSafe(filePath)
  if (raw === undefined) return undefined
  const parsed = parseFrontmatter(raw)
  const stem = filePath.split(/[\\/]/).pop().replace(/\.md$/, '')
  if (!isSkillName(stem)) {
    warnings.push(`command "${filePath}" skipped: name not kebab-case`)
    return undefined
  }
  const description = parsed === undefined ? stem : (strField(parsed.data, 'description') ?? stem)
  const allowedTools = parsed === undefined ? [] : strList(parsed.data, 'allowed-tools')
  const disallowedTools = parsed === undefined ? [] : strList(parsed.data, 'disallowed-tools')
  return {
    kind: 'command',
    name: stem,
    description,
    whenToUse: undefined,
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    rank,
    locator: { path: filePath, directory: dirname(filePath) },
    resourceBase: { kind: 'directory', path: dirname(filePath) },
    frontmatter: parsed?.data ?? null,
    allowedTools,
    disallowedTools,
    status: 'DIRECT',
  }
}

/**
 * Parse one agent `.md` file (manifest `agents` may name individual files).
 * Mirrors discoverAgents' validation, reusing buildAgentEntry for the IR.
 */
async function discoverAgentFile(filePath, scope, rank, warnings = []) {
  const raw = await readTextSafe(filePath)
  if (raw === undefined) return undefined
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) {
    warnings.push(`agent "${filePath}" skipped: no frontmatter`)
    return undefined
  }
  const fm = parsed.data
  const stem = filePath.split(/[\\/]/).pop().replace(/\.md$/, '')
  const name = strField(fm, 'name') ?? stem
  if (!isSkillName(name)) {
    warnings.push(`agent "${filePath}" skipped: name "${name}" not kebab-case`)
    return undefined
  }
  const description = strField(fm, 'description')
  if (description === undefined) {
    warnings.push(`agent "${filePath}" skipped: no description`)
    return undefined
  }
  const body = parsed.body.trim()
  if (body.length === 0) {
    warnings.push(`agent "${filePath}" skipped: empty system prompt body`)
    return undefined
  }
  return buildAgentEntry({ path: filePath, directory: dirname(filePath), name, description, body, fm, scope, rank, warnings })
}

/**
 * Discover one plugin root into an IR plugin block.
 * Reuses the shared scanners; manifest component-path fields are honored per
 * the official path behavior rules (see header). Never throws.
 * @param {string} root - plugin directory.
 * @param {object} [opts] - {
 *   warn?, skillRank? (=160), agentScope? ('plugin'), readJsonText? (test seam)
 * }
 * @returns {Promise<object>} {
 *   root, name, pluginJsonPath?, manifest?, paths: resolved absolute dirs,
 *   components: { skills, commands, agents, mcp: {servers, sources},
 *                 lsp: {servers, sources}, hooks: {paths, inline},
 *                 unsupported: [{kind, name, reason}] },
 *   classification, warnings,
 * }
 */
export async function discoverPluginRoot(root, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }
  const skillRank = opts.skillRank ?? 160

  // 1. Manifest (optional). Name = manifest name, else directory basename.
  const pluginJsonPath = join(root, '.claude-plugin', 'plugin.json')
  let manifest
  let manifestPaths = {}
  let manifestClassification = []
  if (await pathExists(pluginJsonPath)) {
    const text = await readTextSafe(pluginJsonPath)
    if (text !== undefined) {
      // parsePluginManifest already forwards every warning through localWarn.
      const parsed = parsePluginManifest(text, { warn: localWarn })
      manifest = parsed.manifest
      manifestPaths = parsed.paths
      manifestClassification = parsed.classification
    }
  }
  const fallbackName = pluginNameOf(root)
  const name = manifest?.name ?? fallbackName

  // 2. Component path resolution.
  const mpaths = manifestPaths
  const paths = {
    skills: [],
    commands: [],
    agents: [],
    workflows: [],
    outputStyles: [],
    themes: [],
    monitors: [],
  }
  for (const [field, dirName] of Object.entries(DEFAULT_DIRS)) {
    const manifestList = mpaths[field]
    if (field === 'skills') {
      // skills always add the default dir, unless the single-root-SKILL.md case.
      paths.skills.push(join(root, dirName))
      if (Array.isArray(manifestList)) {
        for (const p of manifestList) {
          const abs = resolveManifestPath(root, p)
          if (abs !== undefined) paths.skills.push(abs)
        }
      }
    } else {
      // replace semantics: manifest paths replace the default dir.
      if (Array.isArray(manifestList) && manifestList.length > 0) {
        for (const p of manifestList) {
          const abs = resolveManifestPath(root, p)
          if (abs !== undefined) paths[field].push(abs)
        }
      } else {
        paths[field].push(join(root, dirName))
      }
    }
  }

  // 3. Discover each component with the shared scanners.
  const components = { skills: [], commands: [], agents: [], mcp: { servers: [], sources: [] }, lsp: { servers: [], sources: [] }, hooks: { paths: [], inline: null }, unsupported: [] }

  const markPlugin = (entry) => ({ ...entry, plugin: name })
  const skillDirs = paths.skills
  const hasSkillsDir = await pathExists(join(root, 'skills'))
  const hasManifestSkills = Array.isArray(mpaths.skills) && mpaths.skills.length > 0
  const rootSkillExists = await pathExists(join(root, 'SKILL.md'))
  if (!hasSkillsDir && !hasManifestSkills && rootSkillExists) {
    // Single-skill plugin: the root itself is a skill bundle.
    components.skills.push(...(await discoverSkills(root, 'plugin', skillRank, warnings)).map(markPlugin))
  } else {
    for (const dir of skillDirs) {
      components.skills.push(...(await discoverSkills(dir, 'plugin', skillRank, warnings)).map(markPlugin))
    }
  }

  for (const dir of paths.commands) {
    // Manifest `commands` may name single .md files or directories.
    if (await isFile(dir)) {
      const entry = await discoverCommandFile(dir, 'plugin', skillRank, warnings)
      if (entry !== undefined) components.commands.push(markPlugin(entry))
    } else {
      components.commands.push(...(await discoverCommands(dir, 'plugin', skillRank, warnings)).map(markPlugin))
    }
  }
  for (const dir of paths.agents) {
    // Manifest `agents` may name single .md files or directories.
    if (await isFile(dir)) {
      const entry = await discoverAgentFile(dir, 'plugin', skillRank, warnings)
      if (entry !== undefined) components.agents.push(markPlugin(entry))
    } else {
      components.agents.push(...(await discoverAgents(dir, 'plugin', skillRank, warnings)).map(markPlugin))
    }
  }

  // MCP: root .mcp.json + plugin.json inline (shared scanner) + manifest paths/inline.
  const mcpFound = await discoverMcpConfig(root, { pluginName: name, warn: localWarn })
  components.mcp.servers.push(...mcpFound.servers)
  components.mcp.sources.push(...mcpFound.sources)
  if (Array.isArray(mpaths.mcpServers)) {
    for (const cfg of mpaths.mcpServers) {
      if (typeof cfg === 'string') {
        const abs = resolveManifestPath(root, cfg)
        if (abs === undefined) continue
        const text = await readTextSafe(abs)
        if (text === undefined) { localWarn(`mcpServers path "${cfg}" not readable — skipped`); continue }
        try {
          const map = parseMcpText(text)
          components.mcp.servers.push(...serverEntries(map, { pluginName: name, warn: localWarn }))
          components.mcp.sources.push(abs)
        } catch (error) {
          localWarn(`${abs}: ${error.message}`)
        }
      } else if (cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)) {
        // Inline mcpServers map (bare or wrapped — parseMcpText detects).
        try {
          const map = parseMcpText(JSON.stringify(cfg))
          components.mcp.servers.push(...serverEntries(map, { pluginName: name, warn: localWarn }))
          components.mcp.sources.push(`${root}/plugin.json (inline mcpServers)`)
        } catch (error) {
          localWarn(`inline mcpServers: ${error.message}`)
        }
      }
    }
  }

  // LSP: root .lsp.json (shared scanner) + manifest paths/inline.
  const lspFound = await discoverLspConfig(root, { warn: localWarn })
  components.lsp.servers.push(...lspFound.servers)
  components.lsp.sources.push(...lspFound.sources)
  if (Array.isArray(mpaths.lspServers)) {
    for (const cfg of mpaths.lspServers) {
      if (typeof cfg === 'string') {
        const abs = resolveManifestPath(root, cfg)
        if (abs === undefined) continue
        const text = await readTextSafe(abs)
        if (text === undefined) { localWarn(`lspServers path "${cfg}" not readable — skipped`); continue }
        components.lsp.servers.push(...parseLspText(text, abs, localWarn))
        components.lsp.sources.push(abs)
      } else if (cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)) {
        components.lsp.servers.push(...parseLspText(JSON.stringify(cfg), `${root}/plugin.json (inline lspServers)`, localWarn))
      }
    }
  }

  // Hooks: manifest paths / inline object, else default hooks/hooks.json.
  const hookPaths = Array.isArray(mpaths.hooks) ? mpaths.hooks : []
  let inlineHooks = null
  for (const h of hookPaths) {
    if (typeof h === 'string') {
      const abs = resolveManifestPath(root, h)
      if (abs !== undefined) components.hooks.paths.push(abs)
    } else if (h !== null && typeof h === 'object' && !Array.isArray(h)) {
      inlineHooks = h
    }
  }
  if (components.hooks.paths.length === 0 && inlineHooks === null) {
    const def = join(root, 'hooks', 'hooks.json')
    if (await pathExists(def)) components.hooks.paths.push(def)
  }
  components.hooks.inline = inlineHooks

  // Unsupported component paths (M5 misc) — report-only inventory.
  for (const field of ['workflows', 'outputStyles', 'themes', 'monitors']) {
    for (const dir of paths[field]) {
      if (await pathExists(dir)) {
        components.unsupported.push({
          kind: field, name: field, status: STATUS.UNSUPPORTED,
          reason: `${field}: not bridged yet (M5 misc inventory)`,
        })
      }
    }
  }

  return {
    root, name,
    pluginJsonPath: manifest !== undefined ? pluginJsonPath : undefined,
    manifest, paths, components,
    classification: manifestClassification,
    warnings,
  }
}

/**
 * Discover a marketplace root: read `.claude-plugin/marketplace.json`, resolve
 * local plugin sources against the marketplace root (metadata.pluginRoot
 * prepended when present). Never throws.
 * @param {string} root - marketplace directory (contains .claude-plugin/).
 * @param {object} [opts] - { warn? }
 * @returns {Promise<object>} {
 *   root, marketplaceJsonPath?, marketplace?, plugins: [{ name, source, dir?,
 *     status, reason?, ...manifestFields }], classification, warnings
 * }
 */
export async function discoverMarketplace(root, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }

  const marketplaceJsonPath = join(root, '.claude-plugin', 'marketplace.json')
  if (!(await pathExists(marketplaceJsonPath))) {
    return { root, marketplaceJsonPath: undefined, marketplace: undefined, plugins: [], classification: [], warnings }
  }
  const text = await readTextSafe(marketplaceJsonPath)
  if (text === undefined) {
    localWarn(`cannot read ${marketplaceJsonPath}`)
    return { root, marketplaceJsonPath, marketplace: undefined, plugins: [], classification: [], warnings }
  }

  const parsed = parseMarketplace(text, { warn: localWarn })
  const marketplace = parsed.marketplace
  if (marketplace === undefined) {
    return { root, marketplaceJsonPath, marketplace, plugins: [], classification: parsed.classification, warnings }
  }

  // Resolve local sources: relative to marketplace root, with metadata.pluginRoot prepended.
  const base = marketplace.pluginRoot !== undefined
    ? join(root, marketplace.pluginRoot.replace(/^\.\//, '')) : root
  const plugins = parsed.plugins.map((entry) => {
    if (entry.source.kind === 'local') {
      const p = typeof entry.source.fields.path === 'string'
        ? entry.source.fields.path.replace(/^\.\//, '').replace(/^[\\/]+/, '') : ''
      const dir = p.length > 0 ? join(base, p) : root
      return { ...entry, dir }
    }
    return { ...entry, dir: undefined }
  })
  return { root, marketplaceJsonPath, marketplace, plugins, classification: parsed.classification, warnings }
}
