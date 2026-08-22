// cc-permissions — CC allow rules answer the DSH approval seam.
//
// Claude Code semantics: an `allow` rule (e.g. `Bash(pytest:*)`) is the
// COMPLETE gate — the command runs without any further question. DSH has a
// second layer below the permission fold: the file sandbox. A call that
// passes pre-execute still runs under `workspace-write`, and when the sandbox
// denies a file effect the model retries with `sandbox_permissions`, which
// raises an `approval/request` (the escalation seam). Without this module,
// that request hits the human answerer even though the user already allowed
// the exact command in `.claude/settings.json`.
//
// This module bridges the gap: an `approval/request` whose underlying tool
// call matches a CC `allow` rule is answered `allowed-once` automatically
// (the user pre-consented; CC allow = run without asking). Deny/ask rules and
// unmatched calls pass through to the deployment's human answerer untouched —
// the module only ever auto-grants, never auto-denies, and it never answers
// a call the CC fold did not explicitly allow.
//
// The request itself carries no arguments (`{agent, toolName, callId,
// reason}`), so the real tool arguments are recovered from the session log:
// the `tool/call` event keyed by `callId` (`data.arguments` is JSON text).

import { evaluateCall } from 'dsh-cc-loader'

/**
 * Locate the recorded `tool/call` event for one approval request. The
 * session log is scanned newest-first; the latest event matching the call id
 * (and, when given, the tool name) wins — same shape as
 * dsh-auto-approval-plugin's findToolCall.
 * @param {unknown} events - the agent session's event log.
 * @param {unknown} callId - the approval request's call id.
 * @param {string} [toolName] - the approval request's tool name.
 * @returns {{callId?: unknown, name?: string, arguments?: unknown}|undefined}
 *   the matching tool call data, or undefined when absent.
 */
export function findToolCall(events, callId, toolName) {
  if (typeof callId !== 'string' || callId === '') return undefined
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue
    const data = event.data
    if (data === undefined || data === null || typeof data !== 'object') continue
    if (data.callId !== callId) continue
    if (toolName !== undefined && data.name !== undefined && data.name !== toolName) continue
    return data
  }
  return undefined
}

/**
 * Parse recorded tool arguments: the session log stores them as JSON text
 * (lossless materialization), but object form is tolerated for fixtures.
 * @param {unknown} raw - the recorded `tool/call` arguments.
 * @returns {Record<string, unknown>|null} the parsed arguments, `{}` when
 *   absent, or `null` when the text is unparseable (caller defers).
 */
export function parseArguments(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return typeof raw === 'object' ? raw : null
}

/**
 * Decide whether one approval request may be auto-granted from CC rules.
 *
 * Combines the session-log call lookup with the cc-loader rule fold
 * (`evaluateCall`): only an explicit `allow` match — or an
 * `enableAllProjectMcpServers`-covered project MCP tool on a no-rule call —
 * yields `'allow'`. A deny or ask decision on the same call defers (the fold
 * order deny > ask > allow is preserved; ask still asks the human).
 *
 * @param {object} input
 * @param {unknown} input.events - the agent session's event log.
 * @param {unknown} input.callId - the approval request's call id.
 * @param {string} input.toolName - the approval request's tool name.
 * @param {object} input.parsed - `parseRulesFor` output for the session.
 * @param {object} input.env - `{ cwd, homeDir, projectRoot }` evaluation env.
 * @param {boolean} [input.enableAllProjectMcpServers] - settings flag.
 * @param {(name: string) => boolean} [input.isProjectMcpTool] - project MCP
 *   tool predicate (plugin MCP tools are never covered).
 * @returns {'allow'|'defer'} whether to answer `allowed-once`.
 */
export function decideApproval({
  events,
  callId,
  toolName,
  parsed,
  env,
  enableAllProjectMcpServers = false,
  isProjectMcpTool = () => false,
}) {
  const call = findToolCall(events, callId, toolName)
  if (call === undefined) return 'defer'
  // No recorded arguments → no verification possible → defer ("no data, no
  // auto-approval"); unparseable text defers too.
  if (call.arguments === undefined || call.arguments === null) return 'defer'
  const args = parseArguments(call.arguments)
  if (args === null) return 'defer'
  const name = typeof call.name === 'string' ? call.name : toolName
  const result = evaluateCall(parsed, { tool: name, args }, env)
  if (result.decision === 'allow') return 'allow'
  if (result.decision === 'none'
    && enableAllProjectMcpServers === true
    && isProjectMcpTool(name)) {
    return 'allow'
  }
  return 'defer'
}
