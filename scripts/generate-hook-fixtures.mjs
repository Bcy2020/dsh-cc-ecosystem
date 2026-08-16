// generate-hook-fixtures.mjs — deterministic CC hooks syntax matrix.
//
// Per docs/hook-fixture-matrix.md: 31 events × 5 handler types × 5 field
// variants = 775 combinations; every (event, type) pair samples 3 of 5
// variants (60%) → 465 matrix fixtures, plus 12 special-case fixtures.
// Outputs are byte-stable (same input → same files), so regeneration is safe.
//
// Usage: node scripts/generate-hook-fixtures.mjs

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const OUT = join(ROOT, 'packages', 'cc-hooks', 'testdata', 'hooks')

// ── dimension 1: the 31 official CC hook events (code.claude.com/docs/en/hooks.md) ──
const EVENTS = [
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion',
  'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop',
  'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
  'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate',
  'WorktreeRemove', 'PreCompact', 'PostCompact', 'Elicitation',
  'ElicitationResult', 'SessionEnd',
]

// matcher capability per event class (official "What the matcher filters" table)
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])
const AGENT_EVENTS = new Set(['SubagentStart', 'SubagentStop'])
const SOURCE_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'Setup', 'Notification', 'ConfigChange',
  'PreCompact', 'PostCompact', 'InstructionsLoaded', 'DirectoryAdded',
  'FileChanged', 'StopFailure', 'UserPromptExpansion', 'Elicitation', 'ElicitationResult',
])
// everything else has NO matcher support (matcher silently ignored)

const SOURCE_MATCHERS = {
  SessionStart: 'startup', SessionEnd: 'clear', Setup: 'init', Notification: 'permission_prompt',
  ConfigChange: 'project_settings', PreCompact: 'auto', PostCompact: 'auto',
  InstructionsLoaded: 'session_start', DirectoryAdded: 'slash_command', FileChanged: '.env',
  StopFailure: 'rate_limit', UserPromptExpansion: 'deploy', Elicitation: 'my-mcp', ElicitationResult: 'my-mcp',
}

// ── dimension 2: the 5 handler types ──
const TYPES = ['command', 'http', 'mcp_tool', 'prompt', 'agent']

// ── dimension 3: 5 field variants (generic fields on top of the mandatory ones) ──
const VARIANTS = [
  { id: 'F1', extra: {} },
  { id: 'F2', extra: { timeout: 30 } },
  { id: 'F3', extra: { if: 'Bash(git *)' } },
  { id: 'F4', extra: { statusMessage: 'hook running' } },
  { id: 'F5', extra: { timeout: 30, if: 'Bash(git *)', statusMessage: 'hook running' } },
]

/** Type-specific mandatory fields per handler type. */
function typeFields(type, event) {
  switch (type) {
    case 'command': return { command: `echo ${event}` }
    case 'http': return { url: `https://example.com/hook/${event}` }
    case 'mcp_tool': return { server: 'demo-server', tool: 'notify' }
    case 'prompt': return { prompt: `evaluate: {{${event}}}` }
    case 'agent': return { prompt: `verify: {{${event}}}` }
    default: throw new Error(`unknown type ${type}`)
  }
}

/** Deterministic 3-of-5 variant selection for one (event, type) pair. */
function variantIndices(eIdx, tIdx) {
  const start = (eIdx * 3 + tIdx) % VARIANTS.length
  return [0, 1, 2].map((k) => (start + k) % VARIANTS.length)
}

/** A matcher string for events that support one (rotated forms), else undefined. */
function matcherFor(event, eIdx, tIdx) {
  if (TOOL_EVENTS.has(event)) {
    const forms = [undefined, '*', 'Bash|Write', 'mcp__.*']
    return forms[(eIdx + tIdx) % forms.length]
  }
  if (AGENT_EVENTS.has(event)) {
    const forms = ['general-purpose', '^code-reviewer$', undefined]
    return forms[(eIdx + tIdx) % forms.length]
  }
  if (SOURCE_EVENTS.has(event)) {
    const forms = [SOURCE_MATCHERS[event], '*', undefined]
    return forms[(eIdx + tIdx) % forms.length]
  }
  return undefined // no matcher support
}

/** One fixture document for a (event, type, variant) combination. */
function fixture(event, type, variant) {
  const group = { hooks: [{ type, ...typeFields(type, event), ...variant.extra }] }
  return { hooks: { [event]: [group] } }
}

// ── emit helpers ──
const MATRIX_DIR = join(OUT, 'matrix')
const SPECIAL_DIR = join(OUT, 'special')
rmSync(MATRIX_DIR, { recursive: true, force: true })
rmSync(SPECIAL_DIR, { recursive: true, force: true })
mkdirSync(MATRIX_DIR, { recursive: true })
mkdirSync(SPECIAL_DIR, { recursive: true })

