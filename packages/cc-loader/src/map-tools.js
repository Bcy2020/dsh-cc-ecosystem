// Map DSH tool names to Claude Code tool buckets.
//
// CC permission rules are written against CC tool names (Bash, Read, Edit,
// WebFetch, Agent, Skill, MCP servers…). DSH tools use their own names
// (bash, pwsh, read, write, glob, grep, web_fetch, subagent, terminal_*…).
// This module owns the mapping in both directions.
//
// Verified against DSH's shipped tool inventory (packages/core/tools
// gen-tool-catalog) and CC permissions reference (code.claude.com/docs/permissions).

/** Exact-name mapping: DSH tool name → CC bucket. */
const BUCKET_BY_TOOL = Object.freeze({
  bash: 'Bash',
  pwsh: 'PowerShell',
  read: 'Read',
  read_image: 'Read',
  write: 'Write',
  edit: 'Edit',
  str_replace_editor: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  subagent: 'Agent',
  skill: 'Skill',
  ask_user_question: 'AskUserQuestion',
})

/** Tools CC's Read rules best-effort cover (read-like built-in tools). */
const READ_COVERED = Object.freeze(['read', 'read_image', 'glob', 'grep'])
/** Tools CC's Edit rules cover (write/edit-like built-in tools). */
const EDIT_COVERED = Object.freeze(['edit', 'str_replace_editor', 'write'])

/** Bash file commands CC's Read deny rules intercept (cat, head, tail, sed…). */
const BASH_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'sed', 'less', 'more', 'nl', 'od', 'strings', 'tac', 'wc',
])
/** Bash file commands CC's Edit deny rules intercept (write-capable). */
const BASH_WRITE_COMMANDS = new Set([
  'sed', 'awk', 'tee', 'dd', 'cp', 'mv', 'rm', 'truncate', 'touch', 'mkdir', 'ln',
])

/**
 * Map one DSH tool name to the CC bucket its rules were written for.
 * MCP tools are their own bucket (rule tool names are full `mcp__…` names).
 * @returns {string|null} CC bucket name, or null when unmappable (rules may
 *   still match by exact DSH tool name).
 */
export function ccBucket(toolName) {
  if (typeof toolName !== 'string') return null
  if (toolName.startsWith('mcp__')) return toolName
  if (toolName.startsWith('terminal_')) return 'Bash'
  return BUCKET_BY_TOOL[toolName] ?? null
}

/**
 * Whether a rule's tool target (CC bucket or exact name, may contain `*`)
 * denotes `toolName`. Used for bare rules and tool-glob rules.
 */
export function ruleTargetsTool(ruleTool, toolName) {
  if (ruleTool.includes('*')) {
    let out = ''
    for (const ch of ruleTool) out += ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${out}$`).test(toolName)
  }
  if (ruleTool.startsWith('mcp__')) {
    // `mcp__server` matches every tool of that server (`mcp__server__tool`).
    return toolName === ruleTool || toolName.startsWith(`${ruleTool}__`)
  }
  const bucket = ccBucket(toolName)
  return ruleTool === toolName || (bucket !== null && ruleTool === bucket)
}

/** Is `toolName` in the set CC's `Read` rules cover (incl. read-like tools)? */
export function isReadCoveredTool(toolName) {
  return READ_COVERED.includes(toolName)
}

/** Is `toolName` in the set CC's `Edit` rules cover (incl. write tools)? */
export function isEditCoveredTool(toolName) {
  return EDIT_COVERED.includes(toolName)
}

/** Is this a Bash file command whose paths CC's Read deny rules intercept? */
export function isBashReadCommand(command) {
  return BASH_READ_COMMANDS.has(firstWord(command))
}

/** Is this a Bash file command whose paths CC's Edit deny rules intercept? */
export function isBashWriteCommand(command) {
  return BASH_WRITE_COMMANDS.has(firstWord(command))
}

/**
 * Extract candidate file paths from a Bash command's arguments, skipping
 * flags. Best-effort, mirroring CC's "file commands Claude Code recognizes
 * in Bash".
 */
export function extractBashPaths(command) {
  if (typeof command !== 'string') return []
  const tokens = command.split(/\s+/).filter((t) => t.length > 0)
  const out = []
  let skipNext = false
  for (const tok of tokens) {
    if (skipNext) { skipNext = false; continue }
    if (tok === '--') continue
    if (tok.startsWith('-') && tok.length > 1) {
      // Flags that take a value consume the next token (`-n 5`); inline
      // values (`--count=5`) already carry theirs.
      if (/^-[a-zA-Z](?!=)/.test(tok) && !tok.includes('=')) skipNext = true
      continue
    }
    out.push(tok)
  }
  return out
}

/** First whitespace-separated word of a command string. */
function firstWord(command) {
  if (typeof command !== 'string') return ''
  const w = command.trim().split(/\s+/)[0]
  return w ?? ''
}
