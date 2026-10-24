// Auto-memory discovery, copied from Claude Code.
//
// CC's auto-memory lives at `<config-dir>/projects/<slug>/memory/`:
//   MEMORY.md           hand-written index, re-read for the system prompt
//   <fact-slug>.md      one memory per file
//   archive/            no longer indexed; never injected
//
// Everything here mirrors the CLI (2.1.275 inline sources):
//   - defaultPath:  projects + slug(canonical cwd) + "memory"   (module-0116.js:26453)
//   - slug:         the absolute path with every non-alphanumeric replaced by "-",
//                   200-char cap with a hash suffix                    (module-0063.js:610)
//   - autoMemoryDirectory: user/local settings, `~/` expanded, project
//                   settings deliberately ignored for security         (module-0045.js:7007)
//   - scan:         recursive *.md, hidden segments / team / logs / sessions /
//                   proposals excluded, MEMORY.md skipped, 200 files, newest first
//                   (module-0260.js:157, module-0316.js:75358)
//   - index:        200 lines / 25,000 characters, whole-line truncation with a
//                   WARNING line                                            (module-0178.js:4064)
//
// Two deliberate deviations, both documented in README:
//   - `archive/` is excluded from listing too (the issue's acceptance requires it;
//     CC only stops indexing it because the model writes MEMORY.md by hand).
//   - project settings never choose autoMemoryDirectory: CC gates them behind an
//     interactive trust prompt DSH does not have.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** CC's per-project slug cap before the hash suffix (module-0063.js:601). */
export const SLUG_MAX = 200
/** File-scan cap (module-0316.js:75328). */
export const MAX_MEMORY_FILES = 200
/** Prompt-index line cap (module-0178.js yD). */
export const MAX_INDEX_LINES = 200
/** Prompt-index character cap (module-0178.js dG). */
export const MAX_INDEX_CHARS = 25000
/** Per-file read cap: CC's scan skips files above 1 MiB. */
export const MAX_MEMORY_BYTES = 1024 * 1024
/** Memory frontmatter types CC recognises. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
/** Pinned memories injected into every request (CC's `are`). */
export const MAX_PINNED = 4
/** Pinned candidates scanned before the read/cap pass (CC's `Qko = are * 2`). */
const PINNED_CANDIDATES = MAX_PINNED * 2
/** Top-level directory names the scan never descends into (module-0260.js:157). */
const EXCLUDED_TOP = new Set(['team', 'logs', 'sessions', 'proposals'])
/** Archive is not part of the live index. */
const ARCHIVE = 'archive'

/**
 * Resolve the Claude config directory.
 * @param {{ homeDir?: string, globalClaudeDir?: string }} [opts]
 * @returns {string}
 */
export function claudeConfigDir(opts = {}) {
  return opts.globalClaudeDir ?? join(opts.homeDir ?? homedir(), '.claude')
}

/**
 * CC's project slug: every character outside [a-zA-Z0-9] becomes "-".
 * Case is preserved (Windows drive letters are stored as the caller spelled
 * them, which is why one machine can hold both `d--project` and `D--project`).
 * @param {string} path - absolute path, ideally symlink-resolved.
 * @returns {string}
 */
