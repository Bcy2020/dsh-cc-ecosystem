// CC permission rule syntax parser: `Tool` or `Tool(specifier)`.
//
// Verified against code.claude.com/docs/permissions ("Permission rule syntax",
// "Match by input parameter", "Tool name wildcards", per-tool rules).
// A rule is parsed into a structured object with a `kind`:
//   bare        — `Bash` / `Bash(*)` / any tool without specifier
//   tool-glob   — glob in tool-name position (`mcp__*`, `B*`…)
//   command     — Bash/PowerShell command pattern
//   path        — Read/Edit/Cd gitignore path pattern
//   domain      — WebFetch `domain:…`
//   agent-name  — `Agent(Name)` subagent restriction
//   param       — `Tool(param:value)` top-level input-parameter match
//   unknown     — spec we cannot faithfully evaluate (reported, not enforced)

import { compileCommandPattern, compilePathPattern, compileDomainPattern } from './patterns.js'

const TOOL_RE = /^([A-Za-z_*][A-Za-z0-9_*]*(?:__[A-Za-z0-9_*:-]+)*)(?:\(([^)]*)\))?$/

/** Tool input fields that cannot be matched via `Tool(param:value)` (CC warns and ignores). */
const PRIMARY_FIELDS = new Set(['command', 'file_path', 'path', 'url', 'notebook_path'])

/**
 * Parse one CC rule string.
 * @param {string} raw
 * @param {{ scope?: string, path?: string }} [meta] - source scope/file for reporting.
 * @returns {object|null} structured rule, or null when unparseable.
 */
export function parseRule(raw, meta = {}) {
  const text = String(raw).trim()
  const m = TOOL_RE.exec(text)
  if (!m) return { raw: text, tool: null, spec: null, kind: 'unknown', invalid: true, reason: `unparseable rule "${text}"`, ...meta }
  const tool = m[1]
  const spec = m[2] === undefined ? null : m[2].trim()
  const base = { raw: text, tool, spec, scope: meta.scope, path: meta.path }

  // Tool-name glob (`*`, `mcp__*`, `mcp__server__*`, `B*`).
  if (tool.includes('*')) return { ...base, kind: 'tool-glob', glob: compileToolGlob(tool) }

  if (spec === null || spec === '') return { ...base, kind: 'bare' }

  // `Tool(*)` on Bash/PowerShell is equivalent to a bare rule.
  if ((tool === 'Bash' || tool === 'PowerShell') && (spec === '*' || spec === ':*')) {
    return { ...base, kind: 'bare' }
  }

  // Tool-specific specifiers FIRST so they win over the generic param:value
  // shape: `Bash(ls:*)` is a command pattern (the `:*` trailing suffix), and
  // `WebFetch(domain:…)` is a domain rule — neither is a param match.
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (spec.endsWith(':*')) {
      return { ...base, kind: 'command', command: compileCommandPattern(spec, { icase: tool === 'PowerShell' }), icase: tool === 'PowerShell' }
    }
  }
  if (tool === 'WebFetch' && spec.startsWith('domain:')) {
    return { ...base, kind: 'domain', domain: spec.slice(7), domainRe: compileDomainPattern(spec.slice(7)) }
  }

  // param:value — before remaining tool-specific handling so `Agent(model:opus)`
  // and `Bash(run_in_background:true)` parse as param rules.
  const pm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(spec)
  if (pm) {
    const param = pm[1]
    const value = pm[2]
    if (PRIMARY_FIELDS.has(param)) {
      return { ...base, kind: 'unknown', invalid: true, reason: `cannot match primary field via param syntax (${tool}(${param}:…))` }
    }
    return { ...base, kind: 'param', param, value }
  }

  switch (tool) {
    case 'WebFetch':
      return { ...base, kind: 'unknown', invalid: true, reason: `WebFetch rules require a domain: specifier` }
    case 'Agent':
      // Agent(AgentName) restricts a subagent by name.
      return { ...base, kind: 'agent-name', name: spec }
    case 'Skill':
      // Skill(name) restricts a skill invocation by name.
      return { ...base, kind: 'skill-name', name: spec }
    case 'Read':
    case 'Edit':
    case 'Cd':
      return { ...base, kind: 'path', pathPattern: compilePathPattern(spec) }
    case 'Bash':
    case 'PowerShell':
      return { ...base, kind: 'command', command: compileCommandPattern(spec, { icase: tool === 'PowerShell' }), icase: tool === 'PowerShell' }
    default:
      // A spec on an unknown tool: CC only supports param:value there (handled
      // above) or tool-specific syntax we do not know — report, don't enforce.
      return { ...base, kind: 'unknown', invalid: true, reason: `unsupported specifier on tool ${tool}` }
  }
}

function compileToolGlob(tool) {
  // Full-name match; `*` spans everything (CC: pattern must match the full tool name).
  let out = ''
  for (const ch of tool) out += ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${out}$`)
}
