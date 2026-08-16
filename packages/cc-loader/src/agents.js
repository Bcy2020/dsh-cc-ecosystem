// .claude agents discovery + IR: project .claude/agents/*.md and global
// ~/.claude/agents/*.md → in-memory agent catalog (CC "first kind" agents:
// frontmatter + system-prompt body, delegated via the persona channel).
//
// CC scope precedence: project > global (plugin agents arrive with the plugin
// source in M4; the loader already tolerates an extra root).
//
// Every entry is classified DIRECT / ADAPTED / UNSUPPORTED / BLOCKED.
// BLOCKED entries (e.g. isolation: worktree) never reach the adapter.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isSkillName, parseFrontmatter, pathExists, readTextSafe } from './skills.js'

/**
 * CC agent frontmatter fields we map to a delegation (DIRECT).
 *
 * Verified against the official subagents reference (16 fields): name,
 * description, tools, disallowedTools, model, permissionMode, mcpServers,
 * hooks, maxTurns, skills, initialPrompt, memory, effort, background,
 * isolation, color. `context` is not in the official list but is used by
 * community agents as extra system-prompt material — we extract it and append
 * it to the persona (see buildAgentEntry). `agent` is likewise non-official
 * (a leftover in the old whitelist); it is extracted and reported, never
 * treated as DIRECT.
 */
const DIRECT_FIELDS = [
  'name', 'description', 'tools', 'disallowedTools', 'model', 'effort',
  'maxTurns', 'skills', 'background', 'initialPrompt', 'context',
]
/** CC fields DSH cannot honor on this kind of agent (reported, never fatal). */
const UNSUPPORTED_FIELDS = ['permissionMode', 'mcpServers', 'hooks', 'isolation']

/**
 * Discover `.claude/agents/*.md` under one root (project or global user dir).
 * Flat files only, like CC. Each agent needs `name` (frontmatter or file stem)
 * and `description`; the body is the delegation system prompt.
 * @param {string} agentsDir - path to the agents directory.
 * @param {string} scope - 'project' | 'global'.
 * @param {number} rank - precedence rank (lower wins).
 * @param {string[]} [warnings] - collected warnings.
 * @returns {Promise<object[]>} IR agent entries.
 */
export async function discoverAgents(agentsDir, scope, rank, warnings = []) {
  const out = []
  if (!(await pathExists(agentsDir))) return out
  let entries
  try { entries = await readdir(agentsDir, { withFileTypes: true, encoding: 'utf8' }) }
  catch { return out }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = join(agentsDir, entry.name)
    const stem = entry.name.slice(0, -3)
    if (!isSkillName(stem)) {
      warnings.push(`agent "${entry.name}" skipped: name not kebab-case`)
      continue
    }
    const raw = await readTextSafe(path)
    if (raw === undefined) continue
    const parsed = parseFrontmatter(raw)
    if (parsed === undefined) {
      warnings.push(`agent "${path}" skipped: no frontmatter`)
      continue
    }
    const fm = parsed.data
    const name = stringField(fm, 'name') ?? stem
    if (!isSkillName(name)) {
      warnings.push(`agent "${path}" skipped: name "${name}" not kebab-case`)
      continue
    }
    const description = stringField(fm, 'description')
    if (description === undefined) {
      warnings.push(`agent "${path}" skipped: no description`)
      continue
    }
    const body = parsed.body.trim()
    if (body.length === 0) {
      warnings.push(`agent "${path}" skipped: empty system prompt body`)
      continue
    }
    out.push(buildAgentEntry({ path, directory: agentsDir, name, description, body, fm, scope, rank, warnings }))
  }
  return out
}

/**
 * Build one IR agent entry from a parsed `.md` file, classifying every
 * frontmatter field. Never throws on an unknown field — it lands in `notes`.
 */
