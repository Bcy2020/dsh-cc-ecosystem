// parse.js — Claude Code hooks.json → protocol MatcherGroups.
//
// Reimplements the official bridge's config parser
// (@deepseek-ai/dsh-hooks-claude-code/config) with identical semantics —
// matcher validation, ${CLAUDE_*} substitution — extended to the FULL 31-event
// official surface and ALL FIVE handler types (command / http / mcp_tool /
// prompt / agent). Every known event parses into the config IR, while only the
// 11 wired events are ever executed (the other 20 have no DSH extension point
// yet, so their hooks sit parsed-but-inert, ready for a future wiring batch).
// The wire-level types, matcher engine, runner and merge live in
// @deepseek-ai/dsh-hook-protocol, which the host ships in the same version line.
//
// Handler-type support follows the official event × type matrix: an
// unsupported combination (e.g. an `agent` hook on SessionStart) is skipped
// with a warning, exactly as Claude Code rejects it.

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
 * The events this plugin actually wires (the official 7 plus batch-A
 * additions): PostToolUseFailure fires from tools/post-execute on a failed
 * tool, SessionEnd from agent/disposed, and PreCompact/PostCompact from the
 * session compaction event stream. Everything else stays parsed-but-inert.
 */
export const WIRED_EVENTS = [
  ...BRIDGE_EVENTS,
  'PostToolUseFailure', 'SessionEnd', 'PreCompact', 'PostCompact',
]

/** The five handler types of the official schema. */
export const HOOK_TYPES = ['command', 'http', 'mcp_tool', 'prompt', 'agent']

const ALL_TYPES = new Set(HOOK_TYPES)
const WITHOUT_PROMPT_AGENT = new Set(['command', 'http', 'mcp_tool'])
const COMMAND_OR_MCP_TOOL = new Set(['command', 'mcp_tool'])

/** Events supporting all five handler types (official matrix). */
const FIVE_TYPE_EVENTS = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'PostToolBatch', 'UserPromptSubmit', 'UserPromptExpansion', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'Stop',
]
/** Events supporting command/http/mcp_tool only — no prompt or agent hooks. */
const WITHOUT_PROMPT_AGENT_EVENTS = [
  'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'Elicitation',
  'ElicitationResult', 'FileChanged', 'InstructionsLoaded', 'MessageDisplay',
  'Notification', 'PermissionDenied', 'PreCompact', 'PostCompact', 'SessionEnd',
  'StopFailure', 'SubagentStart', 'TeammateIdle', 'WorktreeCreate',
  'WorktreeRemove',
]
/** Events supporting command/mcp_tool only (SessionStart, Setup). */
const COMMAND_OR_MCP_TOOL_EVENTS = ['SessionStart', 'Setup']

/**
 * The official event → allowed handler-type matrix. parseHooksConfig consults
 * it so an unsupported combination is skipped with a warning instead of being
 * executed or crashing the boot.
 */
export const EVENT_TYPE_SUPPORT = new Map()
for (const event of FIVE_TYPE_EVENTS) EVENT_TYPE_SUPPORT.set(event, ALL_TYPES)
for (const event of WITHOUT_PROMPT_AGENT_EVENTS) EVENT_TYPE_SUPPORT.set(event, WITHOUT_PROMPT_AGENT)
for (const event of COMMAND_OR_MCP_TOOL_EVENTS) EVENT_TYPE_SUPPORT.set(event, COMMAND_OR_MCP_TOOL)

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

/** The common fields every handler type carries (official schema). */
function commonFields(hook) {
  return {
    ...(typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {}),
    ...(typeof hook.if === 'string' ? { if: hook.if } : {}),
    ...(typeof hook.statusMessage === 'string' ? { statusMessage: hook.statusMessage } : {}),
  }
}

/**
 * Parse one hook handler into its typed IR, or report it as skipped.
 * @returns {{ ir?: object, skipped?: { event: string, type: string } } | null}
 *   `null` for a malformed entry (missing its type's required field) — the
 *   caller ignores it, matching the command-only parser's behavior.
 */
function parseHookHandler(event, hook, vars) {
  const type = typeof hook.type === 'string' ? hook.type : 'command'
  const allowed = EVENT_TYPE_SUPPORT.get(event)
  if (!allowed || !allowed.has(type)) return { skipped: { event, type } }
  switch (type) {
    case 'command': {
      if (typeof hook.command !== 'string') return null
      return { ir: { type, command: substituteCommand(hook.command, vars), ...commonFields(hook) } }
    }
    case 'http': {
      if (typeof hook.url !== 'string' || hook.url === '') return null
      const headers = asObject(hook.headers)
      const allowedEnvVars = Array.isArray(hook.allowedEnvVars)
        ? hook.allowedEnvVars.filter((v) => typeof v === 'string')
        : undefined
      return {
        ir: {
          type,
          url: hook.url,
          ...(headers !== undefined ? { headers } : {}),
          ...(allowedEnvVars !== undefined && allowedEnvVars.length > 0 ? { allowedEnvVars } : {}),
          ...commonFields(hook),
        },
      }
    }
    case 'mcp_tool': {
      if (typeof hook.server !== 'string' || hook.server === '' || typeof hook.tool !== 'string' || hook.tool === '') {
        return null
      }
      const input = asObject(hook.input)
      return {
        ir: {
          type,
          server: hook.server,
          tool: hook.tool,
          ...(input !== undefined ? { input } : {}),
          ...commonFields(hook),
        },
      }
    }
    case 'prompt':
    case 'agent': {
      if (typeof hook.prompt !== 'string') return null
      return {
        ir: {
          type,
          prompt: hook.prompt,
          ...(typeof hook.model === 'string' ? { model: hook.model } : {}),
          ...commonFields(hook),
        },
      }
    }
    /* v8 ignore next -- EVENT_TYPE_SUPPORT already filters unknown types */
    default:
      return { skipped: { event, type } }
  }
}

/**
 * Parse either a settings `hooks` value or a bare `hooks.json` event map.
 * Malformed entries are ignored rather than failing boot; an event × type
 * combination outside the official support matrix is returned in `skipped`;
 * substitutions are applied to every surviving command. Matcher fields on
 * UserPromptSubmit and Stop are discarded (those events have no matcher
 * subject). A matcher-bearing supported group with an invalid regex throws a
 * SyntaxError so the caller can reject the complete config before any listener
 * registration.
 *
 * @param {unknown} raw - the parsed JSON config.
 * @param {{ pluginRoot?: string, projectDir?: string }} [vars] - substitution
 *   values applied to every surviving command.
 * @returns {{ config: Record<string, Array<{ matcher?: string, hooks: object[] }>>, skipped: Array<{ event: string, type: string }> }}
 *   `hooks` entries are the typed IR produced by {@link parseHookHandler}
 *   (`type` always present: command | http | mcp_tool | prompt | agent).
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
      const hooks = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const parsed = parseHookHandler(event, hook, vars)
        if (parsed === null) continue
        if (parsed.skipped !== undefined) skipped.push(parsed.skipped)
        else hooks.push(parsed.ir)
      }
      if (hooks.length === 0) continue
      const matcher = NO_MATCHER_EVENTS.has(event)
        ? undefined
        : typeof group.matcher === 'string' ? group.matcher : undefined
      const diagnostic = matcherDiagnostic(matcher, 'claude-code')
      if (diagnostic !== undefined) {
        throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      }
      groups.push({
        ...(matcher !== undefined ? { matcher } : {}),
        hooks,
      })
    }
    if (groups.length > 0) config[event] = groups
  }

  return { config, skipped }
}
