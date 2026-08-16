// dsh-cc-skills — adapt Claude Code .claude/ skills, commands and rules into
// DSH, driven by the dsh-cc-loader IR.
//
// Fork lineage: this package started as a fork of dsh-claude-compat (MIT, ©
// biedongbin); the discovery/parsing logic now lives in dsh-cc-loader so every
// dsh-cc adapter shares one parse layer. This adapter only registers:
//   - ctx.skills provider: IR skills/commands (project + global ~/.claude)
//   - rules message-stream injection (project first, then global)
//
// Project entries outrank global ones via skill rank (project 150 < global
// 160; lower ranks win duplicate names in DSH).

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadClaude, parseFrontmatter, expandCcToolToDsh } from 'dsh-cc-loader'

export const name = 'cc-skills'
export const inject = ['skills']

export const Config = z.object({
  projectRootMarkers: z.array(z.string()).default(['.git']),
  // 150: between project-dsh (100) and project-agents (200). DSH-native skills
  // win over Claude skills; Claude skills win over user-level.
  skillRank: z.number().default(150),
  skillSource: z.string().default('project-claude'),
  rulesMaxBytes: z.number().default(65536),
  enableRules: z.boolean().default(true),
  enableSkills: z.boolean().default(true),
  // ── global user-level ~/.claude ───────────────────────────────────────────
  enableGlobal: z.boolean().default(true),
  globalClaudeDir: z.string(),
  globalSkillRank: z.number().default(160),
  globalSkillSource: z.string().default('user-claude'),
  homeDir: z.string(),
  // ── skill tool-scope (allowed-tools / disallowed-tools) ──────────────────
  // CC semantics: while a skill is active (the round it was invoked in), tools
  // listed in allowed-tools run without approval and tools listed in
  // disallowed-tools are removed from the pool. "Active" ends at the next user
  // message (CC: cleared on the next message).
  enableToolScope: z.boolean().default(true),
})

export function apply(ctx, config = {}) {
  const homeDir = config.homeDir ?? homedir()
  const loaderOpts = () => ({
    cwd: process.cwd(), // replaced per-call by list/get
    homeDir,
    projectRootMarkers: config.projectRootMarkers,
    enableGlobal: config.enableGlobal,
    globalClaudeDir: config.globalClaudeDir,
    projectSkillRank: config.skillRank,
    globalSkillRank: config.globalSkillRank,
  })
  ctx.logger.info('cc-skills: provider registered (project .claude + global ~/.claude)')

  if (config.enableSkills !== false) {
    ctx.skills.registerProvider((control) =>
      new CcSkillsProvider(ctx, control, config, loaderOpts))
  }
  if (config.enableRules !== false) {
    registerRulesSection(ctx, config, loaderOpts)
  }
  if (config.enableToolScope !== false) {
    registerToolScope(ctx, config, loaderOpts)
  }
}

// ─── skill provider ──────────────────────────────────────────────────────────

class CcSkillsProvider {
  constructor(ctx, control, config, loaderOpts) {
    this.ctx = ctx
    this.name = 'cc-skills'
    this.config = config
    this.loaderOpts = loaderOpts
    control.signal.addEventListener('abort', () => {}, { once: true })
  }

  async list(options) {
    const cwd = options?.cwd
    if (cwd === undefined || cwd === null) return []
    const ir = await loadClaude({ ...this.loaderOpts(), cwd })
    const out = []
    for (const s of ir.components.skills) {
      if (s.status !== 'DIRECT' && s.status !== 'ADAPTED') continue
      out.push({
        name: s.name,
        description: s.description,
        ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
        invocation: s.invocation,
        source: s.source,
        provider: this.name,
        rank: s.rank,
        locator: s.locator,
        resourceBase: s.resourceBase,
        path: s.locator.path,
      })
    }
    for (const c of ir.components.commands) {
      if (c.status !== 'DIRECT' && c.status !== 'ADAPTED') continue
      out.push({
        name: c.name,
        description: c.description,
        invocation: c.invocation,
        source: c.source,
        provider: this.name,
        rank: c.rank,
        locator: c.locator,
        resourceBase: c.resourceBase,
        path: c.locator.path,
      })
    }
    for (const w of ir.warnings) this.ctx.logger.warn(`cc-skills: ${w}`)
    return out
  }

  async get(candidate) {
    const locator = candidate.locator
    let raw
    try { raw = await readFile(locator.path, { encoding: 'utf8' }) }
    catch { return undefined }
    const parsed = parseFrontmatter(raw)
    const content = parsed === undefined ? raw.trim() : parsed.body.trim()
    return {
      name: candidate.name,
      description: candidate.description,
      ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
      invocation: candidate.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      content,
    }
  }
}