export function slugifyPath(path) {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Slug for a session cwd, after resolving symlinks like CC's canonical root.
 * @param {string} cwd
 * @returns {string}
 */
export function projectSlug(cwd) {
  let canonical = resolve(cwd)
  try { canonical = realpathSync.native(canonical) } catch { /* missing path: keep the absolute form */ }
  const slug = slugifyPath(canonical)
  if (slug.length <= SLUG_MAX) return slug
  // CC appends a Bun hash we cannot reproduce. Long paths fall back to a prefix
  // match in findProjectDir(), so the returned value is only used for writing.
  return `${slug.slice(0, SLUG_MAX)}-${hashBase36(canonical)}`
}

/** Deterministic base36 hash used only for the >200-char write path. */
function hashBase36(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

/**
 * Locate the existing project directory for a cwd, tolerating Windows case
 * drift and CC's 200-char hash suffix. Returns a candidate path even when no
 * directory exists yet, so a writable session can create it.
 * @param {string} projectsDir
 * @param {string} cwd
 * @returns {string}
 */
export function findProjectDir(projectsDir, cwd) {
  const slug = projectSlug(cwd)
  const entries = safeReaddir(projectsDir)
  if (slug.length <= SLUG_MAX) {
    const exact = join(projectsDir, slug)
    if (existsSync(exact)) return exact
    // Windows filesystems are case-insensitive and CC preserves whatever case
    // the caller's cwd carried, so the same project can appear as both
    // `d--project` and `D--project`. Match case-insensitively there only;
    // POSIX keeps CC's exact-name rule.
    if (process.platform !== 'win32') return exact
    const lower = slug.toLowerCase()
    const match = entries.find((name) => name.toLowerCase() === lower)
    return match === undefined ? exact : join(projectsDir, match)
  }
  const prefix = `${slug.slice(0, SLUG_MAX)}-`
  const match = entries.find((name) => name.startsWith(prefix))
  return match === undefined ? join(projectsDir, slug) : join(projectsDir, match)
}

/**
 * Expand a settings-provided `autoMemoryDirectory`.
 * `~/` is resolved against the home directory; `..` escapes are rejected, as
 * CC's Bm() does. Relative and non-string values are ignored.
 * @param {unknown} value
 * @param {string} homeDir
 * @returns {string | undefined}
 */
export function expandMemoryDirectory(value, homeDir) {
  if (typeof value !== 'string') return undefined
  let text = value.trim()
  if (text.length === 0) return undefined
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    const rest = text.slice(2)
    const normalized = rest.length === 0 ? '.' : rest.replace(/[/\\]+$/, '')
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('..\\')) return undefined
    text = join(homeDir, normalized)
  }
  if (!isAbsolute(text)) return undefined
  return resolve(text).normalize('NFC')
}

/**
 * Read `autoMemoryDirectory` the way CC does for a session.
 * Precedence is local > user. Project settings are excluded on purpose: CC
 * accepts them only behind an interactive trust prompt, and honoring a
 * checked-in path without that prompt would let a repository redirect memory.
 * @param {string} cwd
 * @param {{ homeDir?: string, globalClaudeDir?: string }} [opts]
 * @returns {{ directory?: string, source?: string }}
 */
export function readAutoMemoryDirectory(cwd, opts = {}) {
  const homeDir = opts.homeDir ?? homedir()
  const candidates = [
    { source: 'local', path: join(resolve(cwd), '.claude', 'settings.local.json') },
    { source: 'user', path: join(claudeConfigDir(opts), 'settings.json') },
  ]
  for (const candidate of candidates) {
    const data = readJson(candidate.path)
    const directory = expandMemoryDirectory(data?.autoMemoryDirectory, homeDir)
    if (directory !== undefined) return { directory, source: candidate.source }
  }
  return {}
}

/**
 * Resolve the memory directory for one session cwd.
 * @param {string} cwd
 * @param {{ homeDir?: string, globalClaudeDir?: string }} [opts]
 * @returns {string}
 */
export function resolveMemoryDir(cwd, opts = {}) {
  // Deployment override (DSH config), not a CC setting: useful when the
  // session cwd is not the project whose memory should be surfaced, and for
  // tests that must not touch the real ~/.claude tree.
  const override = expandMemoryDirectory(opts.memoryDirectory, opts.homeDir ?? homedir())
  if (override !== undefined) return override
  const custom = readAutoMemoryDirectory(cwd, opts)
  if (custom.directory !== undefined) return custom.directory
  const projectsDir = join(claudeConfigDir(opts), 'projects')
  return join(findProjectDir(projectsDir, cwd), 'memory')
}

/**
 * Read and truncate the MEMORY.md index.
 * @param {string} memoryDir
 * @param {{ maxLines?: number, maxChars?: number }} [limits]
 * @returns {{ path: string, exists: boolean, content: string, warning?: string, lineCount: number, charCount: number }}
 */
export function readMemoryIndex(memoryDir, limits = {}) {
  const path = join(memoryDir, 'MEMORY.md')
  let raw
  try {
    raw = readFileSync(path, { encoding: 'utf8' })
  } catch {
    return { path, exists: false, content: '', lineCount: 0, charCount: 0 }
  }
  const result = truncateIndex(raw, limits)
  return { path, exists: true, ...result }
}

/**
 * CC's index budget: whole-line truncation at 200 lines / 25,000 characters,
 * whichever comes first, followed by one WARNING paragraph naming the first
 * line that was cut. Character counting matches CC (JS string length, so
 * astral characters count twice).
 * @param {string} raw
 * @param {{ maxLines?: number, maxChars?: number }} [limits]
 * @returns {{ content: string, warning?: string, lineCount: number, charCount: number }}
 */
