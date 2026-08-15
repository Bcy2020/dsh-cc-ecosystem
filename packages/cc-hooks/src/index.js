// cc-hooks — run unmodified Claude Code command hooks in DSH with per-session
// discovery: project `.claude/hooks/hooks.json` + global `~/.claude/hooks/`
// + each plugin dir's `hooks/hooks.json`, merged and executed through
// @deepseek-ai/dsh-hook-protocol.
//
// Relationship to the official bridge (@deepseek-ai/dsh-hooks-claude-code):
// identical hook semantics (CC payload dialect, matcher/exit-code/stdout
// codec, deny > ask > allow folding, ${CLAUDE_*} substitution, decision
// mapping) — the shared wire protocol comes from dsh-hook-protocol and the
// per-event wiring below mirrors the bridge's. The delta is discovery: the
// bridge reads ONE configPath at process load (its own TODO(per-session-hook-
// config) admits this); we discover per session cwd, cache per cwd, and merge
// project/user/plugin sources, so a hooks.json edit is picked up by the next
// session and each plugin runs its own hooks.
//
// 7/31 events run (the official set), command-type hooks only; non-command
// types and unknown events are skipped with a warning, never fatal.

import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  runHook,
} from '@deepseek-ai/dsh-hook-protocol'
import { parseHooksConfig, substituteCommand } from './parse.js'
import { discoverHookFiles } from './discover.js'
import { mergeHookConfigs } from './merge.js'

export const name = 'cc-hooks'
// `shell` is required to run hooks; the rest are read opportunistically via
// ctx.get so the plugin loads even when an extension point is absent.
export const inject = ['shell']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  /** Plugin roots scanned for `<dir>/hooks/hooks.json`; each file's commands
   *  get its own `${CLAUDE_PLUGIN_ROOT}` substitution. */
  pluginDirs: z.array(z.string()).default([]),
  /** Include the user-level `~/.claude/hooks/hooks.json` source. */
  enableGlobal: z.boolean().default(true),
  /** Override the user `~/.claude` dir (tests / non-standard homes). */
  globalClaudeDir: z.string(),
  /** Override os.homedir() (tests). */
  homeDir: z.string(),
  /** Markers for upward project-root discovery (default ['.git']). */
  projectRootMarkers: z.array(z.string()).default(['.git']),
  /** Optional CLAUDE_PROJECT_DIR override; default = the session workspace. */
  projectDir: z.string(),
})

/**
 * The `agent_type` value reported for SubagentStart/Stop — Claude Code's own
 * Task-tool default, so a default/`*`/empty `agent_type` matcher fires and a
 * config matching a specific kind does not (same as the official bridge).
 */
const SUBAGENT_TYPE = 'general-purpose'

