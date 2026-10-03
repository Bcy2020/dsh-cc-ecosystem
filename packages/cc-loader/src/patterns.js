// Glob pattern compilation for CC permission rules.
//
// Three pattern dialects:
// - Command (Bash/PowerShell): `*` spans any chars incl. spaces; a trailing
//   `:*` is equivalent to a trailing ` *`; a trailing ` *` (space-star)
//   requires the prefix to be followed by a space or end-of-string.
// - Path (Read/Edit/Cd): gitignore-style. `**` spans directories, `*` spans
//   one path segment, `?` one char, `[...]` char classes. Anchors: `//` =
//   filesystem root, `~/` = home, `/` = relative to the settings source,
//   `./` or bare = relative to cwd.
// - Domain (WebFetch): `*` matches text between dots (a leading `*.` spans
//   any subdomain depth; a bare `*` matches everything).
//
// `[...]` character classes belong to the PATH dialect alone: CC's command and
// domain patterns have no class syntax, so `[` is a literal character there.

/** Escape a literal string for use inside a RegExp. */
export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Translate a glob to a regex body (no anchors).
 * @param {string} pattern
 * @param {{ segment?: string|null }} [opts] - segment separator: '/' for
 *   paths, '.' for domains, null for commands (`*` then spans everything).
 */
export function globToRegexBody(pattern, { segment = '/' } = {}) {
  let out = ''
  let i = 0
  const seg = segment === null ? null : segment
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 2; continue }
      out += seg === null ? '.*' : `[^${seg}]*`
      i++
    } else if (ch === '?') {
      out += seg === null ? '.' : `[^${seg}]`
      i++
    } else if (ch === '[' && seg === '/') {
      const close = pattern.indexOf(']', i + 1)
      const cls = close > 0 ? pattern.slice(i, close + 1) : ''
      if (cls !== '' && isUsableCharClass(cls)) { out += cls; i = close + 1 }
      else { out += '\\['; i++ }
    } else {
      out += escapeRegExp(ch)
      i++
    }
  }
  return out
}

/**
 * Whether a glob `[...]` slice is simultaneously a VALID regex character class.
 *
 * Gitignore classes and JS regex classes mostly agree, but a reversed range
 * such as `[11-04-54]` (read as `1-0`) is tolerated by gitignore and rejected
 * by `new RegExp`. Class compilation happens on every tool call, so letting one
 * such class throw would take down the whole permission gate; an unusable class
 * degrades to a literal `[` instead.
 * @param {string} cls - the slice from `[` through `]` inclusive.
 */
function isUsableCharClass(cls) {
  try { new RegExp(cls); return true } catch { return false }
}

/**
 * Compile a Bash/PowerShell command pattern.
 *
 * CC semantics for a trailing ` *` (space-star, or the `:*` suffix): it
 * matches commands STARTING WITH the prefix — with or without following
 * arguments — while still enforcing a word boundary (a rule `ls *` matches
 * `ls`, `ls -la`, but not `lsof`).
 * @param {string} pattern
 * @param {{ icase?: boolean }} [opts] - PowerShell matching is case-insensitive.
 */
export function compileCommandPattern(pattern, { icase = false } = {}) {
  let p = pattern
  if (p.endsWith(':*')) p = p.slice(0, -2) + ' *'
  let trailing = false
  if (p.endsWith(' *')) { trailing = true; p = p.slice(0, -2) }
  const body = globToRegexBody(p, { segment: null })
  const re = trailing
    ? new RegExp(`^${body}(?: .*)?$`, icase ? 'i' : undefined)
    : new RegExp(`^${body}$`, icase ? 'i' : undefined)
  return re
}

/**
 * Compile a Read/Edit/Cd path pattern into its anchored shape.
 * @returns {{ kind: 'absolute'|'home'|'source'|'cwd', re: RegExp,
 *            singleSegment: boolean, prefixAny: boolean }}
 */
export function compilePathPattern(pattern) {
  let p = pattern
  let kind = 'cwd'
  if (p.startsWith('//')) { kind = 'absolute'; p = p.slice(2) }
  else if (p.startsWith('~/')) { kind = 'home'; p = p.slice(2) }
  else if (p.startsWith('/')) { kind = 'source'; p = p.slice(1) }
  else if (p.startsWith('./')) { kind = 'cwd'; p = p.slice(2) }
  let trailingAny = false
  if (p.endsWith('/**')) { trailingAny = true; p = p.slice(0, -3) }
  let prefixAny = false
  if (p.startsWith('**/')) { prefixAny = true; p = p.slice(3) }
  const singleSegment = kind === 'cwd' && !p.includes('/')
  const body = globToRegexBody(p, { segment: '/' })
  // Absolute patterns match the full POSIX path, so keep the leading slash.
  const head = kind === 'absolute' ? '/' : ''
  const re = trailingAny ? new RegExp(`^${head}${body}(?:/.*)?$`) : new RegExp(`^${head}${body}$`)
  return { kind, re, singleSegment, prefixAny }
}

/**
 * Compile a WebFetch domain pattern.
 * @param {string} domain - the text after `domain:`.
 */
export function compileDomainPattern(domain) {
  const d = String(domain).trim().toLowerCase().replace(/\.$/, '')
  if (d === '*') return /.*/
  if (d.startsWith('*.')) {
    const rest = escapeRegExp(d.slice(2))
    // any subdomain at any depth, but not the bare domain
    return new RegExp(`^(.+\\.)+${rest}$`)
  }
  const body = globToRegexBody(d, { segment: '.' })
  return new RegExp(`^${body}$`)
}

/**
 * Normalize a Windows path to POSIX form for path-rule matching
 * (`C:\Users\alice` → `/c/Users/alice`), mirroring CC's Windows behavior.
 */
export function winPathToPosix(p) {
  if (typeof p !== 'string') return p
  if (!/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\\/g, '/')
  const drive = p[0].toLowerCase()
  return `/${drive}${p.slice(2).replace(/\\/g, '/')}`
}
