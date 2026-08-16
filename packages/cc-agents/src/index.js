// dsh-cc-agents — adapt Claude Code "first kind" agents (.claude/agents/*.md)
// into DSH delegation.
//
// CC agents are identity-anchored subagents: frontmatter (name/description/
// tools/disallowedTools/model/skills/…) + a system-prompt body. DSH has no
// pre-registered agent directory, so this adapter provides both halves:
//   1. catalog injection (agent/session-start → user message): the model sees
//      the available agents' name + description (CC @-mention semantics).
//   2. a `cc_agent` delegation tool: looks the agent up, then starts a
//      subagent via ctx.subagents with
//        persona    = agent body        (DSH native identity channel)
//        toolFilter = tools/disallowedTools expanded to DSH tool names
//        agentOptions.model = frontmatter.model
//      plus skill preloading (frontmatter.skills → skill bodies) and
//      initialPrompt/background support.
//
// Classification lives in dsh-cc-loader; BLOCKED agents (isolation:worktree)
// are never offered for delegation.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadClaude, parseFrontmatter, expandCcToolToDsh } from 'dsh-cc-loader'

export const name = 'cc-agents'
export const inject = ['tools', 'subagents']

export const Config = z.object({
  /** ctx.subagents provider the delegation runs on (spawn/fork). */
  provider: z.string().default('spawn'),
  /** Model-facing tool name. */
  toolName: z.string().default('cc_agent'),
  /** Inject the agent catalog into every session start (CC @-mention semantics). */
  injectCatalog: z.boolean().default(true),
  /** Expose run_in_background. */
  enableRunInBackground: z.boolean().default(true),
  /** Absolute delegation-depth cap (default 3). */
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).default(3),
  projectRootMarkers: z.array(z.string()).default(['.git']),
  enableGlobal: z.boolean().default(true),
  globalClaudeDir: z.string(),
  homeDir: z.string(),
  projectAgentRank: z.number().default(150),
  globalAgentRank: z.number().default(160),
  /**
   * CC frontmatter model names → DSH model names. CC agents name Claude
   * models (sonnet/opus/…), which this deployment cannot resolve; without an
   * alias the declared model is ignored (default model) with a warning.
   */
  modelAliases: z.dict(z.string()).default({}),
})