export function truncateIndex(raw, limits = {}) {
  return truncateText(raw, { ...limits, label: 'index' })
}

/**
 * CC's per-memory body budget (`Zht(content, "memory")`): the same 200-line /
 * 25,000-character whole-line truncation as the index, with the body-specific
 * warning sentence. Pinned bodies are injected through this.
 * @param {string} raw
 * @param {{ maxLines?: number, maxChars?: number }} [limits]
 * @returns {{ content: string, warning?: string, lineCount: number, charCount: number }}
 */
export function truncateMemoryBody(raw, limits = {}) {
  return truncateText(raw, { ...limits, label: 'memory' })
}

function truncateText(raw, limits = {}) {
  const maxLines = limits.maxLines ?? MAX_INDEX_LINES
  const maxChars = limits.maxChars ?? MAX_INDEX_CHARS
  const label = limits.label === 'memory' ? 'memory' : 'index'
  const trimmed = raw.trim()
  const lines = trimmed.length === 0 ? [] : trimmed.split('\n')
  const lineCount = lines.length
  const charCount = trimmed.length
  const lineTrimmed = lineCount > maxLines
  let content = lineTrimmed ? lines.slice(0, maxLines).join('\n') : trimmed
  let charTrimmed = false
  if (content.length > maxChars) {
    const newline = content.lastIndexOf('\n', maxChars)
    content = content.slice(0, newline > 0 ? newline : maxChars)
    charTrimmed = true
  }
  if (!lineTrimmed && !charTrimmed) return { content, lineCount, charCount }

  const keptLines = content.length === 0 ? 0 : content.split('\n').length
  const cutCount = Math.max(0, lineCount - keptLines)
  const firstCut = lines[keptLines]?.trim()
  const cutDescription = cutCount > 0
    ? `${cutCount} of ${lineCount} lines were cut off, starting at line ${keptLines + 1}${firstCut ? ` ("${firstCut.slice(0, 80)}")` : ''}`
    : `everything after the first ${content.length} characters of line 1 was cut off`
  const sizeDescription = lineTrimmed && charTrimmed
    ? `${lineCount} lines and ${formatSize(charCount)}`
    : lineTrimmed
      ? `${lineCount} lines (limit: ${maxLines})`
      : `${formatSize(charCount)} (limit: ${formatSize(maxChars)}) — index entries are too long`
  const warning = label === 'memory'
    ? `this memory file is ${sizeDescription}. Only part of it was loaded: ${cutDescription}. Keep each memory file focused on one topic.`
    : `MEMORY.md is ${sizeDescription}. Only part of it was loaded: ${cutDescription}. Keep index entries to one line under ~200 chars; move detail into topic files.`
  return { content: `${content}\n\n> WARNING: ${warning}`, warning, lineCount, charCount }
}

/** CC prints sizes in binary KB with one decimal (module-0178.js Ft). */
function formatSize(chars) {
  return chars < 1024 ? `${chars}B` : `${(chars / 1024).toFixed(1)}KB`
}

/**
 * Parse the small frontmatter subset memory files use. This is deliberately
 * not a YAML parser: CC reads `name`, `description`, and the `metadata.*`
 * fields, and those are flat scalars in every memory file the CLI writes.
 * @param {string} text
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { data: {}, body: text }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') { end = index; break }
  }
  if (end < 0) return { data: {}, body: text }
  const data = {}
  let parent
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (top !== null) {
      parent = top[1]
      data[parent] = unquote(top[2])
      continue
    }
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (nested !== null && parent !== undefined) {
      if (typeof data[parent] !== 'object' || data[parent] === null) data[parent] = {}
      data[parent][nested[1]] = unquote(nested[2])
    }
  }
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n/, '') }
}

function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Flatten the frontmatter fields the adapters consume. The CLI's current
 * format nests them under `metadata`; older files also carry a top level.
 * @param {Record<string, any>} data
 * @returns {{ name?: string, description?: string, type?: string, modified?: string, pinned?: string, originSessionId?: string }}
 */
