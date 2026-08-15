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
import { loadClaude, parseFrontmatter } from 'dsh-cc-loader'

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

  if (config.enableSkills !== false) {
    ctx.skills.registerProvider((control) =>
      new CcSkillsProvider(ctx, control, config, loaderOpts))
  }
  if (config.enableRules !== false) {
    registerRulesSection(ctx, config, loaderOpts)
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
