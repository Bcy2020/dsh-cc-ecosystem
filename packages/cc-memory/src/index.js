// dsh-cc-memory — Claude Code's auto-memory in DSH.
//
// Discovery and storage mirror the CLI (see discovery.js). Two switches:
//
//   enabled  false → nothing is registered: no prompt section, no tools.
//   mode     'read-only'  → cc_memory_list / cc_memory_read only.
//            'read-write' → also cc_memory_write / cc_memory_edit.
//
// The Config fields are FIRST-RUN DEFAULTS. `/cc-memory` (client half) writes
// the same two switches to `$DSH_HOME/cc-memory-state.json`; from then on that
// file is authoritative, so a toggle survives a restart without a profile edit.
// Flipping a switch reconciles registrations in place — no restart.
//
// Every assembly re-reads MEMORY.md through `ctx.systemPrompt.section()`, so
// the index tracks disk without a restart (CC re-reads per request too).

import z from '@deepseek-ai/schemastery'
import { MAX_INDEX_CHARS, MAX_INDEX_LINES, MAX_MEMORY_BYTES, MAX_MEMORY_FILES } from './discovery.js'
import { MemoryRuntime } from './runtime.js'
import { registerPanelRoute } from './route.js'

export const name = 'cc-memory'
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  /** First-run default for the master switch. The panel persists later changes. */
  enabled: z.boolean().default(true),
  /** First-run default for the second switch. */
  mode: z.union(['read-only', 'read-write']).default('read-only'),
  /** Runtime state file; empty = `$DSH_HOME/cc-memory-state.json`. */
  statePath: z.string().default(''),
  /** Mount the `/cc-memory` panel route and command. */
  enablePanel: z.boolean().default(true),
  homeDir: z.string(),
  /** Claude Code's config root; defaults to `<homeDir>/.claude`. */
  globalClaudeDir: z.string(),
  /** Direct memory-directory override (absolute or `~/…`); bypasses slug discovery. */
  memoryDirectory: z.string(),
  // Budgets mirror CC's own; they are config so a deployment can tune them.
  maxIndexLines: z.number().step(1).min(1).default(MAX_INDEX_LINES),
  maxIndexChars: z.number().step(1).min(1).default(MAX_INDEX_CHARS),
  maxFiles: z.number().step(1).min(1).default(MAX_MEMORY_FILES),
  maxFileBytes: z.number().step(1).min(1).default(MAX_MEMORY_BYTES),
  /** Pinned memories injected before the index (CC's cap is 4). */
  maxPinned: z.number().step(1).min(0).default(4),
  /** CC keeps archive/ out of the index; this also keeps it out of listings. */
  includeArchive: z.boolean().default(false),
})

/**
 * Mount the plugin.
 * @param {object} ctx - cordis context (`systemPrompt`, `tools`, `logger`).
 * @param {object} [config] - validated {@link Config}.
 */
export function apply(ctx, config = {}) {
  try {
    const runtime = new MemoryRuntime(ctx, config)
    runtime.start()
    if (config.enablePanel !== false) registerPanelRoute(ctx, runtime)
    log(ctx, 'info', `mounted — memory ${runtime.enabled ? 'on' : 'off'}`
      + `${runtime.enabled ? ` (${runtime.mode})` : ''}, state from ${runtime.stateSource} (${runtime.statePath})`)
  } catch (error) {
    // apply() must never throw synchronously: a plugin failure would take down
    // the host's composition. Degrade to "no memory" and report.
    log(ctx, 'warn', `failed to mount: ${String(error?.stack ?? error)}`)
  }
}

function log(ctx, level, message) {
  try { ctx?.logger?.[level]?.(`cc-memory: ${message}`) } catch { /* logger absence is not fatal */ }
}
