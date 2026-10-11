// `.claude` asset discovery: skills, commands, rules.
//
// Scope resolution lives in scopes.js — nothing here decides *which*
// directories to read. This module reads one directory it is handed and tags
// every entry with where it came from:
//   source   — the scope kind ('project-claude' | 'user-claude' | 'plugin')
//   baseDir  — the `.claude` directory (or plugin root) that contributed it
// There is no `rank`: Claude Code has no numeric priority, so the position of
// an entry in the merged list *is* its priority.
//
// Extracted from dsh-claude-compat's provider (MIT, biedongbin).

import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { pathExists, readTextSafe } from './scopes.js'

export { pathExists, readTextSafe }

/** DSH skill-name grammar (kebab-case), same as @deepseek-ai/dsh-skill. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function isSkillName(name) {
  return SKILL_NAME_RE.test(name)
}

/**
 * Collect skills + commands from one `.claude` dir.
 * @param {string} claudeDir
 * @param {{ source: string, warnings?: string[] }} opts - `source` is the scope
 *   kind; the dir itself becomes each entry's `baseDir`.
 * @returns {Promise<{skills: object[], commands: object[], warnings: string[]}>}
 */
export async function collectClaudeDir(claudeDir, opts = {}) {
  const warnings = opts.warnings ?? []
  const source = opts.source
  const skills = await discoverSkills(join(claudeDir, 'skills'), { source, baseDir: claudeDir, warnings })
  const commands = await discoverCommands(join(claudeDir, 'commands'), { source, baseDir: claudeDir, warnings })
  return { skills, commands, warnings }
}

/**
 * Rules from one `.claude/rules` tree — plain markdown, ordered by relative path.
 *
 * The whole tree is walked. Rule packs commonly organize rules in folders
 * (`rules/common/`, `rules/typescript/` …); a top-level-only read yields zero
 * rules for those projects, so nothing is injected and the failure is silent.
 * `name` is the path relative to the rules dir, which for a top-level file is
 * just its filename.
 *
 * @param {string} rulesDir
 * @param {{ source: string, baseDir?: string }} opts
 * @returns {Promise<object[]>} rule IR entries.
 */
export async function discoverRules(rulesDir, opts = {}) {
  const { source, baseDir } = opts
  const rules = []
  await walk(rulesDir, '')
  rules.sort((a, b) => a.name.localeCompare(b.name))
  return rules

  async function walk(dir, prefix) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }) }
    catch { return }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        await walk(join(dir, entry.name), name)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        rules.push({
          path: join(dir, entry.name),
          name,
          source,
          baseDir,
          status: 'DIRECT',
        })
      }
    }
  }
}

// ─── skills: recursive, ≤3 levels, bundle stops descent ─────────────────────

export async function discoverSkills(rootDir, opts = {}) {
  const { source, baseDir, warnings = [] } = opts
  const out = []
  if (!(await pathExists(rootDir))) return out
  await walk(rootDir, '', 0)
  return out

  async function walk(dir, prefix, depth) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }) }
    catch { return }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const skillPath = join(dir, 'SKILL.md')
      const c = await parseSkillCandidateFile(skillPath, { source, baseDir, flatName: prefix || undefined, warnings })
      if (c !== undefined) out.push(c)
      return // bundle — don't descend
    }
    if (depth >= 3) return
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const childPrefix = prefix ? `${prefix}-${entry.name}` : entry.name
      await walk(join(dir, entry.name), childPrefix, depth + 1)
    }
  }
}

// ─── commands: flat ──────────────────────────────────────────────────────────

export async function discoverCommands(rootDir, opts = {}) {
  const { source, baseDir, warnings = [] } = opts
  const out = []
  if (!(await pathExists(rootDir))) return out
  let entries
  try { entries = await readdir(rootDir, { withFileTypes: true, encoding: 'utf8' }) }
  catch { return out }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = join(rootDir, entry.name)
    const stem = entry.name.slice(0, -3)
    if (!isSkillName(stem)) {
      warnings.push(`command "${entry.name}" skipped: name not kebab-case`)
      continue
    }
    const raw = await readTextSafe(path)
    if (raw === undefined) continue
    const parsed = parseFrontmatter(raw, warnings, `command "${entry.name}"`)
    const description = parsed === undefined ? stem : (stringField(parsed.data, 'description') ?? stem)
    // Command tool-scope fields (CC kebab-case, same shape as skills).
    const allowedTools = parsed === undefined ? [] : stringList(parsed.data, 'allowed-tools')
    const disallowedTools = parsed === undefined ? [] : stringList(parsed.data, 'disallowed-tools')
    out.push({
      kind: 'command',
      name: stem,
      description,
      whenToUse: undefined,
      invocation: { modelInvocable: true, userInvocable: true },
      source,
      baseDir,
      locator: { path, directory: rootDir },
      resourceBase: { kind: 'directory', path: rootDir },
      frontmatter: parsed?.data ?? null,
      allowedTools,
      disallowedTools,
      status: 'DIRECT',
    })
  }
  return out
}

// ─── SKILL.md candidate parsing ──────────────────────────────────────────────

