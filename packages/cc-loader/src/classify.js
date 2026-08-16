// Evaluation engine: CC deny → ask → allow folding over one tool call,
// plus tool-removal detection and component classification.
//
// Verified against code.claude.com/docs/permissions:
// - Rules are evaluated in order deny, then ask, then allow; the first match
//   in that order determines the outcome; specificity does not change order.
// - Bare tool-name deny removes the tool from context entirely.
// - Compound Bash commands: a rule must match each subcommand independently
//   (allow) / any subcommand (deny/ask); wrappers and leading env assignments
//   are stripped before matching.
// - Read deny rules also block Edit/Write tools on the same path and Bash
//   file commands (cat, head, tail, sed…).

import { parseRule } from './parse-rule.js'
import {
  ccBucket, ruleTargetsTool, isReadCoveredTool, isEditCoveredTool,
  isBashReadCommand, isBashWriteCommand, extractBashPaths,
} from './map-tools.js'
import { winPathToPosix } from './patterns.js'

/** Shell wrappers CC strips before matching (docs: "process wrappers"). */
const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob'])

/** Leading env assignments allow rules match past (a conservative subset). */
const SAFE_ENV = new Set(['NODE_ENV', 'CI', 'DEBUG', 'TERM', 'COLUMNS', 'LINES', 'EDITOR', 'PAGER', 'FORCE_COLOR', 'NO_COLOR', 'LANG', 'LC_ALL'])

/**
 * Parse raw rule strings from a merged permissions IR block into structured
 * rules, classifying each as supported/invalid.
 * @param {{deny: {raw:string}[], ask: {raw:string}[], allow: {raw:string}[]}} perm
 * @returns {{ deny: object[], ask: object[], allow: object[], invalid: object[] }}
 */
export function parseRulesFor(perm) {
  const out = { deny: [], ask: [], allow: [], invalid: [] }
  for (const bucket of ['deny', 'ask', 'allow']) {
    for (const r of perm[bucket] ?? []) {
      const rule = parseRule(r.raw, { scope: r.scope, path: r.path })
      if (rule === null || rule.invalid) { out.invalid.push(rule ?? { raw: r.raw, reason: 'unparseable' }); continue }
      rule.bucket = bucket
      out[bucket].push(rule)
    }
  }
  return out
}

/**
 * Evaluate one tool call against parsed permission rules.
 * @param {{ deny: object[], ask: object[], allow: object[] }} parsed - output of parseRulesFor.
 * @param {{ tool: string, args: Record<string, unknown> }} call
 * @param {object} env - { cwd, homeDir, settingsDirs: {user, project, local} }
 * @returns {{ decision: 'deny'|'ask'|'allow'|'none', reason?: string, rule?: object }}
 */
export function evaluateCall(parsed, call, env) {
  // 0. Bare-name / tool-glob deny removes the tool → any call is denied.
  for (const rule of parsed.deny) {
    if ((rule.kind === 'bare' || rule.kind === 'tool-glob') && matchBareTarget(rule, call.tool)) {
      return { decision: 'deny', reason: `tool "${call.tool}" is denied by rule "${rule.raw}" (removed from context)`, rule }
    }
  }
  // 1. deny
  for (const rule of parsed.deny) {
    if (matchRule(rule, call, env)) {
      return { decision: 'deny', reason: `denied by "${rule.raw}"`, rule }
    }
  }
  // 2. ask
  for (const rule of parsed.ask) {
    if (matchRule(rule, call, env)) {
      return { decision: 'ask', reason: `a Claude Code permission rule ("${rule.raw}") requests confirmation`, rule }
    }
  }
  // 3. allow
  for (const rule of parsed.allow) {
    if (matchRule(rule, call, env)) {
      return { decision: 'allow', rule }
    }
  }
  return { decision: 'none' }
}

