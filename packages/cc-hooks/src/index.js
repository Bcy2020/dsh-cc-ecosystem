// cc-hooks — run unmodified Claude Code hooks in DSH with per-session
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
// All five official handler types execute (command / http / mcp_tool / prompt
// / agent) via the executors in executors.js; an event × type combination
// outside the official support matrix is skipped with a warning at parse time,
// and a missing runtime capability (no tools/llm service, no subagent tool,
// no model route) degrades to a warning + neutral outcome, never a crash.
//
// 16/31 events run (7 bridge-wired + PostToolUseFailure, SessionEnd,
// PreCompact, PostCompact + the W1 direct mappings PermissionRequest,
// PermissionDenied, CwdChanged, StopFailure, InstructionsLoaded); the other 15
// have no DSH extension point yet, so their hooks sit parsed-but-inert.

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
} from '@deepseek-ai/dsh-hook-protocol'
import { applyCallOperator, needsCallOperator, probeShellDialect, runShellHook } from './shell-compat.js'
import { parseHooksConfig, substituteCommand } from './parse.js'
import { discoverHookFiles } from './discover.js'
import { mergeHookConfigs } from './merge.js'
import { IF_EVENTS, matchesIf } from './if-filter.js'
import {
  defaultTimeoutMsFor,
  runAgentHook,
  runHttpHook,
  runMcpToolHook,
  runPromptHook,
} from './executors.js'
import { ccBucket, injectedSource, onSessionStart, sessionLastEvent } from 'dsh-cc-loader'
import { announce, describeSelf } from 'dsh-cc-loader/telemetry'

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
  /** Optional CLAUDE_PROJECT_DIR override; default = the session workspace. */
  projectDir: z.string(),
  /** Sandbox mode for command hooks. Empty follows the session's own policy;
   *  `danger-full-access` runs them with no sandbox, which is how Claude Code
   *  runs hooks. */
  sandboxMode: z.union([
    z.const(''), z.const('read-only'), z.const('workspace-write'), z.const('danger-full-access'),
  ]).default(''),
  /** Which language `ctx.shell` speaks. `auto` probes once on Windows, because
   *  `ShellExecutor` exposes no identity: a host that swapped the pwsh executor
   *  for bash (a shell-flip plugin) needs commands written for bash. */
  shellDialect: z.union([z.const('auto'), z.const('posix'), z.const('pwsh')]).default('auto'),
})

/**
 * The `agent_type` value reported for SubagentStart/Stop — Claude Code's own
 * Task-tool default, so a default/`*`/empty `agent_type` matcher fires and a
 * config matching a specific kind does not (same as the official bridge).
 */
const SUBAGENT_TYPE = 'general-purpose'