// ─── rules section ───────────────────────────────────────────────────────────

function registerRulesSection(ctx, config, loaderOpts) {
  const maxBytes = config.rulesMaxBytes ?? 65536
  // Cache built messages per session cwd — pre-step fires every step.
  const cache = new Map()
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const present = (list) => list.some((m) => m?.source?.kind === 'cc-skills')
    const alreadyInjected = present(messages)
      || present(decision.messages)
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.events[seq]
        return event?.type === 'user/message'
          && event.data?.source?.kind === 'cc-skills'
      })
    if (alreadyInjected) return decision
    const cwd = agent.session.header?.cwd ?? process.cwd()
    if (!cache.has(cwd)) {
      const text = await buildRulesText(cwd, loaderOpts, maxBytes, ctx)
      if (text.length === 0) return decision
      cache.set(cwd, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'cc-skills', form: 'rules' },
      }))
    }
    return {
      kind: 'enter',
      messages: decision.messages.toSpliced(0, 0, cache.get(cwd)),
    }
  })
}

/** Project rules first, then global user rules (project priority in the text). */
async function buildRulesText(cwd, loaderOpts, maxBytes, ctx) {
  const ir = await loadClaude({ ...loaderOpts(), cwd })
  const rules = ir.components.rules.filter((r) => r.status === 'DIRECT' || r.status === 'ADAPTED')
  const parts = []
  let total = 0
  for (const rule of rules) {
    let raw
    try { raw = await readFile(rule.path, { encoding: 'utf8' }) } catch { continue }
    const chunk = `## ${rule.name}\n\n${raw.trim()}\n`
    if (total + chunk.length > maxBytes) break
    parts.push(chunk)
    total += chunk.length
  }
  if (parts.length === 0) return ''
  return `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
${parts.join('\n')}
      </system-reminder>`
}

// ─── skill tool-scope (allowed-tools / disallowed-tools) ─────────────────────

// Per-agent activation state. "Active" spans from the skill invocation (the
// `skill` tool call or a `/name` gesture) to the next user message, matching
// CC's "cleared on the next message" semantics.
//
//   agentScope: Map<agentId, { skill, allowed: Set, disallowed: Set, disposers: [] }>
const agentScopes = new Map()

function log(ctx, level, message) {
  try { ctx.logger?.[level]?.(`cc-skills: ${message}`) } catch { /* logger absence is not fatal */ }
}

/**
 * Activate a skill's tool scope for an agent. Looks the skill up in the IR
 * (same discovery the provider uses), expands CC tool names to DSH names, and
 * hides disallowed tools via the agent's scoped tool registry. Never throws —
 * a missing skill or an unavailable registry degrades to "no scope".
 */
async function activateSkillScope(ctx, agent, skillName, loaderOpts) {
  if (!agent || typeof skillName !== 'string' || skillName.length === 0) return
  const agentId = agent.id ?? String(agent)
  const cwd = agent.session?.header?.cwd ?? process.cwd()
  let ir
  try { ir = await loadClaude({ ...loaderOpts(), cwd }) } catch (error) {
    log(ctx, 'warn', `skill "${skillName}": discovery failed — no tool scope: ${String(error)}`)
    return
  }
  const skill = ir.components.skills.find((s) => s.name === skillName)
  if (skill === undefined) {
    log(ctx, 'info', `skill "${skillName}" not in IR — no tool scope`)
    return
  }
  const notes = []
  const allowed = new Set(skill.allowedTools.flatMap((name) => expandCcToolToDsh(name, notes)))
  const disallowed = new Set(skill.disallowedTools.flatMap((name) => expandCcToolToDsh(name, notes)))
  for (const n of notes) log(ctx, 'warn', `skill "${skillName}": ${n}`)

  // Hide disallowed tools from the model via the agent's scoped registry.
  // NOTE (verified in dsh-tools view()): restrict() only admits INHERITED
  // global tools — the global layer plus ancestor preset layers. A tool
  // registered in the agent's OWN scope layer (e.g. fs tools the agent
  // preset mounts per-session) is never restrictable: "A restriction filters
  // what a scope inherits … and never what its OWN layer registers." Those
  // still get denied at pre-execute (the gate below), but stay visible.
  const disposers = []
  if (disallowed.size > 0 && typeof agent.ctx?.tools?.restrict === 'function') {
    for (const name of disallowed) {
      try {
        disposers.push(agent.ctx.tools.restrict({ deny: [name] }))
      } catch (error) {
        log(ctx, 'warn', `skill "${skillName}": restrict "${name}" failed (still denied at pre-execute): ${String(error)}`)
      }
    }
  }
  clearAgentScope(agentId, disposers)
  agentScopes.set(agentId, { skill: skillName, allowed, disallowed, disposers })
  log(ctx, 'info', `skill "${skillName}" active for agent ${agentId} — ${allowed.size} allowed, ${disallowed.size} disallowed tool(s)`)
}