/** Bare rules and tool-glob rules match by tool name only. */
function matchBareTarget(rule, toolName) {
  if (rule.kind === 'tool-glob') return rule.glob.test(toolName)
  return ruleTargetsTool(rule.tool, toolName)
}

function matchRule(rule, call, env) {
  switch (rule.kind) {
    case 'bare':
    case 'tool-glob':
      return matchBareTarget(rule, call.tool)
    case 'command':
      return matchCommandRule(rule, call, env)
    case 'path':
      return matchPathRule(rule, call, env)
    case 'domain':
      return matchDomainRule(rule, call)
    case 'param':
      return matchParamRule(rule, call)
    case 'agent-name':
      // DSH's subagent tool carries no CC-style agent type name → never
      // matches; the rule stays in the report for transparency.
      return false
    case 'skill-name':
      return ccBucket(call.tool) === 'Skill' && call.args?.name === rule.name
    default:
      return false
  }
}

// ─── command (Bash/PowerShell) ───────────────────────────────────────────────

function matchCommandRule(rule, call, env) {
  const bucket = ccBucket(call.tool)
  if (bucket !== 'Bash' && bucket !== 'PowerShell') return false
  if (typeof call.args?.command !== 'string') return false
  const subcommands = splitSubcommands(call.args.command)
  const allowMode = rule.bucket === 'allow'
  const stripped = subcommands.map((s) => {
    const w = stripWrapper(s, { allowEnv: false })
    // CC canonicalizes PowerShell aliases before matching: a rule written for
    // the cmdlet name (Remove-Item) also matches its aliases (del, rm, ri…).
    return bucket === 'PowerShell' ? canonicalizePowerShell(w) : w
  })
  if (allowMode) return stripped.length > 0 && stripped.every((s) => rule.command.test(s))
  return stripped.some((s) => rule.command.test(s))
}

/** Common PowerShell aliases → cmdlet names (CC canonicalizes these before matching). */
const PS_ALIASES = new Map([
  ['ri', 'Remove-Item'], ['rm', 'Remove-Item'], ['del', 'Remove-Item'], ['erase', 'Remove-Item'], ['rd', 'Remove-Item'],
  ['gci', 'Get-ChildItem'], ['ls', 'Get-ChildItem'], ['dir', 'Get-ChildItem'],
  ['cat', 'Get-Content'], ['gc', 'Get-Content'], ['type', 'Get-Content'],
  ['cp', 'Copy-Item'], ['copy', 'Copy-Item'], ['cpi', 'Copy-Item'],
  ['mv', 'Move-Item'], ['move', 'Move-Item'], ['mi', 'Move-Item'],
  ['ni', 'New-Item'], ['ii', 'Invoke-Item'], ['gi', 'Get-Item'],
  ['sl', 'Set-Location'], ['cd', 'Set-Location'], ['chdir', 'Set-Location'],
  ['pwd', 'Get-Location'], ['gl', 'Get-Location'],
])

/** Rewrite a PowerShell command's leading alias to its canonical cmdlet name. */
function canonicalizePowerShell(cmd) {
  const m = /^(\S+)(\s+.*)?$/.exec(cmd.trim())
  if (!m) return cmd
  const canonical = PS_ALIASES.get(m[1].toLowerCase())
  if (canonical === undefined) return cmd
  return m[2] !== undefined ? `${canonical}${m[2]}` : canonical
}

/** Split a compound command on CC-recognized separators, quote-aware. */
export function splitSubcommands(command) {
  const parts = []
  let current = ''
  let quote = null
  let i = 0
  const n = command.length
  while (i < n) {
    const ch = command[i]
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; i++; continue }
    if (ch === '\\') { current += ch + (command[i + 1] ?? ''); i += 2; continue }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '|&') {
      parts.push(current.trim()); current = ''; i += 2; continue
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n' || ch === '\r') {
      parts.push(current.trim()); current = ''; i++; continue
    }
    current += ch
    i++
  }
  parts.push(current.trim())
  return parts.filter((p) => p.length > 0)
}

