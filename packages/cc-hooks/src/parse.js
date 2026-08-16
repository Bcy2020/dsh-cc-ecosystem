// parse.js — Claude Code hooks.json → protocol MatcherGroups.
//
// Reimplements the official bridge's config parser
// (@deepseek-ai/dsh-hooks-claude-code/config) with identical semantics —
// command-only hooks, matcher validation, ${CLAUDE_*} substitution — extended
// to the FULL 31-event official surface: every known CC event parses into the
// config IR, while only the 7 bridge-wired events are ever executed (the other
// 24 have no DSH extension point yet, so their hooks sit parsed-but-inert,
// ready for a future wiring batch). The wire-level types, matcher engine,
// runner and merge live in @deepseek-ai/dsh-hook-protocol, which the host ships
// in the same version line.

import { matcherDiagnostic } from '@deepseek-ai/dsh-hook-protocol'

/** All 31 official CC hook events (code.claude.com/docs/en/hooks.md). */
export const CC_EVENTS = [
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion',
  'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop',
  'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
  'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate',
  'WorktreeRemove', 'PreCompact', 'PostCompact', 'Elicitation',
  'ElicitationResult', 'SessionEnd',
]

/** The 7 events the official bridge maps to DSH extension points (the wired set). */
export const BRIDGE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
  'SubagentStart', 'SubagentStop',
]

/**
 * Events with no matcher subject (CC: a matcher there is silently ignored):
 * UserPromptSubmit / PostToolBatch / Stop / TeammateIdle / TaskCreated /
 * TaskCompleted / WorktreeCreate / WorktreeRemove / MessageDisplay / CwdChanged.
 */
const NO_MATCHER_EVENTS = new Set([
  'UserPromptSubmit', 'PostToolBatch', 'Stop', 'TeammateIdle',
  'TaskCreated', 'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove',
  'MessageDisplay', 'CwdChanged',
])

/**
 * Apply `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution to a
 * command string. A token whose variable is unset stays verbatim.
 * @param {string} command - raw command from config.
 * @param {{ pluginRoot?: string, projectDir?: string }} [vars]
 * @returns {string} the command with every occurrence of each set token replaced.
 */
export function substituteCommand(command, vars = {}) {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined
}

/**
 * Parse either a settings `hooks` value or a bare `hooks.json` event map.
 * Malformed entries are ignored rather than failing boot; unsupported events
 * are ignored before their groups are parsed; non-command hooks are returned in
 * `skipped`; substitutions are applied to every surviving command. Matcher
 * fields on UserPromptSubmit and Stop are discarded (those events have no
 * matcher subject). A matcher-bearing supported group with an invalid regex
 * throws a SyntaxError so the caller can reject the complete config before any
 * listener registration.
 *
 * @param {unknown} raw - the parsed JSON config.
 * @param {{ pluginRoot?: string, projectDir?: string }} [vars] - substitution
 *   values applied to every surviving command.
 * @returns {{ config: Record<string, Array<{ matcher?: string, hooks: Array<{ command: string, timeoutSec?: number }> }>>, skipped: Array<{ event: string, type: string }> }}
 */
export function parseHooksConfig(raw, vars = {}) {
  const config = {}
  const skipped = []
  // Accept either `{ hooks: { … } }` (a settings file) or the bare event map.
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of CC_EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const commands = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command') {
          skipped.push({ event, type })
          continue
        }
        if (typeof hook.command !== 'string') continue
        commands.push({
          command: substituteCommand(hook.command, vars),
          ...(typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {}),
          // Pass through generic fields for later layers (the wire protocol's
          // CommandHook only consumes command/timeoutSec; the extras ride along
          // in the IR so a future if-filter / statusMessage consumer can use
          // them without re-parsing).
          ...(typeof hook.if === 'string' ? { if: hook.if } : {}),
          ...(typeof hook.statusMessage === 'string' ? { statusMessage: hook.statusMessage } : {}),
        })
      }
      if (commands.length === 0) continue
      const matcher = NO_MATCHER_EVENTS.has(event)
        ? undefined
        : typeof group.matcher === 'string' ? group.matcher : undefined
      const diagnostic = matcherDiagnostic(matcher, 'claude-code')
      if (diagnostic !== undefined) {
        throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      }
      groups.push({
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: commands,
      })
    }
    if (groups.length > 0) config[event] = groups
  }

  return { config, skipped }
}