/** Dispose a previous scope's restrict disposers, then record new ones. */
function clearAgentScope(agentId, newDisposers = []) {
  const prev = agentScopes.get(agentId)
  if (prev !== undefined) {
    for (const dispose of prev.disposers) {
      try { dispose() } catch { /* best effort */ }
    }
  }
  if (newDisposers.length === 0) agentScopes.delete(agentId)
}

/**
 * Register the tool-scope gate:
 *   - agent/pre-step clears the previous round's activation (CC: "cleared on
 *     the next message") and activates a skill named by a `/name` gesture
 *     (tool-skill injects a message with source.kind === 'skill-invocation').
 *   - tools/pre-execute activates on the `skill` tool call, then gates: a
 *     disallowed tool is denied outright; an allowed tool that the downstream
 *     chain would `ask` about is allowed instead (deny from the downstream
 *     chain is preserved — CC order is deny > ask > allow).
 *
 * Both listeners call next() when they are not the decision owner (waterfall
 * discipline), and apply() never throws synchronously.
 */
function registerToolScope(ctx, config, loaderOpts) {
  // Clear the previous round's activation at TURN END (agent/turn-stopping),
  // not in pre-step: the agent loop assembles the model-facing tool list
  // (systemPrompt.assemble) BEFORE the pre-step waterfall runs, so a clear
  // inside pre-step only takes effect on the NEXT turn's assembly — the model
  // would keep seeing the hidden tools for one extra round (CC: "cleared on
  // the next message" must hold from the very next round). turn-stopping fires
  // when a round ends with no pending tool continuation, which is exactly the
  // boundary before the next user message's assembly.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      if (agent === undefined || agent === null) return
      clearAgentScope(agent.id ?? String(agent))
    } catch (error) {
      log(ctx, 'warn', `turn-stopping tool-scope clear failed: ${String(error)}`)
    }
  })

  // prepend: run outside tool-skill's own pre-step listener, so the final
  // decision.messages (after tool-skill injected the /name gesture) is what we
  // inspect. The rules-injection listener below is unaffected: it still runs
  // inside our next(). A /name gesture activates the skill for THIS round; the
  // round's end clears it (above), matching CC semantics.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    try {
      if (agent === undefined || agent === null) return decision
      // A /name gesture: tool-skill injected a skill-invocation message into
      // the final decision (source.kind === 'skill-invocation').
      for (const message of decision.messages ?? []) {
        const source = message?.source
        if (source?.kind !== 'skill-invocation' || typeof source.name !== 'string') continue
        await activateSkillScope(ctx, agent, source.name, loaderOpts)
      }
    } catch (error) {
      log(ctx, 'warn', `pre-step tool-scope handling failed: ${String(error)}`)
    }
    return decision
  }, { prepend: true })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return next()
      const agentId = agent.id ?? String(agent)
      // The `skill` tool call itself activates the skill for this round.
      if (exec?.name === 'skill' && typeof exec.arguments?.name === 'string') {
        await activateSkillScope(ctx, agent, exec.arguments.name, loaderOpts)
      }
      const scope = agentScopes.get(agentId)
      if (scope === undefined) return next()
      if (scope.disallowed.has(exec.name)) {
        return {
          kind: 'deny',
          reason: `tool "${exec.name}" is disallowed while skill "${scope.skill}" is active (disallowed-tools)`,
        }
      }
      if (scope.allowed.has(exec.name)) {
        // Preserve a downstream deny; upgrade an ask to allow (CC: allowed-tools
        // runs without approval). Only the decision owner short-circuits.
        const decision = await next()
        if (decision.kind === 'ask') return { kind: 'allow' }
        return decision
      }
      return next()
    } catch (error) {
      log(ctx, 'warn', `pre-execute tool-scope handling failed: ${String(error)}`)
      return next()
    }
  })

  ctx.effect(() => () => {
    for (const scope of agentScopes.values()) {
      for (const dispose of scope.disposers) {
        try { dispose() } catch { /* best effort */ }
      }
    }
    agentScopes.clear()
  })

  log(ctx, 'info', 'tool-scope gate registered (skill allowed-tools / disallowed-tools)')
}