/** The `{kind:'plugin'}` source stamped on every context this adapter injects. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'cc-agents' }

export function apply(ctx, config = {}) {
  const homeDir = config.homeDir ?? homedir()
  const loaderOpts = () => ({
    cwd: process.cwd(), // replaced per call
    homeDir,
    projectRootMarkers: config.projectRootMarkers,
    enableGlobal: config.enableGlobal,
    globalClaudeDir: config.globalClaudeDir,
    projectSkillRank: config.projectAgentRank,
    globalSkillRank: config.globalAgentRank,
  })

  ctx.logger.info(`cc-agents: registered (delegation via ${config.provider}, catalog injection ${config.injectCatalog !== false ? 'on' : 'off'})`)

  // Catalog state: cached per session id so session-start and tool calls
  // share one discovery per session. Invalidation = new session id.
  const sessionCache = new Map() // sessionId → { agents, skills }

  async function catalogFor(agent) {
    const sessionId = agent?.session?.header?.id
    if (sessionId !== undefined) {
      const hit = sessionCache.get(sessionId)
      if (hit !== undefined) return hit
    }
    const cwd = agent?.session?.header?.cwd ?? process.cwd()
    const ir = await loadClaude({ ...loaderOpts(), cwd })
    for (const w of ir.warnings) ctx.logger.warn(`cc-agents: ${w}`)
    const entry = { agents: ir.components.agents, skills: ir.components.skills, cwd }
    if (sessionId !== undefined) sessionCache.set(sessionId, entry)
    return entry
  }

  // ─── catalog injection (agent/session-start) ──────────────────────────────
  // Top-level sessions only: subagents (delegated children carry a
  // parentSession header) get their own system prompt — the CC agent body as
  // persona — and must NOT receive the parent's catalog reminder. Injecting it
  // would append a user message after the delegation prompt, which the child
  // then mistakes for its actual task.
  if (config.injectCatalog !== false) {
    ctx.on('agent/session-start', async ({ agent }) => {
      try {
        if (agent?.session?.header?.parentSession !== undefined) return
        const { agents } = await catalogFor(agent)
        const delegatable = agents.filter((a) => a.status !== 'BLOCKED')
        if (delegatable.length === 0) return
        const lines = delegatable.map((a) => {
          const tools = a.tools.length > 0 ? ` (tools: ${a.tools.join(', ')})` : ''
          return `- ${a.name}: ${a.description}${tools}`
        })
        const text = `<system-reminder>
Claude Code agents available for delegation via the ${config.toolName} tool:
${lines.join('\n')}
      </system-reminder>`
        agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
      } catch (error) {
        ctx.logger.warn(`cc-agents: catalog injection failed: ${String(error)}`)
      }
    })
  }

  // ─── delegation tool ──────────────────────────────────────────────────────
  const toolName = config.toolName ?? 'cc_agent'
  ctx.tools.register(defineCcAgentTool(ctx, config, catalogFor, toolName))
}

// ─── tool definition ────────────────────────────────────────────────────────

function defineCcAgentTool(ctx, config, catalogFor, toolName) {
  const backgroundEnabled = config.enableRunInBackground !== false
  const providerName = config.provider

  const description = `Delegate a task to a Claude Code agent (identity-anchored subagent): the agent's system prompt is its persona, its frontmatter tools are scoped to the child, and its skills are preloaded. The agent runs as a fresh child that does not see this conversation — give it a complete, standalone prompt. It returns its result, not its intermediate steps.`

  return {
    name: toolName,
    description: description + (backgroundEnabled
      ? ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
      : ''),
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'The Claude Code agent to delegate to (its name from the injected catalog).',
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the agent. It does not share this conversation\'s context.',
        },
        ...backgroundEnabled ? {
          run_in_background: {
            type: 'boolean',
            description: 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
          },
        } : {},
      },
      required: ['agent', 'description', 'prompt'],
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'jobId'],
            properties: {
              kind: { type: 'string', const: 'background' },
              jobId: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'runId', 'output'],
            properties: {
              kind: { type: 'string', const: 'foreground' },
              runId: { type: 'string' },
              output: { type: 'array', items: {} },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background CC agent task ${value.jobId}`
          : outputValueText(value.output),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
      // Raw ctx.tools.register() skips defineTool's arg validation, so enforce
      // the required string parameters here (a missing prompt must never turn
      // into the literal text "undefined" inside the child's prompt).
      if (typeof args?.agent !== 'string' || args.agent.length === 0) {
        throw new Error(`${toolName}: "agent" (the Claude Code agent name) is required`)
      }
      if (typeof args?.description !== 'string' || args.description.length === 0) {
        throw new Error(`${toolName}: "description" (a short task description) is required`)
      }
      if (typeof args?.prompt !== 'string' || args.prompt.length === 0) {
        throw new Error(`${toolName}: "prompt" (the standalone task for the agent) is required`)
      }

      const { agents, skills } = await catalogFor(parent)
      const agent = agents.find((a) => a.name === args.agent)
      if (agent === undefined) {
        const available = agents.filter((a) => a.status !== 'BLOCKED').map((a) => a.name)
        throw new Error(`cc-agents: unknown agent "${args.agent}" (available: ${available.join(', ') || 'none'})`)      }
      if (agent.status === 'BLOCKED') {
        throw new Error(`cc-agents: agent "${args.agent}" is not delegatable (${agent.notes?.join('; ') ?? 'blocked'})`)
      }

      // ── tool filter: disallowedTools first, then tools (CC semantics). ────
      const deny = expandAll(agent.disallowedTools)
      const allow = expandAll(agent.tools)
      const knownDeny = filterKnownToolNames(parent.ctx, deny)
      const knownAllow = allow.length > 0 ? filterKnownToolNames(parent.ctx, allow) : []
      const toolFilter = knownDeny.length > 0 || knownAllow.length > 0
        ? {
            ...knownDeny.length > 0 ? { deny: knownDeny } : {},
            ...knownAllow.length > 0 ? { allow: knownAllow } : {},
          }
        : undefined
      if (knownDeny.length < deny.length || knownAllow.length < allow.length) {
        ctx.logger.warn(`cc-agents: agent "${agent.name}" — dropped unknown tool names (deny ${deny.length - knownDeny.length}, allow ${allow.length - knownAllow.length})`)
      }

      // ── prompt: preloaded skills + initialPrompt + user task. ─────────────
      const preload = []
      for (const skillName of agent.skills) {
        const skill = skills.find((s) => s.name === skillName)
        if (skill === undefined) {
          ctx.logger.warn(`cc-agents: agent "${agent.name}" preload skill "${skillName}" not found`)
          continue
        }
        let body
        try {
          const raw = await readFile(skill.locator.path, { encoding: 'utf8' })
          const parsed = parseFrontmatter(raw)
          body = parsed === undefined ? raw.trim() : parsed.body.trim()
        } catch { continue }
        if (body.length > 0) preload.push(`<skill name="${skillName}">\n${body}\n</skill>`)
      }
      const parts = []
      if (preload.length > 0) parts.push(`Preloaded skills:\n${preload.join('\n\n')}`)
      if (agent.initialPrompt !== undefined) parts.push(agent.initialPrompt)
      parts.push(args.prompt)
      const prompt = [{ type: 'text', text: parts.join('\n\n') }]

      const model = resolveModel(ctx, config, agent)
      const request = {
        label: `cc:${agent.scope}:${agent.name}`,
        prompt,
        parent,
        persona: personaFor(agent),
        ...toolFilter !== undefined ? { toolFilter } : {},
        ...model !== undefined ? { agentOptions: { model } } : {},
        maxDepth: config.maxDepth,
      }

      const runInBackground = args.run_in_background === true || agent.background === true
      if (runInBackground) {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        const id = jobs.start({
          kind: 'subagent',
          label: request.label,
          owner: parent,
          run: () => {
            const controller = new AbortController()
            const start = ctx.subagents.start(providerName, { ...request, signal: controller.signal })
            return {
              cancel: (reason) => controller.abort(reason ?? 'background CC agent task killed'),
              done: settleStart(start, controller.signal),
            }
          },
        })
        return { kind: 'background', jobId: id }
      }

      const run = await ctx.subagents.start(providerName, { ...request, signal: exec.signal })
      try {
        return await settleForegroundRun(run)
      } catch (error) {
        ctx.logger.warn(`cc-agents: agent "${agent.name}" run failed: ${String(error)}`)
        throw error
      }
    },
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * The delegation persona: the agent body, plus any frontmatter `context`
 * material appended verbatim (community convention; CC has no such field in
 * the official 16, but some agents carry extra system-prompt prose there).
 */