export function memoryMeta(data) {
  const metadata = typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}
  return {
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    ...(typeof metadata.type === 'string' ? { type: metadata.type } : typeof data.type === 'string' ? { type: data.type } : {}),
    ...(typeof metadata.modified === 'string' ? { modified: metadata.modified } : typeof data.modified === 'string' ? { modified: data.modified } : {}),
    ...(metadata.pinned !== undefined ? { pinned: String(metadata.pinned) } : data.pinned !== undefined ? { pinned: String(data.pinned) } : {}),
    ...(typeof metadata.originSessionId === 'string' ? { originSessionId: metadata.originSessionId } : {}),
  }
}

/**
 * List saved memories, newest first, capped like CC's scan.
 * @param {string} memoryDir
 * @param {{ maxFiles?: number, maxBytes?: number, includeArchive?: boolean }} [opts]
 * @returns {Array<{ name: string, path: string, description: string | null, type: string | null, pinned: boolean, modified_ms: number, size: number }>}
 */
export function listMemories(memoryDir, opts = {}) {
  return scanMemories(memoryDir, opts).slice(0, opts.maxFiles ?? MAX_MEMORY_FILES)
}

/** All memory entries, newest first (before the list cap). */
function scanMemories(memoryDir, opts = {}) {
  const files = []
  walkMemoryDir(memoryDir, '', files, opts)
  files.sort((left, right) => right.modified_ms - left.modified_ms)
  return files
}

/** CC's `lre`: true / false / absent / malformed. Only "true" injects. */
function pinnedState(value) {
  if (value === undefined) return 'absent'
  const text = String(value).trim().toLowerCase()
  if (text === 'true') return 'true'
  if (text === 'false') return 'false'
  return 'malformed'
}

// Pinned bodies change rarely and scanning every memory file is not free; CC
// caches the scan per session. Key = resolved memory directory.
const pinnedCache = new Map()

/**
 * Pinned memories injected before the index, newest first, at most `maxPinned`
 * (CC's `are = 4`). The body excludes frontmatter and is truncated with the
 * per-memory budget (200 lines / 25,000 chars), exactly like CC's
 * `Zht(content, "memory")`. Results are cached briefly; writes invalidate.
 * @param {string} memoryDir
 * @param {{ maxPinned?: number, maxBytes?: number, includeArchive?: boolean, maxLines?: number, maxChars?: number, cacheTtlMs?: number }} [opts]
 * @returns {Array<{ path: string, content: string }>}
 */
export function readPinnedMemories(memoryDir, opts = {}) {
  const directory = resolve(memoryDir)
  const ttl = opts.cacheTtlMs ?? 5000
  const cached = pinnedCache.get(directory)
  if (cached !== undefined && Date.now() - cached.at < ttl) return cached.entries

  const maxPinned = opts.maxPinned ?? MAX_PINNED
  const entries = []
  if (maxPinned > 0) {
    const candidates = scanMemories(directory, opts)
      .filter((entry) => entry.pinned)
      .slice(0, maxPinned * 2)
    for (const candidate of candidates) {
      if (entries.length >= maxPinned) break
      let raw
      try { raw = readFileSync(candidate.path, { encoding: 'utf8' }) } catch { continue }
      const body = parseFrontmatter(raw).body.trim()
      if (body.length === 0) continue
      entries.push({ path: candidate.path, content: truncateMemoryBody(body, opts).content })
    }
  }
  pinnedCache.set(directory, { at: Date.now(), entries })
  return entries
}

/** Drop the pinned scan cache for one directory (called after a write/edit). */
function invalidatePinned(memoryDir) {
  try { pinnedCache.delete(resolve(memoryDir)) } catch { /* best effort */ }
}

function walkMemoryDir(directory, prefix, files, opts) {
  const includeArchive = opts.includeArchive === true
  const maxBytes = opts.maxBytes ?? MAX_MEMORY_BYTES
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (prefix.length === 0 && EXCLUDED_TOP.has(entry.name.toLowerCase())) continue
      if (!includeArchive && entry.name.toLowerCase() === ARCHIVE) continue
      walkMemoryDir(join(directory, entry.name), name, files, opts)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.md') || name === 'MEMORY.md') continue
    const path = join(directory, entry.name)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.size > maxBytes) continue
    let text
    try { text = readFileSync(path, { encoding: 'utf8' }) } catch { continue }
    const { data, body } = parseFrontmatter(text)
    const meta = memoryMeta(data)
    const parsedModified = meta.modified === undefined ? Number.NaN : Date.parse(meta.modified)
    files.push({
      name,
      path,
      description: meta.description ?? firstHeading(body),
      type: MEMORY_TYPES.includes(meta.type) ? meta.type : null,
      pinned: pinnedState(meta.pinned) === 'true',
      modified_ms: Number.isNaN(parsedModified) ? stat.mtimeMs : parsedModified,
      size: stat.size,
    })
  }
}