/** Source for context this plugin injects — see dsh-cc-loader's message-source.js. */
const PLUGIN_SOURCE = injectedSource('cc-hooks')

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
  announce(ctx, describeSelf(import.meta.url))
  if (config.enabled === false) return

  // Validate before discovery so a bad value cannot be hidden by an early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const homeDir = config.homeDir ?? homedir()
  const pluginDirs = config.pluginDirs ?? []

  // Per-cwd cache of the merged parsed config, discovered at
  // session start (each new session re-reads hooks.json; a new session
  // naturally sees config edits) and lazily on first use (a hook can fire
  // before the session-start preload settles). Concurrent discovery for the
  // same cwd is deduped via the in-flight map.
  const cache = new Map()
  const inflight = new Map()

  async function buildConfig(cwd) {
    const discovered = await discoverHookFiles(cwd, {
      homeDir,
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

  // Session → agent fallback for log-only points (StopFailure,
  // PermissionDenied) that receive a Session rather than an Agent. The live
  // registry is consulted first; this map covers the window before/after a
  // registered agent is reachable.
  const knownAgents = new Map()
  // callIds of tool calls a PermissionRequest hook denied. The approval audit
  // pair that follows must not also fire PermissionDenied for them.
  const selfDeniedCalls = new Set()
  function agentFor(session) {
    const id = session?.header?.id
    if (id === undefined) return undefined
    return ctx.get('agents')?.get(id) ?? knownAgents.get(id)
  }

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn (detached lifecycle points omit the pair). Returns the merged
   * outcome (neutral, already most-restrictive) for the caller to map onto its
   * extension point decision.
   */
  async function runPoint(point, matchQuery, payload, opts) {
    const session = opts.agent?.session ?? opts.session
    // Both levels are optional: 0.2.0 can fire an event while the session is
    // still attaching, so a session without a header is a real shape.
    const workdir = session?.header?.cwd
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
      // Tool events pass both the DSH tool name and its CC bucket name (Bash,
      // Read, Edit…) as matcher subjects, so a CC-authored matcher like "Bash"
      // matches the DSH `bash` tool exactly as written.
      const matched = matchesMatcher(group.matcher, matchQuery, 'claude-code')
        || (opts.altMatchQuery !== undefined && matchesMatcher(group.matcher, opts.altMatchQuery, 'claude-code'))
      if (!matched) continue
      for (const hook of group.hooks) {
        // The `if` field is evaluated only on the five tool events; a hook
        // carrying `if` on any other event never runs (CC). On tool events a
        // non-matching rule skips the hook; an unparseable rule fails open.
        if (hook.if !== undefined) {
          if (!IF_EVENTS.has(point)) continue
          if (opts.call === undefined || !matchesIf(hook.if, opts.call, { cwd, homeDir })) continue
        }
        const handlerId = nextHandlerId(point)
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          })
        }
        const type = hook.type ?? 'command'
        const { output, durationMs } = await (type === 'command'
          ? runCommandHook(ctx, hook, point, payload, {
              projectDir, hookEnv, workdir, defaultTimeoutMs, session,
              signal: opts.signal,
              // Discard a hookSpecificOutput block whose hookEventName names a
              // different event than the one firing.
              expectedEventName: point,
            })
          : runNonCommandHook(ctx, type, hook, point, payload, {
              agent: opts.agent,
              signal: opts.signal,
              expectedEventName: point,
            }))
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
    // `outputs` keeps each hook's decoded result so a point whose CC encoding
    // the shared protocol does not decode (PermissionRequest's `decision`
    // object, PermissionDenied's `retry`) can read the raw stdout itself.
    return { ...mergeHookOutputs(outputs), outputs }
  }

  /**
   * The sandbox policy for one hook run, resolved per call rather than cached:
   * a session's mode can change mid-session, and cordis loads plugin rows in
   * parallel, so `ctx.sandboxPolicy` may not even be registered when this
   * plugin applies.
   *
   * Passing it is what keeps the executor's sandbox rooted at the calling
   * session's workspace. Without it the executor falls back to its own
   * deployment root — on Windows that puts `%TEMP%` inside the workspace and
   * the ACL runner refuses the hook before it ever spawns.
   */
  function sandboxPolicyFor(session) {
    const service = ctx.get('sandboxPolicy')
    if (service === undefined) return undefined
    try {
      return service.resolve({
        ...(session !== undefined ? { session } : {}),
        ...(config.sandboxMode !== undefined && config.sandboxMode !== '' ? { mode: config.sandboxMode } : {}),
      })
    } catch (error) {
      ctx.logger.warn(`cc-hooks: sandbox policy could not be resolved: ${String(error)}`)
      return undefined
    }
  }

  /**
   * The host shell's dialect, resolved once. `ctx.shell` exposes no identity,
   * so on Windows it is probed; the answer is fixed for the life of the
   * loaded plugin (one executor per context), and it is logged because every
   * command hook's shape depends on it.
   */
  let dialectPromise
  function shellDialect() {
    if (config.shellDialect !== undefined && config.shellDialect !== 'auto') {
      return Promise.resolve(config.shellDialect)
    }
    // Only Windows can have swapped pwsh for a POSIX shell; elsewhere the
    // platform already answers it and no probe is worth the spawn.
    if (process.platform !== 'win32') return Promise.resolve('posix')
    dialectPromise ??= (async () => {
      const probed = await probeShellDialect(ctx.shell)
      const dialect = probed ?? 'pwsh'
      ctx.logger.info(
        `cc-hooks: shell dialect ${dialect}${probed === undefined ? ' (probe could not run; assuming the win32 default)' : ''}`,
      )
      return dialect
    })()
    return dialectPromise
  }

  /**
   * Run one command hook through ctx.shell with the CC stdin framing
   * (JSON payload + newline) and per-event default timeout. The command is
   * `${CLAUDE_PROJECT_DIR}`-substituted at run time (per-session value).
   */
  async function runCommandHook(ctx, hook, point, payload, opts) {
    const substituted = substituteCommand(
      hook.command,
      opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {},
    )
    // Only a command whose first token is quoted is read differently by the two
    // dialects, and resolving the dialect can cost a probe — so ask only when
    // the answer would actually change the command.
    const dialect = needsCallOperator(substituted) ? await shellDialect() : undefined
    const command = applyCallOperator(substituted, dialect)
    const sandboxPolicy = sandboxPolicyFor(opts.session)
    // Claude Code exports CLAUDE_PLUGIN_ROOT to a plugin hook's environment;
    // some plugins pick their output shape from it rather than from the
    // substituted command text.
    const env = hook.pluginRoot !== undefined
      ? { ...opts.hookEnv, CLAUDE_PLUGIN_ROOT: hook.pluginRoot }
      : opts.hookEnv
    return runShellHook(ctx.shell, {
      command,
      ...(hook.timeoutSec !== undefined ? { timeoutSec: hook.timeoutSec } : {}),
    }, {
      payload,
      defaultTimeoutMs: defaultTimeoutMsFor(point, 'command', opts.defaultTimeoutMs),
      ...(env !== undefined ? { env } : {}),
      ...(opts.workdir !== undefined ? { cwd: opts.workdir } : {}),
      ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
      signal: opts.signal,
      trailingNewline: true,
      expectedEventName: opts.expectedEventName,
    }, () => performance.now())
  }

  /**
   * Dispatch a non-command hook (http / mcp_tool / prompt / agent) to its
   * executor. Executors never throw — a missing capability degrades to a
   * warning + neutral outcome; an unknown type is skipped with a warning.
   */
  async function runNonCommandHook(ctx, type, hook, point, payload, opts) {
    const runOpts = { ...opts, event: point }
    switch (type) {
      case 'http': return runHttpHook(ctx, hook, payload, runOpts)
      case 'mcp_tool': return runMcpToolHook(ctx, hook, payload, runOpts)
      case 'prompt': return runPromptHook(ctx, hook, payload, runOpts)
      case 'agent': return runAgentHook(ctx, hook, payload, runOpts)
      default:
        ctx.logger.warn(`cc-hooks: ${point} unknown hook type "${type}" skipped`)
        return { output: { exitCode: undefined, stderr: '', stdout: '' }, durationMs: 0 }
    }
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
  // official bridge). `onSessionStart` owns the host move from
  // `agent/session-start` to `agent/created`, and keeps this listener from
  // stalling session publication on 0.2.0.
  onSessionStart(ctx, ({ agent, source }) => {
    // `agent.session` is NOT guaranteed yet: 0.2.0 announces the agent with
    // `agent/created` before the session is attached, so an unguarded read
    // threw here and took the whole handler — and therefore every SessionStart
    // hook — down with it. `runPoint` and `base` are already total; this line
    // was the one that ran first.
    const sessionId = agent?.session?.header?.id
    if (sessionId !== undefined) knownAgents.set(sessionId, agent)
    const cwd = agent?.session?.header?.cwd
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
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(ctx, exec), {
      ...(exec.agent ? { agent: exec.agent } : {}), turn, signal: exec.signal,
      call: { tool: exec.name, args: exec.arguments },
      altMatchQuery: ccBucket(exec.name) ?? undefined,
    })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) }
    return next()
  })

  // --- PostToolUse / PostToolUseFailure → PostToolDecision. A failed tool
  // fires PostToolUseFailure (CC: "After a tool call fails"), a successful one
  // PostToolUse; the matcher subject is the tool name for both.
  //
  // DSH only marks `result.isError` for infrastructure failures (spawn
  // errors, aborts). A shell command that ran but exited non-zero is a
  // SUCCESSFUL tool in DSH terms — its result carries `exitCode: N` in the
  // canonical value (canonicalPwshResult/canonicalBashResult) and renders as
  // `[exit code: N]`. CC treats a non-zero exit as a failed tool, so the
  // failure event must also fire for `exitCode !== 0`. ---
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const turn = lastTurn(exec.agent)
    const failed = result.isError === true || toolExitedNonZero(result)
    const point = failed ? 'PostToolUseFailure' : 'PostToolUse'
    const merged = await runPoint(point, exec.name, postToolPayload(ctx, point, exec, result), {
      ...(exec.agent ? { agent: exec.agent } : {}), turn, signal: exec.signal,
      call: { tool: exec.name, args: exec.arguments },
      altMatchQuery: ccBucket(exec.name) ?? undefined,
    })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? `blocked by ${point} hook` }],
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
    if (child !== undefined) {
      subagentChildren.set(info.runId, child)
      const sessionId = child.session?.header?.id
      if (sessionId !== undefined) knownAgents.set(sessionId, child)
    }
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

  // --- SessionEnd → agent/disposed. Fires when a session terminates; the
  // matcher subject is the termination reason (CC values: clear / resume /
  // logout / prompt_input_exit / bypass_permissions_disabled / other). DSH
  // exposes no reason, so the conservative `other` is reported and matched.
  // Subagent disposal is SubagentStop (wired above), not SessionEnd. ---
  ctx.on('agent/disposed', ({ agent }) => {
    // The session may already be detached by the time an agent is disposed;
    // read it the same total way as everywhere else.
    const sessionId = agent?.session?.header?.id
    if (sessionId !== undefined) knownAgents.delete(sessionId)
    if (agent?.session?.header?.origin === 'subagent') return
    detached.track(runPoint('SessionEnd', 'other', sessionEndPayload(ctx, agent), { agent, signal: detached.signal }))
  })

  // --- PermissionRequest → approval/request waterfall. A hook verdict claims
  // the request; with no verdict the chain delegates so the normal answerers
  // still see it. ApprovalRequest carries no `tool_input`, so the payload
  // recovers it from the matching `tool/call` in the session log. A hook deny
  // is recorded so its approval/decided does not also fire PermissionDenied
  // (CC fires that for denials the hook did not make). Prepended because the
  // desktop's remote bridge registers a terminal root answerer: once the user
  // answers its prompt the chain never reaches later listeners, so a hook
  // registered after it would never run.
  ctx.on('approval/request', async (req, next) => {
    if (typeof req?.toolName !== 'string') return next()
    const agent = req.agent
    const session = agent?.session
    const merged = await runPoint('PermissionRequest', req.toolName, permissionRequestPayload(ctx, agent, req), {
      ...(session !== undefined ? { session } : {}),
      signal: req.signal,
      altMatchQuery: ccBucket(req.toolName) ?? undefined,
    })
    const verdict = permissionRequestVerdict(merged)
    if (verdict === 'deny') {
      if (req.callId !== undefined) selfDeniedCalls.add(req.callId)
      return 'rejected'
    }
    if (verdict === 'allow') return 'allowed-once'
    return next()
  }, { prepend: true })

  // --- One listener owns every point that reads the durable log: compaction
  // boundaries (PreCompact/PostCompact), working-directory changes
  // (CwdChanged), failed turn ends (StopFailure), instruction-file loads
  // (InstructionsLoaded), and the approval audit pair behind PermissionDenied.
  // Sharing one listener lets the points share per-session bookkeeping.
  //
  // PreCompact/PostCompact matcher subject is what triggered compaction
  // (manual | auto): a manual /compact carries a sourceCommandId, automatic
  // pressure does not. They are observe-only — compaction is already durable by
  // the time the event fires, so a blocking PreCompact decision cannot be
  // honored. ---
  const lastCwdBySession = new WeakMap()
  const pendingAsksBySession = new WeakMap()

  ctx.on('session/event', (session, event) => {
    if (session === undefined || event?.type === undefined) return
    switch (event.type) {
      case 'compaction/start':
      case 'compaction/end': {
        const point = event.type === 'compaction/start' ? 'PreCompact' : 'PostCompact'
        const trigger = event.data.sourceCommandId !== undefined ? 'manual' : 'auto'
        detached.track(runPoint(point, trigger, compactPayload(ctx, event, session, trigger), { session, signal: detached.signal }))
        return
      }
      case 'working-directory/change': {
        // DSH records only the new directory; old_cwd is this plugin's cache,
        // seeded from the session header, so the first change has both.
        const next = event.data.cwd
        if (typeof next !== 'string' || next === '') return
        const previous = lastCwdBySession.get(session) ?? session.header?.cwd
        lastCwdBySession.set(session, next)
        if (previous === next) return
        detached.track(runPoint('CwdChanged', '', cwdChangedPayload(ctx, session, previous, next), { session, signal: detached.signal }))
        return
      }
      case 'turn/end': {
        const reason = event.data.reason
        if (reason?.kind !== 'error') return
        const agent = agentFor(session)
        const error = ccErrorFromFailure(reason.error)
        detached.track(runPoint('StopFailure', error, stopFailurePayload(ctx, agent, session, reason.error), { session, signal: detached.signal }))
        return
      }
      case 'user/message': {
        const source = event.data.source
        if (source?.kind !== 'agent-instructions' || !Array.isArray(source.changes)) return
        const loadReason = source.baseline === true ? 'session_start' : 'nested_traversal'
        for (const change of source.changes) {
          if (change?.action === 'remove' || typeof change.path !== 'string') continue
          detached.track(runPoint('InstructionsLoaded', loadReason, instructionsLoadedPayload(ctx, session, change, loadReason), { session, signal: detached.signal }))
        }
        return
      }
      case 'approval/asked': {
        let asks = pendingAsksBySession.get(session)
        if (asks === undefined) {
          asks = new Map()
          pendingAsksBySession.set(session, asks)
        }
        asks.set(event.data.id, { toolName: event.data.toolName, callId: event.data.callId, reason: event.data.reason })
        return
      }
      case 'approval/decided': {
        const asks = pendingAsksBySession.get(session)
        const ask = asks?.get(event.data.id)
        asks?.delete(event.data.id)
        if (ask === undefined) return
        // Always retire the marker, whatever the outcome, so a cancelled ask
        // cannot leave one behind.
        const selfDenied = ask.callId !== undefined && selfDeniedCalls.delete(ask.callId)
        if (selfDenied || event.data.outcome !== 'rejected') return
        const agent = agentFor(session)
        detached.track(runPoint('PermissionDenied', ask.toolName, permissionDeniedPayload(ctx, agent, session, ask), {
          session, signal: detached.signal,
          altMatchQuery: ccBucket(ask.toolName) ?? undefined,
        }).then((merged) => {
          // `retry: true` is a hint to the model that it may ask again; without
          // a reachable agent the hint is dropped rather than faked.
          if (!permissionDeniedRetry(merged) || agent === undefined) return
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: 'The previous tool call was denied. You may retry it if you believe it should be allowed.' }],
            source: PLUGIN_SOURCE,
          }))
        }).catch((error) => ctx.logger.warn(`cc-hooks: PermissionDenied hook failed: ${String(error)}`)))
        return
      }
      default:
    }
  })
}

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(agent) {
  if (!agent) return 0
  // `Session.events` was removed in DSH 0.1.2-alpha.4; sessionLastEvent reads
  // the log through the new snapshotEvents()/eventAt() surface.
  const last = sessionLastEvent(agent.session, (e) => e.type === 'turn/start')
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/**
 * The text of the most recent assistant message in the agent's log, or `''`
 * without an agent or before any assistant reply. This is the CC
 * `last_assistant_message` input: a Stop/SubagentStop hook must be able to see
 * what the agent just said without parsing the transcript (command hooks can
 * read the file; a prompt/agent hook is a bare LLM/subagent call and can only
 * judge from the payload). Reasoning blocks are excluded — CC carries the
 * visible reply text only.
 */
function lastAssistantMessage(agent) {
  const last = sessionLastEvent(agent?.session, (e) => e.type === 'assistant/message')
  if (last?.type !== 'assistant/message') return ''
  const content = last.data?.message?.content
  return blocksToText(content)
}

/**
 * Whether a tool result reports a non-zero shell exit code. DSH shell tools
 * return the canonical `{ kind: 'foreground', exitCode, … }` value for a
 * command that ran (even one that failed), so `exitCode !== 0` identifies a
 * CC-style tool failure that `result.isError` (infrastructure only) misses.
 * Background acknowledgements and non-shell tools carry no exitCode and are
 * never failures here.
 */
function toolExitedNonZero(result) {
  const value = result?.value
  if (typeof value !== 'object' || value === null) return false
  const exitCode = value.exitCode
  return typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content) {
  return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
}

/**
 * Best-effort CC `transcript_path` for a hook payload.
 *
 * DSH's public `SessionPersistence` service (0.1.5) exposes only
 * `create`/`open`/`flush`/`stat`/`list` — it declares NO artifact-path accessor.
 * The JSONL backend does implement one (`locate`), but as a TypeScript
 * `private` method, i.e. it is not part of the supported contract and a
 * different persistence provider may not have it at all.
 *
 * The previous code was `ctx.get('sessionPersistence')?.locate(header)?.path`.
 * That optional chain guards the SERVICE, not the method: whenever the service
 * is registered (the normal case) the member is read and CALLED, so a provider
 * without `locate` raised `TypeError: …locate is not a function` synchronously
 * inside every payload builder — killing SessionStart, PreToolUse, Stop, … .
 *
 * A missing method and a throwing call therefore both degrade to `''`, which is
 * exactly what the official bridge ships (`hooks-claude-code` hardcodes
 * `transcript_path: ''` and records the gap in its README). The field is
 * populated only where the private accessor genuinely exists.
 *
 * @param {object} ctx - the plugin context (`ctx.get('sessionPersistence')`).
 * @param {{header: object}|undefined} session - the session whose path is wanted.
 * @returns {string} the on-disk transcript path, or `''` when unavailable.
 */
function transcriptPath(ctx, session) {
  if (session === undefined) return ''
  let persistence
  try { persistence = ctx.get('sessionPersistence') } catch { return '' }
  if (typeof persistence?.locate !== 'function') return ''
  try { return persistence.locate(session.header)?.path ?? '' } catch { return '' }
}

function base(ctx, agent, event) {
  return {
    session_id: agent?.session?.header?.id ?? '',
    transcript_path: transcriptPath(ctx, agent?.session),
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
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
function postToolPayload(ctx, event, exec, result) {
  return { ...base(ctx, exec.agent, event), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
function stopPayload(ctx, agent) {
  return {
    ...base(ctx, agent, 'Stop'),
    stop_hook_active: false,
    last_assistant_message: lastAssistantMessage(agent),
  }
}
/**
 * SessionEnd payload from the CC base plus `reason`. DSH exposes no
 * termination reason, so the conservative `other` is always reported.
 */
function sessionEndPayload(ctx, agent) {
  return { ...base(ctx, agent, 'SessionEnd'), reason: 'other' }
}
/**
 * PreCompact/PostCompact payload from the CC base (session-only; no agent)
 * plus `trigger` (manual | auto). `compactionId` mirrors CC's identity for a
 * single compaction run and lets paired start/end hooks correlate.
 */
function compactPayload(ctx, event, session, trigger) {
  return {
    session_id: session.header.id ?? '',
    transcript_path: transcriptPath(ctx, session),
    cwd: session.header.cwd ?? process.cwd(),
    hook_event_name: event,
    trigger,
    compactionId: event.data.compactionId,
  }
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
    ...(event === 'SubagentStop' ? { stop_hook_active: false, last_assistant_message: lastAssistantMessage(child) } : {}),
  }
}

/**
 * The tool input recorded for `callId`, or `{}`.
 *
 * `ApprovalRequest` carries only the tool NAME (a UI already streamed the call),
 * so the PermissionRequest/PermissionDenied payloads recover the CC
 * `tool_input` from the matching `tool/call` in the session log. An absent or
 * unparseable entry degrades to `{}` — the payload must never throw.
 */
function toolInputByCallId(session, callId) {
  if (session === undefined || callId === undefined) return {}
  const event = sessionLastEvent(session, (e) => e.type === 'tool/call' && e.data?.callId === callId)
  if (event?.type !== 'tool/call') return {}
  try {
    const parsed = JSON.parse(event.data.arguments)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function permissionRequestPayload(ctx, agent, req) {
  return {
    ...base(ctx, agent, 'PermissionRequest'),
    tool_name: req.toolName,
    tool_input: toolInputByCallId(agent?.session, req.callId),
    permission_suggestions: [],
  }
}

function permissionDeniedPayload(ctx, agent, session, ask) {
  return {
    ...base(ctx, agent ?? { session }, 'PermissionDenied'),
    tool_name: ask.toolName,
    tool_input: toolInputByCallId(session, ask.callId),
    tool_use_id: ask.callId ?? '',
    ...(ask.reason !== undefined ? { reason: ask.reason } : {}),
  }
}

function cwdChangedPayload(ctx, session, previous, next) {
  return {
    ...base(ctx, { session }, 'CwdChanged'),
    // DSH never reports the previous directory; a session whose header carries
    // none yields the event without old_cwd rather than not at all.
    ...(previous !== undefined ? { old_cwd: previous } : {}),
    new_cwd: next,
  }
}

function stopFailurePayload(ctx, agent, session, failure) {
  return {
    ...base(ctx, agent ?? { session }, 'StopFailure'),
    error: ccErrorFromFailure(failure),
    ...(failure !== undefined && failure !== null
      ? {
          error_details: {
            code: failure.code,
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            message: failure.message,
          },
        }
      : {}),
    last_assistant_message: agent !== undefined ? lastAssistantMessage(agent) : '',
  }
}

function instructionsLoadedPayload(ctx, session, change, loadReason) {
  return {
    ...base(ctx, { session }, 'InstructionsLoaded'),
    file_path: change.path,
    // DSH instruction scopes are `user-global` or a project directory key;
    // CC's Local/Managed tiers have no DSH counterpart.
    memory_type: change.scope === 'user-global' ? 'User' : 'Project',
    load_reason: loadReason,
  }
}

/**
 * DSH `LlmFailure.code` → CC `StopFailure.error` value. Codes CC has no
 * counterpart for (CONTEXT_WINDOW_EXCEEDED, EMPTY_RESPONSE, …) land on the
 * nearest CC class; anything unrecognized is `unknown`, exactly as CC reports
 * a failure it cannot classify.
 */
const CC_ERROR_BY_CODE = new Map([
  ['RATE_LIMIT', 'rate_limit'],
  ['SERVER', 'server_error'],
  ['TIMEOUT', 'server_error'],
  ['TRANSPORT', 'server_error'],
  ['QUOTA', 'billing_error'],
  ['CONTEXT_WINDOW_EXCEEDED', 'invalid_request'],
  ['INVALID_CREDENTIAL', 'authentication_failed'],
  ['MISSING_CREDENTIAL', 'authentication_failed'],
  ['AUTH', 'authentication_failed'],
  ['INVALID_ARGS', 'invalid_request'],
  ['NO_ADAPTER', 'unknown'],
  ['EMPTY_RESPONSE', 'unknown'],
  ['MAX_TOKENS', 'max_output_tokens'],
  ['OUTPUT_TOKEN_LIMIT', 'max_output_tokens'],
])

function ccErrorFromFailure(failure) {
  if (failure === undefined || failure === null) return 'unknown'
  const mapped = CC_ERROR_BY_CODE.get(failure.code)
  if (mapped !== undefined) return mapped
  const status = failure.status
  if (typeof status === 'number') {
    if (status === 429) return 'rate_limit'
    if (status === 529) return 'overloaded'
    if (status === 401 || status === 403) return 'authentication_failed'
    if (status === 404) return 'model_not_found'
    if (status === 400 || status === 413 || status === 422) return 'invalid_request'
    if (status >= 500) return 'server_error'
  }
  return 'unknown'
}

/**
 * The raw structured objects a point's hooks printed on stdout (exit 0).
 *
 * The shared protocol decoder only understands the fields common to every
 * event; the CC shapes for PermissionRequest (`decision.behavior`) and
 * PermissionDenied (`retry`) live outside it, so those points read the same
 * stdout themselves. Malformed JSON is ignored, as in the protocol decoder.
 */
function rawHookObjects(merged) {
  const parsed = []
  for (const output of merged.outputs ?? []) {
    const text = typeof output?.stdout === 'string' ? output.stdout.trim() : ''
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed.push(value)
    } catch {
      // Malformed JSON stays plain stdout and carries no decision.
    }
  }
  return parsed
}

/** A PermissionRequest hook verdict: 'deny' | 'allow' | undefined. */
function permissionRequestVerdict(merged) {
  // Exit 2 becomes a top-level 'block'; a legacy top-level decision:'block'
  // does too. Both deny the request, as in CC.
  if (merged.decision === 'deny' || merged.decision === 'block') return 'deny'
  let allow = false
  for (const parsed of rawHookObjects(merged)) {
    const specific = parsed.hookSpecificOutput
    if (specific === null || typeof specific !== 'object' || specific.hookEventName !== 'PermissionRequest') continue
    const decision = specific.decision
    if (decision === null || typeof decision !== 'object') continue
    if (decision.behavior === 'deny') return 'deny'
    if (decision.behavior === 'allow') allow = true
  }
  if (allow) return 'allow'
  if (merged.decision === 'allow' || merged.decision === 'approve') return 'allow'
  return undefined
}

/** Whether a PermissionDenied hook asked the model to retry the denied call. */
function permissionDeniedRetry(merged) {
  return rawHookObjects(merged).some((parsed) => {
    const specific = parsed.hookSpecificOutput
    return specific !== null && typeof specific === 'object'
      && specific.hookEventName === 'PermissionDenied'
      && specific.retry === true
  })
}