export function buildAgentEntry({ path, directory, name, description, body, fm, scope, rank, warnings }) {
  const notes = []
  const status = classifyAgentFields(fm, notes)

  const tools = stringList(fm, 'tools')
  const disallowedTools = stringList(fm, 'disallowedTools')
  const skills = stringList(fm, 'skills')
  const model = stringField(fm, 'model')
  const effort = stringField(fm, 'effort')
  const maxTurns = fm['maxTurns']
  const background = truthy(fm['background'])
  const initialPrompt = stringField(fm, 'initialPrompt')
  const isolation = stringField(fm, 'isolation')
  const memory = stringField(fm, 'memory')
  const color = stringField(fm, 'color')
  // Community context field (not in the official 16): extra system-prompt
  // material appended to the persona by the cc-agents adapter.
  const context = stringList(fm, 'context')
  // Non-official leftover field: no DSH parent-identity mapping exists, so the
  // raw value is kept for the report and flagged in notes.
  const agentField = stringField(fm, 'agent')

  if (isolation === 'worktree') {
    notes.push('isolation:worktree has no DSH equivalent — agent not delegatable')
  } else if (isolation !== undefined) {
    notes.push(`isolation:${isolation} unknown — ignored`)
  }
  if (maxTurns !== undefined && typeof maxTurns !== 'number') {
    warnings?.push(`agent "${name}": maxTurns not a number — ignored`)
    notes.push('maxTurns not numeric — ignored')
  }

  return {
    kind: 'agent',
    name,
    description,
    scope,
    rank,
    source: path,
    locator: { path, directory },
    frontmatter: fm,
    systemPrompt: body,
    tools,
    disallowedTools,
    skills,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(maxTurns !== undefined && typeof maxTurns === 'number' ? { maxTurns } : {}),
    ...(background ? { background: true } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(context.length > 0 ? { context } : {}),
    ...(agentField !== undefined ? { agent: agentField } : {}),
    status,
    notes,
  }
}

/**
 * Classify an agent's frontmatter: DIRECT when only delegatable fields are
 * present; ADAPTED when a field has a degraded mapping (memory → report);
 * UNSUPPORTED when a field has no DSH equivalent (permissionMode/mcpServers/
 * hooks — CC itself forbids these on plugin agents); BLOCKED when the agent
 * cannot be delegated at all (isolation: worktree).
 */
export function classifyAgentFields(fm, notes = []) {
  let status = 'DIRECT'
  for (const key of Object.keys(fm)) {
    if (DIRECT_FIELDS.includes(key)) continue
    if (key === 'memory') {
      status = worse(status, 'ADAPTED')
      notes.push(`memory:${fm[key]} — mapped to a report, no DSH persistent-dir bridge yet`)
      continue
    }
    if (key === 'isolation') {
      if (fm[key] === 'worktree') return 'BLOCKED'
      status = worse(status, 'ADAPTED')
      notes.push(`isolation:${fm[key]} — ignored`)
      continue
    }
    if (key === 'Agent') {
      status = worse(status, 'ADAPTED')
      notes.push('Agent(agent_type) applies to main-thread agents only — reported')
      continue
    }
    if (key === 'color') {
      status = worse(status, 'ADAPTED')
      notes.push('color affects CC UI display only — reported, no DSH equivalent')
      continue
    }
    if (key === 'agent') {
      status = worse(status, 'ADAPTED')
      notes.push('agent field is not a CC standard field — reported, no DSH parent-identity mapping')
      continue
    }
    if (UNSUPPORTED_FIELDS.includes(key)) {
      status = worse(status, 'UNSUPPORTED')
      notes.push(`${key} has no DSH delegation equivalent — ignored (CC forbids it on plugin agents too)`)
      continue
    }
    status = worse(status, 'ADAPTED')
    notes.push(`unknown frontmatter field "${key}" — ignored`)
  }
  return status
}

/**
 * Expand a CC tool name (agent frontmatter `tools`/`disallowedTools`) into
 * candidate DSH global tool names. `mcp__…` names pass through (MCP tools are
 * registered per server); exact DSH names pass through; bucket names expand.
 * Names containing `*` cannot be enumerated here → empty + note.
 * @param {string} ccName
 * @param {string[]} [notes]
 * @returns {string[]}
 */
export function expandCcToolToDsh(ccName, notes = []) {
  if (typeof ccName !== 'string' || ccName.length === 0) return []
  if (ccName.includes('*')) {
    notes.push(`tools entry "${ccName}" uses a glob — cannot enumerate, skipped`)
    return []
  }
  const expanded = CC_TO_DSH[ccName]
  if (expanded !== undefined) return [...expanded]
  // mcp__server / mcp__server__tool / exact DSH tool names pass through.
  return [ccName]
}

/** CC agent tool bucket → candidate DSH global tool names (verified inventory). */
const CC_TO_DSH = Object.freeze({
  Bash: ['bash', 'pwsh',
    'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'],
  PowerShell: ['pwsh'],
  Read: ['read', 'read_image'],
  Write: ['write'],
  Edit: ['edit', 'str_replace_editor'],
  Glob: ['glob'],
  Grep: ['grep'],
  WebFetch: ['web_fetch'],
  Agent: ['subagent'],
  Skill: ['skill'],
  AskUserQuestion: ['ask_user_question'],
})

/**
 * Merge agents from multiple roots into one catalog, resolving name conflicts
 * by scope precedence (project beats global). Later roots lose and warn.
 * @param {Array<{root: string, scope: string, rank: number}>} roots
 * @returns {Promise<{agents: object[], warnings: string[]}>}
 */
export async function mergeAgentCatalog(roots, warnings = []) {
  const byName = new Map()
  for (const { root, scope, rank } of roots) {
    const found = await discoverAgents(root, scope, rank, warnings)
    for (const agent of found) {
      const existing = byName.get(agent.name)
      if (existing === undefined) {
        byName.set(agent.name, agent)
        continue
      }
      // Same name: lower rank wins (project < global). Lose → warn (fail loud).
      if (agent.rank < existing.rank) {
        warnings.push(`agent "${agent.name}": ${scope} overrides ${existing.scope} (same name)`)
        byName.set(agent.name, agent)
      } else if (agent.rank > existing.rank) {
        warnings.push(`agent "${agent.name}": ${scope} conflicts with ${existing.scope} — ${existing.scope} wins`)
      }
      // Equal rank: first root wins silently (same scope, duplicate dirs).
    }
  }
  return { agents: [...byName.values()], warnings }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function stringField(data, key) {
  const v = data[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function stringList(data, key) {
  const v = data[key]
  if (v === undefined) return []
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.length > 0)
  return []
}

function truthy(v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.toLowerCase()
    return s === 'true' || s === 'yes' || s === 'on' || s === '1'
  }
  if (typeof v === 'number') return v !== 0
  return false
}

/** Strictest-status wins: BLOCKED > UNSUPPORTED > ADAPTED > DIRECT. */
function worse(a, b) {
  const order = { DIRECT: 0, ADAPTED: 1, UNSUPPORTED: 2, BLOCKED: 3 }
  return order[a] >= order[b] ? a : b
}

/** Re-exported read helpers the adapter also uses. */
export { pathExists, readTextSafe }