function firstHeading(body) {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#{1,6}\s+/, '').trim()
    if (text.length > 0) return text.slice(0, 120)
  }
  return null
}

/**
 * Read one memory by path relative to the memory directory.
 * @param {string} memoryDir
 * @param {string} name
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ name: string, path: string, content: string, truncated: boolean }}
 */
export function readMemory(memoryDir, name, opts = {}) {
  const path = memoryPath(memoryDir, name, { allowIndex: true, includeArchive: opts.includeArchive === true })
  const maxBytes = opts.maxBytes ?? MAX_MEMORY_BYTES
  let raw
  try { raw = readFileSync(path, { encoding: 'utf8' }) } catch (error) {
    throw new Error(`memory "${name}" could not be read: ${String(error.message ?? error)}`)
  }
  const truncated = raw.length > maxBytes
  return { name: normalizeName(name), path, content: truncated ? raw.slice(0, maxBytes) : raw, truncated }
}

/**
 * Create or replace one memory file. The frontmatter is generated in the
 * format the CLI's scan reads (`metadata.type`, `metadata.modified`).
 * @param {string} memoryDir
 * @param {{ name: string, description: string, type: string, content: string, pinned?: boolean, originSessionId?: string }} input
 * @returns {{ name: string, path: string, operation: 'create' | 'update' }}
 */
export function writeMemory(memoryDir, input) {
  const slug = normalizeName(input.name).replace(/\.md$/i, '')
  if (slug.toLowerCase() === 'memory') throw new Error('MEMORY.md is the index — edit it with cc_memory_edit, not cc_memory_write')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`memory name "${input.name}" must be a short kebab-case slug ([a-z0-9] separated by "-")`)
  }
  const name = `${slug}.md`
  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    throw new Error('memory description is required (one line)')
  }
  if (input.description.includes('\n')) throw new Error('memory description must be one line')
  if (!MEMORY_TYPES.includes(input.type)) {
    throw new Error(`memory type must be one of ${MEMORY_TYPES.join(', ')}`)
  }
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new Error('memory content is required')
  }
  const path = memoryPath(memoryDir, name, { allowIndex: false, includeArchive: false })
  const existing = tryRead(path)
  const existingMeta = existing === undefined ? {} : memoryMeta(parseFrontmatter(existing).data)
  const origin = input.originSessionId ?? existingMeta.originSessionId
  mkdirSync(dirname(path), { recursive: true })
  const text = renderMemoryFile({
    name: slug,
    description: input.description.trim(),
    type: input.type,
    content: input.content.trim(),
    pinned: input.pinned === true || existingMeta.pinned === 'true',
    ...(origin === undefined ? {} : { originSessionId: origin }),
  })
  atomicWrite(path, text)
  invalidatePinned(memoryDir)
  return { name, path, operation: existing === undefined ? 'create' : 'update' }
}

/**
 * Replace text inside a memory file (or inside MEMORY.md). `old_string` must
 * be unique unless `replace_all` is true — the same rule as CC's Edit tool.
 * @param {string} memoryDir
 * @param {{ name: string, oldString: string, newString: string, replaceAll?: boolean }} input
 * @returns {{ name: string, path: string, replacements: number }}
 */
export function editMemory(memoryDir, input, opts = {}) {
  const name = normalizeName(input.name)
  if (typeof input.oldString !== 'string' || input.oldString.length === 0) {
    throw new Error('old_string is required')
  }
  if (typeof input.newString !== 'string') throw new Error('new_string is required')
  const path = memoryPath(memoryDir, name, { allowIndex: true, includeArchive: opts.includeArchive === true })
  let text
  try { text = readFileSync(path, { encoding: 'utf8' }) } catch (error) {
    throw new Error(`memory "${name}" could not be read: ${String(error.message ?? error)}`)
  }
  const occurrences = text.split(input.oldString).length - 1
  if (occurrences === 0) throw new Error(`old_string was not found in "${name}"`)
  if (occurrences > 1 && input.replaceAll !== true) {
    throw new Error(`old_string appears ${occurrences} times in "${name}"; pass replace_all or include more context`)
  }
  let next
  if (input.replaceAll === true) next = text.split(input.oldString).join(input.newString)
  else {
    const at = text.indexOf(input.oldString)
    next = text.slice(0, at) + input.newString + text.slice(at + input.oldString.length)
  }
  if (name !== 'MEMORY.md') next = bumpModified(next)
  atomicWrite(path, next)
  invalidatePinned(memoryDir)
  return { name, path, replacements: input.replaceAll === true ? occurrences : 1 }
}