async function parseSkillCandidateFile(path, opts) {
  const { source, baseDir, flatName, warnings = [] } = opts
  const raw = await readTextSafe(path)
  if (raw === undefined) return undefined
  const parsed = parseFrontmatter(raw, warnings, `skill "${path}"`)
  if (parsed === undefined) {
    warnings.push(`skill "${path}" skipped: no frontmatter`)
    return undefined
  }
  const fmName = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (description === undefined) {
    warnings.push(`skill "${path}" skipped: no description`)
    return undefined
  }
  // Prefer frontmatter name when it is a valid kebab-case skill name. Some
  // Claude skills use names with ':' or other chars DSH rejects (e.g.
  // "salus:ai-robot-coding-env-check"); for those, fall back to the flattened
  // directory name, which is virtually always kebab-case.
  let name
  if (fmName !== undefined && isSkillName(fmName)) name = fmName
  else if (flatName !== undefined && isSkillName(flatName)) name = flatName
  if (name === undefined) {
    warnings.push(`skill "${path}" skipped: name "${fmName ?? flatName}" not a valid DSH skill name`)
    return undefined
  }
  let invocation
  try { invocation = parseInvocationPolicy(parsed.data) }
  catch { invocation = { modelInvocable: true, userInvocable: true } }
  const whenToUse = stringField(parsed.data, 'whenToUse')
  // Skill frontmatter tool-scope fields (CC kebab-case, unlike agent camelCase).
  // allowed-tools: tools that run without approval while the skill is active;
  // disallowed-tools: tools removed from the pool while the skill is active.
  const allowedTools = stringList(parsed.data, 'allowed-tools')
  const disallowedTools = stringList(parsed.data, 'disallowed-tools')
  return {
    kind: 'skill',
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    invocation,
    source,
    baseDir,
    locator: { path, directory: dirname(path) },
    resourceBase: { kind: 'directory', path: dirname(path) },
    frontmatter: parsed.data,
    allowedTools,
    disallowedTools,
    status: 'DIRECT',
  }
}

// ─── frontmatter helpers ─────────────────────────────────────────────────────

/**
 * Read the `---`-delimited block at the top of a `.claude` markdown file.
 *
 * Claude Code tolerates frontmatter that strict YAML rejects, so dropping a
 * file on a parse error loses assets CC reads happily. The recurring shape is
 * an unquoted `description` carrying a second `: ` — community agent files
 * produce it by putting `Context: …` or `user: '…'` inside `<example>` blocks.
 * A failed strict parse therefore falls back to flat `key: value` lines, and
 * says so through `warnings` rather than degrading in silence.
 *
 * @param {string} raw - whole file.
 * @param {string[]} [warnings] - collector for the lenient-parse notice.
 * @param {string} [label] - what to call the file in that notice. Callers own
 *   the path, so they supply it (`agent "/…/x.md"`).
 * @returns {{ data: object, body: string } | undefined}
 */
export function parseFrontmatter(raw, warnings, label) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const block = raw.slice(start, closing.start)
  let parsed
  let reason
  try {
    parsed = parse(block)
  } catch (error) {
    parsed = parseLenient(block)
    if (parsed === undefined) return undefined
    reason = firstLineOf(String(error?.message ?? error))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  if (reason !== undefined && warnings !== undefined) {
    warnings.push(`${label ?? 'frontmatter'} has frontmatter strict YAML rejects (${reason}) — read as flat key: value; only top-level fields survive`)
  }
  return { data: parsed, body: raw.slice(closing.bodyStart) }
}

// Fields Claude Code documents as comma-separated lists. Strict YAML turns them
// into real arrays on its own, so this set matters only on the lenient path —
// without it `tools: Read, Bash` arrives as one bogus entry named "Read, Bash".
const COMMA_LIST_FIELDS = new Set([
  'tools', 'disallowedTools', 'skills', 'allowed-tools', 'disallowed-tools',
])

/**
 * Flat `key: value` reader for a frontmatter block strict YAML rejected. Every
 * value stays a string except the documented comma lists above — coercing
 * numbers would turn `description: 2024` into a number and lose the field. Only
 * top-level unindented lines are read, so anything needing nesting or
 * multi-line syntax is lost; this is a last resort, not a general YAML parser.
 */
function parseLenient(block) {
  const data = {}
  let found = false
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][\w-]*):[ \t]?(.*)$/.exec(line.replace(/\r$/, ''))
    if (m === null) continue
    const value = m[2].trim()
    if (value.length === 0) continue
    found = true
    data[m[1]] = COMMA_LIST_FIELDS.has(m[1])
      ? value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : value
  }
  return found ? data : undefined
}

function firstLineOf(message) {
  const end = message.indexOf('\n')
  const line = (end < 0 ? message : message.slice(0, end)).trim()
  // YAML's first line ends with the colon that introduces its code frame.
  return line.endsWith(':') ? line.slice(0, -1).trim() : line
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

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

function parseInvocationPolicy(data) {
  const miv = data['disable-model-invocation']
  const uiv = data['user-invocable']
  return {
    modelInvocable: !truthy(miv),
    userInvocable: uiv === undefined ? true : truthy(uiv),
  }
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