const byEvent = Object.fromEntries(EVENTS.map((e) => [e, 0]))
const byType = Object.fromEntries(TYPES.map((t) => [t, 0]))
const byVariant = Object.fromEntries(VARIANTS.map((v) => [v.id, 0]))
let matrixCount = 0

EVENTS.forEach((event, eIdx) => {
  TYPES.forEach((type, tIdx) => {
    for (const vi of variantIndices(eIdx, tIdx)) {
      const variant = VARIANTS[vi]
      const matcher = matcherFor(event, eIdx, tIdx)
      const doc = fixture(event, type, variant)
      if (matcher !== undefined) doc.hooks[event][0].matcher = matcher
      const name = `${event}__${type}__${variant.id}.json`
      writeFileSync(join(MATRIX_DIR, name), JSON.stringify(doc, null, 2) + '\n')
      byEvent[event]++
      byType[type]++
      byVariant[variant.id]++
      matrixCount++
    }
  })
})

// ── special cases (S1..S12, per design §5) ──
const specials = {
  'S01-invalid-matcher.json': { hooks: { PreToolUse: [{ matcher: '(unclosed', hooks: [{ type: 'command', command: 'echo x' }] }] } },
  'S02-invalid-json.json': 'not json at all {',
  'S03-settings-shape.json': { permissions: { allow: [] }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo settings' }] }] } },
  'S04-http-no-url.json': { hooks: { PostToolUse: [{ hooks: [{ type: 'http' }] }] } },
  'S05-prompt-submit-matcher-ignored.json': { hooks: { UserPromptSubmit: [{ matcher: 'Anything|at|all', hooks: [{ type: 'command', command: 'echo p' }] }] } },
  'S06-unknown-event.json': { hooks: { SomeFutureEvent: [{ hooks: [{ type: 'command', command: 'echo future' }] }] } },
  'S07-empty-hooks.json': { hooks: {} },
  'S08-if-on-non-tool-event.json': { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo s', if: 'Bash(rm *)' }] }] } },
  'S09-command-without-command-field.json': { hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] } },
  'S10-hooks-not-array.json': { hooks: { PreToolUse: { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bad' }] } } },
  'S11-timeout-not-number.json': { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo t', timeout: 'fast' }] }] } },
  'S12-compound-and-regex-matcher.json': { hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: 'echo a' }] }, { matcher: '^mcp__.*__write.*', hooks: [{ type: 'command', command: 'echo b' }] }] } },
}
let specialCount = 0
for (const [name, doc] of Object.entries(specials)) {
  writeFileSync(join(SPECIAL_DIR, name), typeof doc === 'string' ? doc + '\n' : JSON.stringify(doc, null, 2) + '\n')
  specialCount++
}

// ── coverage report (byte-stable: no timestamps, regeneration is idempotent) ──
const coverage = {
  totalCombinations: EVENTS.length * TYPES.length * VARIANTS.length,
  matrixCount,
  specialCount,
  coverageRatio: +(matrixCount / (EVENTS.length * TYPES.length * VARIANTS.length)).toFixed(3),
  byEvent,
  byType,
  byVariant,
  events: EVENTS.length,
  types: TYPES.length,
  variants: VARIANTS.length,
}
writeFileSync(join(OUT, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n')

// ── human-readable index ──
const lines = ['# Hook fixture matrix — INDEX', '',
  `- 31 events × 5 types × 5 variants = ${coverage.totalCombinations} combos; sampled ${matrixCount} (${(coverage.coverageRatio * 100).toFixed(1)}%, 3-of-5 per (event, type)).`,
  `- special fixtures: ${specialCount} (S01..S12).`,
  '', '| event | ' + TYPES.map((t) => `\`${t}\``).join(' | ') + ' |',
  '| --- |' + TYPES.map(() => ' --- |').join(''),
]
for (const e of EVENTS) {
  const cell = (tIdx) => {
    const vs = variantIndices(EVENTS.indexOf(e), tIdx).map((vi) => VARIANTS[vi].id).join(' ')
    return `${vs} (${byEvent[e]}×)` 
  }
  lines.push(`| \`${e}\` | ${TYPES.map((_, i) => cell(i)).join(' | ')} |`)
}
lines.push('', `coverage per event/type: ${matrixCount} matrix fixtures, all 31 events & 5 types present.`)
writeFileSync(join(OUT, 'INDEX.md'), lines.join('\n') + '\n')

console.log(`matrix fixtures: ${matrixCount} (target ~465, ${coverage.coverageRatio * 100}%)`)
console.log(`special fixtures: ${specialCount}`)
console.log(`events covered: ${Object.values(byEvent).filter(Boolean).length}/${EVENTS.length}`)
console.log(`types covered: ${Object.values(byType).filter(Boolean).length}/${TYPES.length}`)
console.log(`variants covered: ${Object.values(byVariant).filter(Boolean).length}/${VARIANTS.length}`)
console.log(`output: ${OUT}`)