/** Render the frontmatter + body CC's scan expects. */
export function renderMemoryFile({ name, description, type, content, pinned, originSessionId }) {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${type}`,
    ...(originSessionId === undefined ? [] : [`  originSessionId: ${originSessionId}`]),
    `  modified: ${new Date().toISOString()}`,
    ...(pinned === true ? ['  pinned: true'] : []),
    '---',
    '',
    content,
    '',
  ]
  return lines.join('\n')
}

/** Refresh `metadata.modified` (or top-level `modified`) in the frontmatter. */
function bumpModified(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return text
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') { end = index; break }
  }
  if (end < 0) return text
  const stamp = new Date().toISOString()
  let replaced = false
  for (let index = 1; index < end; index += 1) {
    if (/^\s+modified:\s*/.test(lines[index])) {
      lines[index] = lines[index].replace(/^(\s+modified:\s*).*$/, `$1${stamp}`)
      replaced = true
    }
  }
  if (!replaced) {
    for (let index = 1; index < end; index += 1) {
      if (/^modified:\s*/.test(lines[index])) {
        lines[index] = `modified: ${stamp}`
        replaced = true
      }
    }
  }
  return lines.join('\n')
}

/**
 * Resolve a memory-relative name to an absolute path and enforce containment.
 * Rejects absolute paths, `..`, hidden segments, excluded top-level dirs, and
 * non-markdown names. `MEMORY.md` is allowed only when the caller opts in.
 * @param {string} memoryDir
 * @param {string} name
 * @param {{ allowIndex: boolean }} opts
 * @returns {string}
 */
export function memoryPath(memoryDir, name, opts) {
  const relativeName = normalizeName(name)
  if (isAbsolute(relativeName) || /^[A-Za-z]:/.test(relativeName)) {
    throw new Error(`invalid memory path "${name}" (absolute paths are not allowed)`)
  }
  if (opts.allowIndex !== true && relativeName === 'MEMORY.md') {
    throw new Error('MEMORY.md is the index and is not a writable memory file')
  }
  const segments = relativeName.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`invalid memory path "${name}"`)
    }
    if (segment.startsWith('.')) throw new Error(`invalid memory path "${name}" (hidden segment)`)
  }
  if (segments.length === 1 && EXCLUDED_TOP.has(segments[0].toLowerCase())) {
    throw new Error(`invalid memory path "${name}" (reserved directory)`)
  }
  if (segments.length > 1 && EXCLUDED_TOP.has(segments[0].toLowerCase())) {
    throw new Error(`invalid memory path "${name}" (reserved directory)`)
  }
  if (segments.length > 1 && segments[0].toLowerCase() === ARCHIVE && opts.includeArchive !== true) {
    throw new Error(`invalid memory path "${name}" (archive is not a live memory)`)
  }
  if (!relativeName.endsWith('.md')) throw new Error(`memory "${name}" must end in .md`)
  const base = resolve(memoryDir)
  const target = resolve(base, relativeName)
  const relation = relative(base, target)
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`memory path "${name}" escapes the memory directory`)
  }
  return target
}

/** Forward-slash relative name, accepting Windows separators from the model. */
export function normalizeName(name) {
  if (typeof name !== 'string') throw new Error('memory name must be a string')
  const text = name.trim().replaceAll('\\', '/')
  if (text.length === 0) throw new Error('memory name must not be empty')
  return text
}

function tryRead(path) {
  try { return readFileSync(path, { encoding: 'utf8' }) } catch { return undefined }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, { encoding: 'utf8' })) } catch { return undefined }
}

function safeReaddir(path) {
  try { return readdirSync(path) } catch { return [] }
}

/** Temp-file + rename, so a crash cannot leave a half-written memory. */
function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, text, { encoding: 'utf8' })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
}

/**
 * True when `child` is inside `parent` (used by callers that already resolved
 * a path themselves).
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}
