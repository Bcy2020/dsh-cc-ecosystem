// executors.js — the four non-command hook handler types.
//
// Implements the official Claude Code handler semantics documented in
// docs/cc-hooks-handler-semantics.md (source: code.claude.com/docs/en/hooks):
//   - http:      POST the payload JSON; a 2xx JSON-object body is decoded with
//                the command exit-0 stdout rules; every failure mode (non-2xx
//                status, plain-text/other body, connection failure, timeout)
//                is a NON-BLOCKING error — an HTTP status code alone can never
//                block, only a 2xx JSON decision body can.
//   - mcp_tool:  call an already-connected MCP tool through its registered
//                ToolDefinition directly (bypassing the tool event pipeline so
//                a hook never re-triggers itself); the tool's text content is
//                parsed like exit-0 command stdout; a missing server/tool or
//                an isError result is a non-blocking error.
//   - prompt:    one LLM call; the model answers the official schema
//                `{"ok":true}` / `{"ok":false,"reason"}`; ok:false blocks,
//                anything else is a non-blocking error.
//   - agent:     one subagent call with the same {ok} answer schema.
//
// A missing capability (no tools/llm service, no subagent tool, no model
// route) degrades to a warning + neutral outcome — never a crash (approved
// design: capability-missing → warn, non-blocking).

import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseHookOutput } from '@deepseek-ai/dsh-hook-protocol'

/** Official per-type timeout defaults (s): command/http/mcp_tool 600, prompt 30, agent 60. */
export const HOOK_TYPE_DEFAULT_TIMEOUT_MS = {
  command: 600_000,
  http: 600_000,
  mcp_tool: 600_000,
  prompt: 30_000,
  agent: 60_000,
}

/** UserPromptSubmit lowers command/http/mcp_tool to 30s (CC). */
export const USER_PROMPT_SUBMIT_TIMEOUT_MS = 30_000

/**
 * The effective default timeout for one (event, type) pair when the hook sets
 * no `timeout` field: CC defaults per type, with the UserPromptSubmit lowering
 * for command/http/mcp_tool. `configuredDefault` is the plugin's
 * `defaultTimeoutMs` knob and only applies to command/http/mcp_tool off
 * UserPromptSubmit (matching the knob's original command-hook semantics).
 */
export function defaultTimeoutMsFor(event, type, configuredDefault) {
  if (type === 'prompt' || type === 'agent') return HOOK_TYPE_DEFAULT_TIMEOUT_MS[type]
  if (event === 'UserPromptSubmit') return USER_PROMPT_SUBMIT_TIMEOUT_MS
  return configuredDefault ?? HOOK_TYPE_DEFAULT_TIMEOUT_MS[type] ?? 600_000
}

/** A neutral hook outcome: no exit code, no decision, no context. */
function neutralOutput() {
  return { exitCode: undefined, stderr: '', stdout: '' }
}

/** The `{kind:'plugin'}` source stamped on messages this plugin builds. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'cc-hooks' }

let executorCounter = 0
function nextId() {
  return `cc-hooks:${++executorCounter}`
}

/** Text of the `text` content blocks in a ContentBlock array. */
function contentBlocksToText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

// ─── $ARGUMENTS / ${path} substitution (official) ────────────────────────────

/**
 * Substitute `$ARGUMENTS` in a prompt/agent hook with the JSON-serialized hook
 * input; a backslash-escaped `\$` renders a literal `$` (CC: `\$1.00` → `$1.00`).
 */
export function substituteArguments(prompt, payload) {
  const json = JSON.stringify(payload)
  let out = ''
  let i = 0
  while (i < prompt.length) {
    const ch = prompt[i]
    if (ch === '\\' && i + 1 < prompt.length && prompt[i + 1] === '$') {
      out += '$'
      i += 2
      continue
    }
    if (ch === '$' && prompt.startsWith('$ARGUMENTS', i)) {
      out += json
      i += '$ARGUMENTS'.length
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Resolve a dotted path (`tool_input.file_path`) inside the hook input JSON. */
function resolvePath(object, path) {
  let current = object
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = current[segment]
  }
  return current
}

/** Replace `${path}` references (from the hook input JSON) in one string. */
function substitutePathRefs(value, payload) {
  return value.replace(/\$\{([^}]+)\}/g, (whole, path) => {
    const resolved = resolvePath(payload, path)
    if (resolved === undefined) return whole // unresolvable stays verbatim
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
}

/**
 * Recursively substitute `${path}` in an mcp_tool hook's `input` string values
 * (CC: "String values support `${path}` substitution from the hook's JSON
 * input, such as `${tool_input.file_path}`").
 */
export function substituteInputPaths(input, payload) {
  if (typeof input !== 'object' || input === null) return {}
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = substitutePathRefs(value, payload)
    else if (typeof value === 'object' && value !== null) out[key] = substituteInputPaths(value, payload)
    else out[key] = value
  }
  return out
}

/**
 * Interpolate `$VAR` / `${VAR}` in an HTTP header value. Only variables listed
 * in `allowedEnvVars` are resolved; references to unlisted variables become
 * empty strings. When `allowedEnvVars` is absent, no interpolation happens at
 * all (the value stays verbatim) — both per the official schema.
 */
export function interpolateHeaderValue(value, allowedEnvVars, env) {
  if (allowedEnvVars === undefined) return value
  const allowed = new Set(allowedEnvVars)
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, bare) => {
    const name = braced ?? bare
    return allowed.has(name) ? (env[name] ?? '') : ''
  })
}