export function personaFor(agent) {
  const context = agent.context
  if (context === undefined || context.length === 0) return agent.systemPrompt
  return `${agent.systemPrompt}\n\n${context.join('\n\n')}`
}

/**
 * Resolve a CC frontmatter `model` name to a DSH model name via the
 * `modelAliases` config. CC agents name Claude models (sonnet/opus/…), which
 * a DSH deployment usually cannot resolve; without an alias the declared
 * model is dropped (default model) with a warning. Never returns a raw CC
 * model name — passing it to agentOptions would fail the child.
 */
function resolveModel(ctx, config, agent) {
  const ccModel = agent.model
  if (ccModel === undefined) return undefined
  const alias = config.modelAliases?.[ccModel]
  if (alias !== undefined && typeof alias === 'string' && alias.length > 0) return alias
  ctx.logger.warn(`cc-agents: agent "${agent.name}" declares model "${ccModel}" — no modelAliases mapping, using the default model`)
  return undefined
}

/** Expand CC tool names to candidate DSH names, collecting drop notes. */
function expandAll(ccNames) {
  const notes = []
  const out = []
  for (const name of ccNames) out.push(...expandCcToolToDsh(name, notes))
  return out
}

/**
 * Keep only tool names the current scope's registry accepts, probing each
 * candidate with a scoped restrict() + immediate dispose. The parent's
 * registry approximates the child's (spawn children inherit the deployment
 * composition), so a name valid here is valid in the child's creation window.
 */
function filterKnownToolNames(agentCtx, names) {
  const known = []
  for (const name of names) {
    try {
      const dispose = agentCtx.tools.restrict({ deny: [name] })
      dispose()
      known.push(name)
    } catch {
      // Unknown global tool (or scoped-only registration) — skip.
    }
  }
  return known
}

/** Render text blocks from the canonical JSON block array. */
function outputValueText(values) {
  return values
    .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start, signal) {
  try {
    return await settleForegroundRun(await start)
  } catch (error) {
    return signal.aborted
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** Collect and release one foreground run. */
async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output,
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason],
        `CC agent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`)
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'CC agent run was cancelled'
    case 'error': return 'CC agent run failed'
    case 'max-tokens': return 'CC agent run hit its token limit before finishing'
    case 'refusal': return 'CC agent declined the task'
    default: return `CC agent run ended abnormally (${String(result.stopReason)})`
  }
}

/** Append partial output to a stop-reason error so real text still reaches the model. */
function withPartialText(error, output) {
  const text = output
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}