/** Strip leading env assignments, known wrappers and wrapper arguments. */
function stripWrapper(cmd, { allowEnv = false } = {}) {
  let t = cmd.trim()
  let changed = true
  while (changed && t.length > 0) {
    changed = false
    const envm = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)\s+/.exec(t)
    if (envm) {
      if (allowEnv && !SAFE_ENV.has(envm[1])) return t // allow rules don't pass unknown env
      t = t.slice(envm[0].length).trim()
      changed = true
      continue
    }
    const wm = /^(\S+)\s+/.exec(t)
    if (wm && WRAPPERS.has(wm[1])) {
      t = t.slice(wm[0].length).trim()
      // Strip wrapper arguments: leading flags (with values) and a numeric
      // duration (`timeout 30 npm test` → `npm test`, `nice -n 5 npm test` → …).
      t = stripWrapperArgs(t)
      changed = true
      continue
    }
    if (wm && wm[1] === 'xargs' && !t.slice(wm[0].length).trim().startsWith('-')) {
      t = t.slice(wm[0].length).trim()
      changed = true
      continue
    }
  }
  return t
}

/** Strip leading flag tokens and a trailing numeric duration after a wrapper. */
function stripWrapperArgs(t) {
  let out = t
  let again = true
  while (again && out.length > 0) {
    again = false
    const fm = /^-\w+(?:=\S+)?(\s+\S+)?/.exec(out)
    if (fm) {
      out = out.slice(fm[0].length).trim()
      again = true
      continue
    }
    const nm = /^\d+(?:\.\d+)?[a-z]*(?:\s+|$)/.exec(out)
    if (nm) {
      out = out.slice(nm[0].length).trim()
      again = true
    }
  }
  return out
}

// ─── path (Read/Edit/Cd) ─────────────────────────────────────────────────────

function matchPathRule(rule, call, env) {
  // Which tools this path rule applies to:
  //   Read rules → read-like tools AND Edit/Write tools (CC: a Read deny rule
  //     also blocks Edit/Write on the same path) AND Bash read file commands.
  //   Edit rules → edit/write-like tools AND Bash write file commands.
  const bucket = ccBucket(call.tool)
  const isFileTool = isReadCoveredTool(call.tool) || isEditCoveredTool(call.tool)
  const isBash = bucket === 'Bash' || bucket === 'PowerShell'
  if (isFileTool) {
    const paths = extractFilePaths(call.args)
    return paths.some((p) => matchPath(rule, p, env))
  }
  if (isBash && typeof call.args?.command === 'string') {
    const cmd = call.args.command
    const reads = rule.tool === 'Read' && isBashReadCommand(cmd)
    const writes = rule.tool === 'Edit' && isBashWriteCommand(cmd)
    if (!reads && !writes) return false
    return extractBashPaths(cmd).some((p) => matchPath(rule, p, env))
  }
  return false
}

/** Extract candidate file paths from a file tool's arguments. */
function extractFilePaths(args) {
  if (typeof args !== 'object' || args === null) return []
  const out = []
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = args[key]
    if (typeof v === 'string' && v.length > 0) out.push(v)
  }
  return out
}

/**
 * Match one file path against a compiled path rule with anchor resolution.
 * `denyAskDepth` mirrors CC: a relative single-segment pattern (`src/**`)
 * matches at any depth for deny/ask rules but only at the anchor for allow.
 */
