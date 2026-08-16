// discover.js — find every hook config a session should honor.
//
// CC official hook locations (code.claude.com/docs/en/hooks.md#hook-locations):
//   user  `~/.claude/settings.json`            (per-user)
//   project `.claude/settings.json`            (per-project)
//   local  `.claude/settings.local.json`       (per-project, gitignored)
//   plugin `<pluginDir>/hooks/hooks.json`      (per-plugin)
// Hooks may ALSO live in a bare `<dir>/hooks/hooks.json` — a widely used
// community convention this ecosystem supports for compatibility (demo assets
// use it). All sources STACK (CC merges hooks across levels rather than
// replacing), so every file with hooks contributes to the merged config.
//
// Merge order (scope precedence, lowest wins ties only in the sense of CC
// precedence order user < project < local; hooks all run regardless):
//   user settings → user hooks.json → project settings → project local
//   settings → project hooks.json → plugin hooks.json (plugin last, CC scope
//   semantics).

import { join } from 'node:path'
import { homedir } from 'node:os'
import { findProjectRoot, pathExists, readTextSafe } from 'dsh-cc-loader'

/**
 * @typedef {object} HookSource
 * @property {'user'|'project'|'local'|'plugin'} scope
 * @property {string} path
 * @property {string} [pluginRoot] - plugin dir (plugin scope only); the value
 *   substituted for ${CLAUDE_PLUGIN_ROOT} in that file's commands.
 * @property {unknown} [data] - parsed JSON (present when the file read+parsed).
 * @property {string} [error] - reason the source is unusable (invalid JSON …).
 */

/**
 * Discover hook config sources for a session cwd.
 * @param {string} cwd - session workspace.
 * @param {object} [opts]
 * @param {string} [opts.homeDir] - default os.homedir().
 * @param {string[]} [opts.projectRootMarkers] - default ['.git'].
 * @param {string[]} [opts.pluginDirs] - plugin roots scanned for
 *   `<dir>/hooks/hooks.json` (default []).
 * @param {boolean} [opts.enableGlobal] - include the user-level sources
 *   (`~/.claude/settings.json` hooks + `~/.claude/hooks/hooks.json`).
 * @param {string} [opts.globalClaudeDir] - override the user `~/.claude` dir.
 * @returns {Promise<{ projectRoot?: string, sources: HookSource[] }>}
 */
export async function discoverHookFiles(cwd, opts = {}) {
  const homeDir = opts.homeDir ?? homedir()
  const globalDir = opts.globalClaudeDir ?? join(homeDir, '.claude')
  const sources = []

  if (opts.enableGlobal !== false) {
    const userSettings = await readSource('user', join(globalDir, 'settings.json'), { requireHooksKey: true })
    if (userSettings !== undefined) sources.push(userSettings)
    const userHooks = await readSource('user', join(globalDir, 'hooks', 'hooks.json'))
    if (userHooks !== undefined) sources.push(userHooks)
  }

  const projectRoot = await findProjectRoot(cwd, opts.projectRootMarkers)
  if (projectRoot !== undefined) {
    const projectSettings = await readSource('project', join(projectRoot, '.claude', 'settings.json'), { requireHooksKey: true })
    if (projectSettings !== undefined) sources.push(projectSettings)
    const localSettings = await readSource('local', join(projectRoot, '.claude', 'settings.local.json'), { requireHooksKey: true })
    if (localSettings !== undefined) sources.push(localSettings)
    const projectHooks = await readSource('project', join(projectRoot, '.claude', 'hooks', 'hooks.json'))
    if (projectHooks !== undefined) sources.push(projectHooks)
  }

  for (const dir of opts.pluginDirs ?? []) {
    if (typeof dir !== 'string' || dir.length === 0) continue
    const src = await readSource('plugin', join(dir, 'hooks', 'hooks.json'))
    if (src !== undefined) {
      src.pluginRoot = dir
      sources.push(src)
    }
  }

  return { projectRoot, sources }
}

/**
 * Read + parse one hook config file. `requireHooksKey` selects only files whose
 * root object has a `hooks` key (settings files: `{ permissions, hooks }` …);
 * a settings file without hooks contributes nothing. Bare `hooks.json` event
 * maps always qualify (root itself is the hooks map).
 * @returns {HookSource|undefined} undefined when absent/not applicable.
 */
async function readSource(scope, path, opts = {}) {
  if (!(await pathExists(path))) return undefined
  const raw = await readTextSafe(path)
  if (raw === undefined) return undefined
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { scope, path, error: `invalid JSON: ${String(error)}` }
  }
  if (opts.requireHooksKey === true) {
    const isObject = typeof data === 'object' && data !== null && !Array.isArray(data)
    if (!isObject || data.hooks === undefined) return undefined
  }
  return { scope, path, data }
}