// ─── mcp_tool name mapping (official) ────────────────────────────────────────

/**
 * Map a hook's `server` value to the DSH tool-registry prefix segment.
 * Plugin-bundled servers use the scoped name `plugin:<plugin>:<server>` in
 * hooks.json; DSH registers their tools under the official scoped segment
 * `mcp__plugin_<plugin>_<server>__<tool>`.
 */
export function mcpToolPublicName(server, tool) {
  const segment = server.startsWith('plugin:')
    ? `plugin_${server.slice('plugin:'.length).split(':').join('_')}`
    : server
  return `mcp__${segment}__${tool}`
}

/**
 * Text of an MCP tool's canonical value: join the `text` blocks of its
 * `content` array (the shape mcp-client's executors return), falling back to
 * `structuredContent` or the raw value.
 */
function mcpValueText(value) {
  if (typeof value !== 'object' || value === null) return String(value ?? '')
  const content = value.content
  if (!Array.isArray(content)) {
    return value.structuredContent !== undefined ? JSON.stringify(value.structuredContent) : ''
  }
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

// ─── {ok} decision decode (prompt/agent) ─────────────────────────────────────

/** Strip one optional ```json fenced block so models may wrap their answer. */
function stripCodeFence(text) {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return match ? match[1] : text
}

/**
 * Decode a prompt/agent hook answer per the official schema
 * (`{"ok": true}` / `{"ok": false, "reason": "..."}`): ok:false → a blocking
 * decision with the reason; everything else (ok:true, invalid JSON, missing
 * `ok`) → neutral, with a warning for the invalid shapes.
 */
function decodeOkAnswer(text, ctx, opts) {
  const trimmed = (text ?? '').trim()
  const body = stripCodeFence(trimmed)
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  if (typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean') {
    if (parsed.ok === true) return neutralOutput()
    return {
      ...neutralOutput(),
      decision: 'block',
      reason: typeof parsed.reason === 'string' && parsed.reason !== ''
        ? parsed.reason
        : `blocked by ${opts.event} ${opts.type} hook`,
    }
  }
  ctx.logger.warn(`cc-hooks: ${opts.event} ${opts.type} hook returned no {"ok": bool} JSON (non-blocking)`)
  return neutralOutput()
}

/** A shared abort source: outer signal + per-hook timeout, cleaned up by the caller. */
function makeDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  signal?.addEventListener('abort', onOuterAbort)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  return { controller, onOuterAbort, timer }
}

function clearDeadline(deadline, signal) {
  clearTimeout(deadline.timer)
  signal?.removeEventListener('abort', deadline.onOuterAbort)
}

// ─── http ────────────────────────────────────────────────────────────────────

/**
 * Run one HTTP hook. Never throws: every failure becomes a warning + neutral
 * outcome (non-blocking). A 2xx response whose body is a JSON object is decoded
 * with the command exit-0 stdout rules (gated by `expectedEventName`).
 * @param {object} ctx - plugin context (logger).
 * @param {{ url: string, headers?: object, allowedEnvVars?: string[], timeoutSec?: number }} hook
 * @param {object} payload - the CC dialect event input (POST body).
 * @param {{ event: string, expectedEventName: string, signal?: AbortSignal }} opts
 */