function matchPath(rule, filePath, env) {
  const compiled = rule.pathPattern
  const target = winPathToPosix(filePath)
  let rel
  const base = anchorBase(rule, env)
  if (base === undefined) return false
  if (compiled.kind === 'absolute') rel = target
  else if (target === base) rel = ''
  else if (target.startsWith(base.endsWith('/') ? base : `${base}/`)) rel = target.slice(base.length).replace(/^\//, '')
  else return false
  const denyAsk = rule.bucket !== 'allow'
  let source = compiled.re.source
  if (compiled.prefixAny || (compiled.singleSegment && denyAsk)) {
    // Insert an any-depth prefix after the anchor: `^secrets…` → `^(?:.*/)?secrets…`.
    source = source.replace(/^\^/, '^') // keep the ^ if present
    if (source.startsWith('^')) source = `^(?:.*/)?${source.slice(1)}`
    else source = `(?:.*/)?${source}`
  }
  return new RegExp(source).test(rel)
}

/** The anchor directory (POSIX) for a rule's `kind`, by its source scope. */
function anchorBase(rule, env) {
  const scope = rule.scope
  const home = posix(env.homeDir)
  switch (rule.pathPattern.kind) {
    case 'absolute': return ''
    case 'home': return home
    case 'source':
      if (scope === 'user') return `${home}/.claude`
      if (scope === 'local') return posix(env.cwd)
      return posix(env.projectRoot ?? env.cwd)
    case 'cwd':
    default:
      return posix(env.cwd)
  }
}

function posix(p) {
  if (typeof p !== 'string') return '/'
  return winPathToPosix(p).replace(/\/+$/, '') || '/'
}

// ─── domain (WebFetch) ───────────────────────────────────────────────────────

function matchDomainRule(rule, call) {
  if (ccBucket(call.tool) !== 'WebFetch') return false
  if (rule.domainRe === undefined) return false
  if (typeof call.args?.url !== 'string') return false
  let host
  try { host = new URL(call.args.url).hostname } catch { return false }
  return rule.domainRe.test(host.toLowerCase().replace(/\.$/, ''))
}

// ─── param (Tool(param:value)) ───────────────────────────────────────────────

function matchParamRule(rule, call) {
  const args = call.args
  if (typeof args !== 'object' || args === null) return false
  const v = args[rule.param]
  if (v === undefined) return false // an omitted param never matches (CC)
  const value = String(v)
  if (rule.value.includes('*')) {
    let out = ''
    for (const ch of rule.value) out += ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${out}$`).test(value)
  }
  return value === rule.value
}

/**
 * CC hook `if`-field matching: does the rule select this call?
 *
 * CC evaluates `if` with permission-rule syntax but as a FILTER, not a
 * decision: the hook runs when the rule matches, and stays silent otherwise.
 * Two deliberate semantic choices, both documented in CC's hooks reference:
 * - Bash/PowerShell command rules match when ANY subcommand matches (CC: "each
 *   subcommand is checked; git push matches"), which is the deny/ask (some)
 *   reading, not the allow (every) reading used by permission folding.
 * - Path rules match anchored like allow rules (CC v2.1.214+: a single-segment
 *   pattern `Edit(src/**)` matches only the working-directory anchor, not any
 *   depth), so the rule is evaluated with bucket 'allow'.
 *
 * Fail-open is the CALLER's job: a rule that cannot be parsed must run the
 * hook anyway (CC: "The filter also fails open … when the Bash command can't
 * be parsed"), so this function assumes a parsed, valid rule.
 *
 * @param {object} rule - structured rule from {@link parseRule}.
 * @param {{ tool: string, args: Record<string, unknown> }} call
 * @param {object} env - { cwd, homeDir } matching context.
 * @returns {boolean} whether the rule selects the call.
 */
export function matchesIfRule(rule, call, env) {
  switch (rule.kind) {
    case 'bare':
    case 'tool-glob':
      return matchBareTarget(rule, call.tool)
    case 'command':
      // any-subcommand semantics (deny bucket) — see header comment.
      return matchCommandRule({ ...rule, bucket: 'deny' }, call, env)
    case 'path':
      // anchored (allow bucket) semantics — see header comment.
      return matchPathRule({ ...rule, bucket: 'allow' }, call, env)
    case 'domain':
      return matchDomainRule(rule, call)
    case 'param':
      return matchParamRule(rule, call)
    case 'skill-name':
      return ccBucket(call.tool) === 'Skill' && call.args?.name === rule.name
    case 'agent-name':
      // `Agent(Name)` restricts a subagent by name; no tool call carries it.
      return false
    default:
      return false
  }
}

// ─── tool removal (bare-name deny) ───────────────────────────────────────────

/**
 * Compute the tool names a settings file removes from context (bare-name deny
 * and tool-glob deny rules). Adapters use this to hide tools per-agent.
 * @returns {{ names: string[], globs: string[] }}
 */
export function removedToolNames(parsed) {
  const names = new Set()
  const globs = new Set()
  for (const rule of parsed.deny) {
    if (rule.kind === 'bare') names.add(rule.tool)
    else if (rule.kind === 'tool-glob') globs.add(rule.tool)
  }
  return { names: [...names], globs: [...globs] }
}

// ─── component classification ────────────────────────────────────────────────

/** Component status values used across the IR. */
export const STATUS = {
  DIRECT: 'DIRECT',
  ADAPTED: 'ADAPTED',
  UNSUPPORTED: 'UNSUPPORTED',
  BLOCKED: 'BLOCKED',
}

/**
 * Classify parsed components and build the compatibility report.
 * @param {object} ir - the assembled IR (components + warnings).
 * @returns {object} report { total, direct, adapted, unsupported, blocked, warnings }
 */
export function classifyComponents(ir) {
  const counts = { total: 0, direct: 0, adapted: 0, unsupported: 0, blocked: 0 }
  const unsupported = []
  const consider = (status, kind, name, reason) => {
    counts.total++
    counts[status.toLowerCase()]++
    if (status === STATUS.UNSUPPORTED || status === STATUS.BLOCKED) {
      unsupported.push({ kind, name, status, reason })
    }
  }
  for (const s of ir.components.skills ?? []) consider(s.status ?? STATUS.DIRECT, 'skill', s.name, s.reason)
  for (const c of ir.components.commands ?? []) consider(c.status ?? STATUS.DIRECT, 'command', c.name, c.reason)
  for (const r of ir.components.rules ?? []) consider(r.status ?? STATUS.DIRECT, 'rule', r.name, r.reason)
  for (const a of ir.components.agents ?? []) consider(a.status ?? STATUS.DIRECT, 'agent', a.name, a.notes?.join('; ') || undefined)
  for (const s of ir.components.mcp?.servers ?? []) consider(s.status ?? STATUS.DIRECT, 'mcp-server', s.serverName, s.reason)
  for (const s of ir.components.lsp?.servers ?? []) consider(s.status ?? STATUS.DIRECT, 'lsp-server', s.language, s.reason)
  for (const p of ir.components.plugins ?? []) {
    consider(STATUS.DIRECT, 'plugin', p.name, undefined)
    for (const u of p.components?.unsupported ?? []) {
      counts.total++
      counts.unsupported++
      unsupported.push({ ...u, plugin: p.name })
    }
  }
  for (const mp of ir.components.marketplaces ?? []) {
    if (mp.marketplace === undefined) continue
    consider(STATUS.DIRECT, 'marketplace', mp.marketplace.name, undefined)
    for (const entry of mp.plugins ?? []) {
      consider(entry.status ?? STATUS.UNSUPPORTED, 'marketplace-plugin', entry.name, entry.reason)
    }
  }
  const perm = ir.components.permissions
  if (perm !== undefined) {
    if (perm.status === STATUS.DIRECT || perm.status === STATUS.UNSUPPORTED) {
      consider(perm.status, 'permissions', 'settings.json', perm.status === STATUS.UNSUPPORTED ? 'no permission rules found' : undefined)
    }
  }
  for (const u of ir.components.unsupported ?? []) {
    counts.total++
    counts.unsupported++
    unsupported.push(u)
  }
  return { ...counts, unsupported, warnings: ir.warnings ?? [] }
}
