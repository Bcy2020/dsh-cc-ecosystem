// .claude directory discovery: skills, commands, rules, settings.json.
// Extracted from dsh-claude-compat's provider (MIT, biedongbin) and generalized
// to multiple roots (project + global) with a shared IR shape.

import { readdir, stat, readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { parse } from 'yaml'

/** DSH skill-name grammar (kebab-case), same as @deepseek-ai/dsh-skill. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function isSkillName(name) {
  return SKILL_NAME_RE.test(name)
}

export async function findProjectRoot(cwd, markers = ['.git']) {
  let current = resolve(cwd)
  while (true) {
    for (const marker of markers) {
      if (await pathExists(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Claude Code project-root discovery: the closest directory containing a
 * `.claude/` directory IS the project configuration root — Claude Code walks
 * up from the cwd looking for a `.claude/` directory (confirmed by
 * anthropics/claude-code#80791: "Claude Code discovers project-level settings
 * by walking up from the current working directory looking for a .claude/
 * directory"), NOT the git root.
 *
 * Fallback: when no `.claude/` exists on the walk, fall back to the closest
 * `.git` root (compat: repositories without a `.claude/` still resolve).
 *
 * Home-directory guard: `~/.claude` (Claude Code's global config dir) and a
 * git-backed home are NEVER treated as a project root — the walk stops at
 * home. Without the guard, every session outside a project would resolve its
 * root to the user's home directory.
 *
 * @param {string} cwd - session working directory.
 * @param {object} [opts] - { homeDir } excluded from root resolution;
 *   { stopAt } optional upper walk boundary (directory at or above which the
 *   walk stops — primarily a test seam so walk-top markers on the real
 *   machine cannot interfere; callers normally leave it unset).
 * @returns {Promise<string | undefined>} project root directory.
 */
export async function findClaudeProjectRoot(cwd, opts = {}) {
  const homeDir = opts.homeDir
  const stopAt = opts.stopAt
  const isHome = (dir) => homeDir !== undefined && dir === homeDir
  const atStop = (dir) => stopAt !== undefined && dir === stopAt
  // 1. Closest .claude/ directory (CC project-scope semantics), home excluded.
  let current = resolve(cwd)
  while (true) {
    if (!isHome(current) && !atStop(current) && await pathExists(join(current, '.claude'))) return current
    const parent = dirname(current)
    if (parent === current || atStop(current)) break
    current = parent
  }
  // 2. Fallback: closest .git root, home excluded.
  current = resolve(cwd)
  while (true) {
    if (!isHome(current) && !atStop(current) && await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current || atStop(current)) return undefined
    current = parent
  }
}

export async function pathExists(path) {
  try { await stat(path); return true } catch { return false }
}

export async function readTextSafe(path) {
  try { return await readFile(path, { encoding: 'utf8' }) } catch { return undefined }
}

/**
 * Collect skills + commands from one `.claude` dir into `out` (project or
 * global). Each entry carries its IR status; unsupported entries are filtered.
 * @param {string[]} [warnings] - collector, shared with the callers that have
 *   their own warnings to report (load.js). Omit to get a fresh array back.
 * @returns {Promise<{skills: object[], commands: object[], warnings: string[]}>}
 */
export async function collectClaudeDir(claudeDir, source, rank, warnings = []) {
  const skills = await discoverSkills(join(claudeDir, 'skills'), source, rank, warnings)
  const commands = await discoverCommands(join(claudeDir, 'commands'), source, rank, warnings)
  return { skills, commands, warnings }
}

/** Rules dir `.claude/rules/*.md` — plain markdown, ordered by filename. */
export async function discoverRules(rulesDir, scope) {
  let entries
  try { entries = await readdir(rulesDir, { withFileTypes: true, encoding: 'utf8' }) }
  catch { return [] }
  const rules = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const p = join(rulesDir, e.name)
    rules.push({
      path: p,
      name: e.name,
      scope,
      status: 'DIRECT',
    })
  }
  rules.sort((a, b) => a.name.localeCompare(b.name))
  return rules
}

// ─── skills: recursive, ≤3 levels, bundle stops descent ─────────────────────

export async function discoverSkills(rootDir, source, rank, warnings = []) {
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
      const c = await parseSkillCandidateFile(skillPath, source, rank, prefix || undefined, warnings)
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

export async function discoverCommands(rootDir, source, rank, warnings = []) {
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
      rank,
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

async function parseSkillCandidateFile(path, source, rank, flatName, warnings = []) {
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
    rank,
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