/** The `{kind:'plugin'}` source stamped on every context this plugin injects. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'cc-hooks' }

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point) {
  return `cc-hooks:${point}:${++handlerCounter}`
}

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`cc-hooks: ${name} must be a positive integer`)
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  // Validate before discovery so a bad value cannot be hidden by an early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const homeDir = config.homeDir ?? homedir()
  const pluginDirs = config.pluginDirs ?? []
  const projectRootMarkers = config.projectRootMarkers ?? ['.git']

  // Per-cwd cache of the merged parsed config, discovered at
  // agent/session-start (each new session re-reads hooks.json; a new session
  // naturally sees config edits) and lazily on first use (a hook can fire
  // before the session-start preload settles). Concurrent discovery for the
  // same cwd is deduped via the in-flight map.
  const cache = new Map()
  const inflight = new Map()

  async function buildConfig(cwd) {
    const discovered = await discoverHookFiles(cwd, {
      homeDir,
      projectRootMarkers,
      pluginDirs,
      enableGlobal: config.enableGlobal !== false,
      globalClaudeDir: config.globalClaudeDir,
    })
    const parsedList = []
    const skipped = []
    for (const src of discovered.sources) {
      if (src.error !== undefined) {
        ctx.logger.warn(`cc-hooks: skipping ${src.path}: ${src.error}`)
        continue
      }
      let parsed
      try {
        // ${CLAUDE_PLUGIN_ROOT} is static per file → substituted at parse time.
        // ${CLAUDE_PROJECT_DIR} is per-session → substituted at run time.
        parsed = parseHooksConfig(src.data, src.pluginRoot !== undefined ? { pluginRoot: src.pluginRoot } : {})
      } catch (error) {
        ctx.logger.warn(`cc-hooks: skipping ${src.path}: ${String(error)}`)
        continue
      }
      for (const s of parsed.skipped) {
        ctx.logger.warn(`cc-hooks: skipping unsupported "${s.type}" hook on ${s.event} (${src.path})`)
        skipped.push(s)
      }
      parsedList.push(parsed)
    }
    const merged = mergeHookConfigs(parsedList)
    const hookCount = Object.values(merged)
      .reduce((n, groups) => n + groups.reduce((m, g) => m + g.hooks.length, 0), 0)
    ctx.logger.info(`cc-hooks: session config for ${cwd} — ${Object.keys(merged).length} events, ${hookCount} hooks, ${skipped.length} skipped, ${discovered.sources.length} source(s)`)
    return { config: merged, sources: discovered.sources }
  }

  /** Get (and cache) the merged config for a cwd. */
  async function configFor(cwd) {
    const hit = cache.get(cwd)
    if (hit !== undefined) return hit
    const pending = inflight.get(cwd)
    if (pending !== undefined) return pending
    const run = buildConfig(cwd).finally(() => inflight.delete(cwd))
    inflight.set(cwd, run)
    return run
  }

  // Emit-shaped points run detached; disposal aborts active hooks and drains
  // continuations before the fiber disposes.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access; retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent.
  const subagentChildren = new Map()
  ctx.effect(() => () => { cache.clear(); return detached.drain() }, 'cc-hooks: drain detached hook runs')

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn (detached lifecycle points omit the pair). Returns the merged
   * outcome (neutral, already most-restrictive) for the caller to map onto its
   * extension point decision.
   */
  async function runPoint(point, matchQuery, payload, opts) {
    const workdir = opts.agent?.session.header.cwd
    const cwd = workdir ?? process.cwd()
    let entry
    try {
      entry = await configFor(cwd)
    } catch (error) {
      ctx.logger.warn(`cc-hooks: config load failed for ${cwd}: ${String(error)}`)
      return mergeHookOutputs([])
    }
    const groups = entry.config[point] ?? []
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to
    // the session workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    const outputs = []
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude-code')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          })
        }
        // ${CLAUDE_PROJECT_DIR} is per-session → substitute at run time.
        const command = substituteCommand(hook.command, projectDir !== undefined ? { projectDir } : {})
        const { output, durationMs } = await runHook(ctx.shell, {
          command,
          ...(hook.timeoutSec !== undefined ? { timeoutSec: hook.timeoutSec } : {}),
        }, {
          payload,
          defaultTimeoutMs,
          ...(hookEnv !== undefined ? { env: hookEnv } : {}),
          ...(workdir !== undefined ? { cwd: workdir } : {}),
          signal: opts.signal,
          trailingNewline: true,
          // Discard a hookSpecificOutput block whose hookEventName names a
          // different event than the one firing.
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`cc-hooks: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`cc-hooks: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  /** Build additional model context from hook output, or return undefined when empty. */
  function contextFrom(merged) {
    if (merged.additionalContext.length === 0) return undefined
    const content = merged.additionalContext.map((text) => ({ type: 'text', text }))
    return createUserMessage({ content, source: PLUGIN_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours, theirs) {
    return [ours, ...(theirs ?? [])]
  }

  ctx.logger.info('cc-hooks: per-session hooks registered (project .claude/hooks + ~/.claude + plugin dirs)')

  // SessionStart preloads the session config and runs SessionStart hooks
  // detached; a slow hook may miss the first request (same caveat as the
  // official bridge).
  ctx.on('agent/session-start', ({ agent, source }) => {
    const cwd = agent.session.header?.cwd
    if (cwd !== undefined) {
      void configFor(cwd).catch((error) => ctx.logger.warn(`cc-hooks: preload failed for ${cwd}: ${String(error)}`))
    }
    detached.track(runPoint('SessionStart', source, sessionStartPayload(ctx, agent, source), { agent, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context) agent.inject(context)
      })
      .catch((error) => ctx.logger.warn(`cc-hooks: SessionStart hook failed: ${String(error)}`)))
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    if (messages.length === 0) return next()
    const content = messages.flatMap((message) => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(ctx, agent, content), { agent, turn, signal })
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then append our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      kind: 'enter',
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next) => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(ctx, exec), { ...(exec.agent ? { agent: exec.agent } : {}), turn, signal: exec.signal })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) }
    return next()
  })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const turn = lastTurn(exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(ctx, exec, result), { ...(exec.agent ? { agent: exec.agent } : {}), turn, signal: exec.signal })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }],
        ...(context ? { additionalContexts: [context] } : {}),
      }
    }
    // Our hooks did not block. DELEGATE so a later listener can still
    // block/replace, then fold our context onto its decision.
    const downstream = await next()
    if (!context) return downstream
    return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const merged = await runPoint('Stop', '', stopPayload(ctx, agent), { agent, turn, signal })
    if (merged.decision === 'deny') {
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
    }
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the live child's workspace and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStart', info, child), { ...(child ? { agent: child } : {}), signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error) => ctx.logger.warn(`cc-hooks: SubagentStart hook failed: ${String(error)}`)))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStop', info, child), { ...(child ? { agent: child } : {}), signal: detached.signal }))
  })
}

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(agent) {
  if (!agent) return 0
  const last = [...agent.session.events].findLast((e) => e.type === 'turn/start')
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content) {
  return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
}

function base(ctx, agent, event) {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: agent === undefined
      ? ''
      : ctx.get('sessionPersistence')?.locate(agent.session.header)?.path ?? '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function sessionStartPayload(ctx, agent, source) {
  return { ...base(ctx, agent, 'SessionStart'), source }
}
function promptPayload(ctx, agent, content) {
  return { ...base(ctx, agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function preToolPayload(ctx, exec) {
  return { ...base(ctx, exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(ctx, exec, result) {
  return { ...base(ctx, exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
function stopPayload(ctx, agent) {
  return { ...base(ctx, agent, 'Stop'), stop_hook_active: false }
}
/**
 * SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default SUBAGENT_TYPE; `stop_hook_active` is
 * present on SubagentStop only.
 */
function subagentPayload(ctx, event, info, child) {
  return {
    ...base(ctx, child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...(event === 'SubagentStop' ? { stop_hook_active: false } : {}),
  }
}
