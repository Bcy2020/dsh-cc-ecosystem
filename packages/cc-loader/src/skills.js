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

export async function pathExists(path) {
  try { await stat(path); return true } catch { return false }
}

export async function readTextSafe(path) {
  try { return await readFile(path, { encoding: 'utf8' }) } catch { return undefined }
}

/**
 * Collect skills + commands from one `.claude` dir into `out` (project or
 * global). Each entry carries its IR status; unsupported entries are filtered.
 * @returns {Promise<{skills: object[], commands: object[], warnings: string[]}>}
 */
export async function collectClaudeDir(claudeDir, source, rank) {
  const warnings = []
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
    const parsed = parseFrontmatter(raw)
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
  const parsed = parseFrontmatter(raw)
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

export function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  let parsed
  try { parsed = parse(raw.slice(start, closing.start)) }
  catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed, body: raw.slice(closing.bodyStart) }
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