export async function runHttpHook(ctx, hook, payload, opts) {
  const started = performance.now()
  const timeoutMs = hook.timeoutSec !== undefined
    ? hook.timeoutSec * 1000
    : defaultTimeoutMsFor(opts.event, 'http')
  const headers = {}
  if (hook.headers !== undefined) {
    for (const [name, value] of Object.entries(hook.headers)) {
      if (typeof value === 'string') headers[name] = interpolateHeaderValue(value, hook.allowedEnvVars, process.env)
    }
  }
  const deadline = makeDeadline(opts.signal, timeoutMs)
  try {
    let response
    try {
      response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: deadline.controller.signal,
      })
    } catch (error) {
      ctx.logger.warn(`cc-hooks: ${opts.event} http hook ${hook.url} ${opts.signal?.aborted ? 'aborted' : 'failed'} (${String(error)}) (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    // Non-2xx status is a non-blocking error; it can never block by itself.
    if (!response.ok) {
      ctx.logger.warn(`cc-hooks: ${opts.event} http hook ${hook.url} returned HTTP ${response.status} (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    const text = await response.text()
    const trimmed = text.trim()
    if (trimmed === '') {
      // 2xx empty body → success with no output.
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    if (trimmed.startsWith('{')) {
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        parsed = undefined
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        // 2xx JSON object body → same schema as command exit-0 stdout.
        return { output: parseHookOutput(0, text, '', opts.expectedEventName), durationMs: performance.now() - started }
      }
    }
    // 2xx with any other body (plain text, unparseable JSON) → non-blocking error.
    ctx.logger.warn(`cc-hooks: ${opts.event} http hook ${hook.url} returned a non-JSON-object body (non-blocking)`)
    return { output: neutralOutput(), durationMs: performance.now() - started }
  } finally {
    clearDeadline(deadline, opts.signal)
  }
}

// ─── mcp_tool ────────────────────────────────────────────────────────────────

/**
 * Run one mcp_tool hook by calling the registered ToolDefinition directly
 * (bypassing the tool event pipeline so the hook never re-triggers itself).
 * The tool's text content is decoded like exit-0 command stdout. A missing
 * tools service, an unknown `mcp__server__tool` name, or an isError result is
 * a non-blocking error.
 * @param {object} ctx - plugin context (logger + get('tools')).
 * @param {{ server: string, tool: string, input?: object, timeoutSec?: number }} hook
 * @param {object} payload - the CC dialect event input (${path} source).
 * @param {{ event: string, expectedEventName: string, signal?: AbortSignal }} opts
 */
export async function runMcpToolHook(ctx, hook, payload, opts) {
  const started = performance.now()
  const tools = ctx.get('tools')
  if (!tools || typeof tools.get !== 'function') {
    ctx.logger.warn(`cc-hooks: ${opts.event} mcp_tool hook cannot run — tools service unavailable (non-blocking)`)
    return { output: neutralOutput(), durationMs: 0 }
  }
  const name = mcpToolPublicName(hook.server, hook.tool)
  const definition = tools.get(name)
  if (!definition || typeof definition.execute !== 'function') {
    ctx.logger.warn(`cc-hooks: ${opts.event} mcp_tool hook cannot run — MCP tool ${name} not connected (non-blocking)`)
    return { output: neutralOutput(), durationMs: 0 }
  }
  const input = substituteInputPaths(hook.input, payload)
  const timeoutMs = hook.timeoutSec !== undefined
    ? hook.timeoutSec * 1000
    : defaultTimeoutMsFor(opts.event, 'mcp_tool')
  const deadline = makeDeadline(opts.signal, timeoutMs)
  try {
    let value
    try {
      value = await definition.execute(input, {
        callId: CallId(nextId()),
        name,
        arguments: input,
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        signal: deadline.controller.signal,
        deferContext() {},
        concludeTurn() {},
      })
    } catch (error) {
      // Includes the mcp-client isError→throw path and task-required rejections.
      ctx.logger.warn(`cc-hooks: ${opts.event} mcp_tool hook ${name} failed: ${String(error)} (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    return {
      output: parseHookOutput(0, mcpValueText(value), '', opts.expectedEventName),
      durationMs: performance.now() - started,
    }
  } finally {
    clearDeadline(deadline, opts.signal)
  }
}

// ─── prompt / agent shared ───────────────────────────────────────────────────

/**
 * Resolve the provider/model route for a prompt or agent hook: `hook.model`
 * (accepting "provider/model" or a bare model id paired with the agent's
 * provider) wins; otherwise the agent's active options are used (the CC
 * default is a fast model; the agent's current route is the closest DSH
 * equivalent). `undefined` when nothing resolves → caller degrades.
 */
export function resolveModelRoute(model, agent) {
  const agentOptions = agent?.options
  if (typeof model === 'string' && model !== '') {
    const slash = model.indexOf('/')
    if (slash > 0 && slash < model.length - 1) {
      return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
    }
    if (typeof agentOptions?.provider === 'string') return { provider: agentOptions.provider, model }
  }
  if (agentOptions && typeof agentOptions.provider === 'string' && typeof agentOptions.model === 'string') {
    return { provider: agentOptions.provider, model: agentOptions.model }
  }
  return undefined
}

/**
 * Run one prompt hook: a single LLM call with the `$ARGUMENTS`-substituted
 * prompt; the model's `{ok}` answer is decoded by {@link decodeOkAnswer}.
 */
export async function runPromptHook(ctx, hook, payload, opts) {
  const started = performance.now()
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    ctx.logger.warn(`cc-hooks: ${opts.event} prompt hook cannot run — llm service unavailable (non-blocking)`)
    return { output: neutralOutput(), durationMs: 0 }
  }
  const route = resolveModelRoute(hook.model, opts.agent)
  if (route === undefined) {
    ctx.logger.warn(`cc-hooks: ${opts.event} prompt hook cannot run — no model route (set hook.model or the agent model) (non-blocking)`)
    return { output: neutralOutput(), durationMs: 0 }
  }
  const prompt = substituteArguments(hook.prompt, payload)
  const timeoutMs = hook.timeoutSec !== undefined
    ? hook.timeoutSec * 1000
    : defaultTimeoutMsFor(opts.event, 'prompt')
  const deadline = makeDeadline(opts.signal, timeoutMs)
  try {
    let text = ''
    let finishKind
    try {
      const messages = [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: PLUGIN_SOURCE,
      })]
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        signal: deadline.controller.signal,
      })) {
        deadline.controller.signal.throwIfAborted()
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finishKind = chunk.reason.kind
      }
    } catch (error) {
      ctx.logger.warn(`cc-hooks: ${opts.event} prompt hook LLM call failed: ${String(error)} (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    if (finishKind === 'error' || finishKind === 'aborted') {
      ctx.logger.warn(`cc-hooks: ${opts.event} prompt hook LLM call ${finishKind} (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    return { output: decodeOkAnswer(text, ctx, { ...opts, type: 'prompt' }), durationMs: performance.now() - started }
  } finally {
    clearDeadline(deadline, opts.signal)
  }
}

/**
 * Run one agent hook: spawn a subagent through the registered `subagent` tool
 * (the DSH tool-subagent default name) with the `$ARGUMENTS`-substituted
 * prompt; the subagent's final answer is decoded with the {ok} schema.
 */
export async function runAgentHook(ctx, hook, payload, opts) {
  const started = performance.now()
  const tools = ctx.get('tools')
  if (!tools || typeof tools.execute !== 'function' || typeof tools.get !== 'function') {
    ctx.logger.warn(`cc-hooks: ${opts.event} agent hook cannot run — tools service unavailable (non-blocking)`)
    return { output: neutralOutput(), durationMs: 0 }
  }
  const SUBAGENT_TOOL = 'subagent'
  const definition = tools.get(SUBAGENT_TOOL)
  if (!definition) {
    ctx.logger.warn(`cc-hooks: ${opts.event} agent hook cannot run — subagent tool not registered (non-blocking)`)
    return { output: neutralOutput(), durationMs: 0 }
  }
  if (!opts.agent) {
    ctx.logger.warn(`cc-hooks: ${opts.event} agent hook cannot run — no calling agent (non-blocking)`)
    return { output: neutralOutput(), durationMs: 0 }
  }
  const prompt = substituteArguments(hook.prompt, payload)
  // The subagent tool's schema may offer a background mode; an agent hook
  // needs the settled foreground answer, so pin it off when the parameter exists.
  const args = { description: 'cc-hooks agent hook', prompt }
  const parameters = definition.parameters
  if (parameters && typeof parameters === 'object'
      && parameters.properties && typeof parameters.properties === 'object'
      && parameters.properties.run_in_background !== undefined) {
    args.run_in_background = false
  }
  const timeoutMs = hook.timeoutSec !== undefined
    ? hook.timeoutSec * 1000
    : defaultTimeoutMsFor(opts.event, 'agent')
  const deadline = makeDeadline(opts.signal, timeoutMs)
  try {
    let result
    try {
      result = await tools.execute({
        callId: CallId(nextId()),
        name: SUBAGENT_TOOL,
        arguments: args,
        agent: opts.agent,
        signal: deadline.controller.signal,
      })
    } catch (error) {
      ctx.logger.warn(`cc-hooks: ${opts.event} agent hook subagent call failed: ${String(error)} (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    if (result?.isError === true) {
      ctx.logger.warn(`cc-hooks: ${opts.event} agent hook subagent returned an error (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    const value = result?.value
    if (typeof value !== 'object' || value === null || value.kind !== 'foreground') {
      ctx.logger.warn(`cc-hooks: ${opts.event} agent hook subagent returned ${value?.kind ?? 'no'} result, expected foreground (non-blocking)`)
      return { output: neutralOutput(), durationMs: performance.now() - started }
    }
    const text = contentBlocksToText(value.output)
    return { output: decodeOkAnswer(text, ctx, { ...opts, type: 'agent' }), durationMs: performance.now() - started }
  } finally {
    clearDeadline(deadline, opts.signal)
  }
}
