// if-filter.js — CC hook `if` field execution filtering.
//
// CC semantics (code.claude.com/docs/en/hooks "Hook handler fields"):
// - `if` holds exactly ONE permission rule (no &&/||/list syntax).
// - It is evaluated ONLY on the five tool events: PreToolUse, PostToolUse,
//   PostToolUseFailure, PermissionRequest, PermissionDenied. On any other
//   event, a hook with `if` set NEVER runs.
// - A Bash pattern matches when ANY subcommand matches, with commands inside
//   $() and backticks checked too, and leading VAR=value assignments
//   stripped. Patterns that specify more than the command name run the hook
//   anyway when the command contains $(), backticks, or $VAR.
// - The filter FAILS OPEN: when the rule (or the Bash command) cannot be
//   parsed, the hook runs rather than being silently skipped.

import { ccBucket, parseRule, matchesIfRule } from 'dsh-cc-loader'

/** The five tool events on which CC evaluates `if` (all others: never). */
export const IF_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied',
])

/** Extract the command plus the text of every $()/backtick substitution. */
function expandSubstitutions(command) {
  const out = [command]
  const re = /\$\(([^()]*)\)|`([^`]*)`/g
  let m
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2])
  return out
}

/**
 * True when the rule's command pattern names more than just the command
 * (e.g. `git push *` names `git` plus arguments; `rm *` names only `rm`).
 * CC runs such hooks unconditionally when the command uses $(), backticks,
 * or a $VAR, because the expansion cannot be resolved statically.
 */
function moreThanCommandName(rule) {
  let spec = (rule.spec ?? '').trim()
  for (const suffix of [' *', ':*']) {
    if (spec.endsWith(suffix)) spec = spec.slice(0, -suffix.length).trim()
  }
  const first = /^(\S+)/.exec(spec)
  if (!first) return false
  return spec.slice(first[1].length).trim().length > 0
}

/**
 * Does the `if` rule select this tool call? Fail-open on unparseable rules.
 * @param {string} ifRaw - the raw `if` string from hooks.json.
 * @param {{ tool: string, args: Record<string, unknown> }} call
 * @param {object} env - { cwd, homeDir } matching context.
 * @returns {boolean}
 */
export function matchesIf(ifRaw, call, env) {
  const rule = parseRule(ifRaw)
  if (!rule || rule.invalid) return true // fail open (CC)
  if (rule.kind !== 'command') return matchesIfRule(rule, call, env)

  const bucket = ccBucket(call.tool)
  if (bucket !== 'Bash' && bucket !== 'PowerShell') return false
  const command = call.args?.command
  if (typeof command !== 'string') return false

  // Patterns that name more than the command run anyway on $()/backticks/$VAR.
  if (moreThanCommandName(rule) && /[$`]/.test(command)) return true

  // Any subcommand — including $()/backtick contents — matching the pattern
  // runs the hook; leading env assignments are stripped inside cc-loader.
  const candidates = expandSubstitutions(command)
  return candidates.some((c) => matchesIfRule(rule, { ...call, args: { ...call.args, command: c } }, env))
}
