// merge.js — stack multiple parsed hook configs into one event map.
//
// CC semantics: hook configs across scopes are ADDITIVE, not overriding — every
// matched hook runs, and @deepseek-ai/dsh-hook-protocol folds their outcomes
// with the most-restrictive precedence (deny > ask > allow). So the faithful
// merge is a per-event concatenation of matcher groups in source order
// (project → user → plugins); group order only affects additionalContext
// accumulation order and stopReason selection.

/**
 * Merge parsed configs into one `event → matcher-groups` map.
 * @param {Array<{ config: Record<string, Array<{ matcher?: string, hooks: Array<{ command: string, timeoutSec?: number }> }>> }>} parsedList
 *   in source order (project → user → plugins).
 * @returns {Record<string, Array<{ matcher?: string, hooks: Array<{ command: string, timeoutSec?: number }> }>>}
 *   one entry per event that has any surviving hook; empty object when nothing parsed.
 */
export function mergeHookConfigs(parsedList) {
  const config = {}
  for (const item of parsedList) {
    if (!item || !item.config) continue
    for (const [event, groups] of Object.entries(item.config)) {
      if (!Array.isArray(groups) || groups.length === 0) continue
      if (config[event] === undefined) config[event] = []
      config[event].push(...groups)
    }
  }
  return config
}
