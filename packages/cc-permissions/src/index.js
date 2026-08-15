// cc-permissions — enforce CC permission rules in DSH.
//
// Read-only bridge: `.claude/settings.json` (user/project/local) is parsed by
// dsh-cc-loader into rules, and a `tools/pre-execute` listener folds them
// deny → ask → allow exactly like Claude Code. DSH-side approvals never write
// back to `.claude` (no cross-tool permission sync — CC/Codex/DSH permission
// semantics differ).
//
// Bare-name deny rules additionally hide the tool per-agent via
// `agent.ctx.tools.restrict({ deny })`, so the model does not see removed
// tools (falls back to always-deny when a name is unknown to the registry).

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { loadPermissions, evaluateCall } from 'dsh-cc-loader'

export const name = 'cc-permissions'

export const Config = z.object({
  enabled: z.boolean().default(true),
  // Bare-name deny → per-agent tool hiding (restrict). Pre-execute always
  // denies regardless; this only affects what the model sees.
  hideDeniedTools: z.boolean().default(true),
  // Map CC defaultMode: dontAsk → approval policy never (per session).
  enableDefaultMode: z.boolean().default(true),
  homeDir: z.string(),
  projectRootMarkers: z.array(z.string()).default(['.git']),
})

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const homeDir = config.homeDir ?? homedir()
  // Per-cwd cache of loaded permissions; invalidated when any settings file's
  // mtime changes, so edits take effect immediately (fresher than CC's
  // load-at-startup semantics).
  const cache = new Map()

  async function permissionsFor(cwd) {
    const hit = cache.get(cwd)
    if (hit !== undefined) {
      let changed = false
      for (const src of hit.sources) {
        try {
          const s = await stat(src.path)
          if (s.mtimeMs !== src.mtimeMs) { changed = true; break }
        } catch { changed = true; break }
      }
      if (!changed) return hit
      cache.delete(cwd)
    }
    const loaded = await loadPermissions({ cwd, homeDir, projectRootMarkers: config.projectRootMarkers })
    const sources = (loaded.permissions.sources ?? []).map((src) => ({ path: src.path, mtimeMs: 0 }))
    for (const src of sources) {
      try { src.mtimeMs = (await stat(src.path)).mtimeMs } catch { /* keep 0 → always reload */ }
    }
    const entry = { ...loaded, sources, at: Date.now() }
    cache.set(cwd, entry)
    return entry
  }

  // ── gate: tools/pre-execute ────────────────────────────────────────────────
  ctx.logger.info('cc-permissions: gate registered (reads .claude/settings.json allow/deny/ask)')
  ctx.on('tools/pre-execute', async (exec, next) => {
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()
    let loaded
    try { loaded = await permissionsFor(cwd) } catch (error) {
      ctx.logger.warn(`cc-permissions: load failed: ${String(error)}`)
      return next()
    }
    const perm = loaded.permissions
    if (perm === undefined || perm.status !== 'DIRECT') return next()
    const result = evaluateCall(perm.parsed, { tool: exec.name, args: exec.arguments }, {
      cwd: loaded.cwd,
      homeDir,
      projectRoot: loaded.projectRoot,
    })
    if (result.decision === 'deny') {
      ctx.logger.info(`cc-permissions: DENY ${exec.name} (cwd=${cwd}) — ${result.reason}`)
      return { kind: 'deny', reason: result.reason ?? 'Denied by a Claude Code permission rule.' }
    }
    if (result.decision === 'ask') {
      ctx.logger.info(`cc-permissions: ASK ${exec.name} (cwd=${cwd}) — ${result.reason}`)
      return { kind: 'ask', reason: result.reason ?? 'A Claude Code permission rule requests confirmation.' }
    }
    return next()
  })

  // ── bare-name deny → hide the tool from the model ─────────────────────────
  if (config.hideDeniedTools !== false) {
    ctx.on('agent/created', ({ agent }) => {
      const cwd = agent.session?.header?.cwd
      if (cwd === undefined) return
      void (async () => {
        try {
          const loaded = await permissionsFor(cwd)
          const perm = loaded.permissions
          if (perm === undefined || perm.status !== 'DIRECT') return
          const { names } = perm.removed
          if (names.length === 0) return
          const tools = agent.ctx.tools
          try {
            tools.restrict({ deny: names })
          } catch {
            // Some names may not be in the registry yet / never registered —
            // restrict per name so the known ones still hide.
            for (const name of names) {
              try { tools.restrict({ deny: [name] }) } catch { /* unknown tool: pre-execute still denies */ }
            }
          }
        } catch (error) {
          ctx.logger.warn(`cc-permissions: restrict failed: ${String(error)}`)
        }
      })()
    })
  }

  // ── defaultMode → approval policy / guidance ──────────────────────────────
  if (config.enableDefaultMode !== false) {
    ctx.on('agent/session-start', ({ agent }) => {
      const cwd = agent.session.header?.cwd
      if (cwd === undefined) return
      void (async () => {
        try {
          const loaded = await permissionsFor(cwd)
          const mode = loaded.permissions?.defaultMode
          if (mode === undefined) return
          const approval = ctx.get('approval')
          if (mode === 'dontAsk' && approval !== undefined) {
            approval.setPolicy(agent, 'never')
            ctx.logger.info(`cc-permissions: defaultMode=dontAsk → approval policy never for session`)
          } else if (mode === 'bypassPermissions') {
            ctx.logger.warn(`cc-permissions: defaultMode=bypassPermissions detected — DSH does NOT auto-map this to danger-full-access; enable it explicitly if intended`)
          } else if (mode !== 'default' && mode !== 'manual') {
            ctx.logger.info(`cc-permissions: defaultMode=${mode} noted (no direct DSH mapping; sandbox/approval presets govern)`)
          }
        } catch (error) {
          ctx.logger.warn(`cc-permissions: defaultMode handling failed: ${String(error)}`)
        }
      })()
    })
  }

  ctx.effect(() => () => cache.clear())
}
