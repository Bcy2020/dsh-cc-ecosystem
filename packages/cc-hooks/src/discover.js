// discover.js — find every hooks.json a session should honor.
//
// Sources, in merge order (project → user → plugins; CC scope semantics):
//   1. project:  <projectRoot>/.claude/hooks/hooks.json
//   2. user:     ~/.claude/hooks/hooks.json (or globalClaudeDir override)
//   3. plugins:  <pluginDir>/hooks/hooks.json for each configured plugin dir
// Each plugin file carries its own pluginRoot so ${CLAUDE_PLUGIN_ROOT}
// substitution resolves to that plugin's directory.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { findProjectRoot, pathExists, readTextSafe } from 'dsh-cc-loader'

/**
 * @typedef {object} HookSource
 * @property {'project'|'user'|'plugin'} scope
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
 * @param {boolean} [opts.enableGlobal] - include the user-level source (default true).
 * @param {string} [opts.globalClaudeDir] - override the user `~/.claude` dir.
 * @returns {Promise<{ projectRoot?: string, sources: HookSource[] }>}
 */
export async function discoverHookFiles(cwd, opts = {}) {
  const homeDir = opts.homeDir ?? homedir()
  const globalDir = opts.globalClaudeDir ?? join(homeDir, '.claude')
  const sources = []

  const projectRoot = await findProjectRoot(cwd, opts.projectRootMarkers)
  if (projectRoot !== undefined) {
    const src = await readSource('project', join(projectRoot, '.claude', 'hooks', 'hooks.json'))
    if (src !== undefined) sources.push(src)
  }
  if (opts.enableGlobal !== false) {
    const src = await readSource('user', join(globalDir, 'hooks', 'hooks.json'))
    if (src !== undefined) sources.push(src)
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

/** Read + parse one hooks.json; undefined when absent; error entry when unreadable/unparseable. */
async function readSource(scope, path) {
  if (!(await pathExists(path))) return undefined
  const raw = await readTextSafe(path)
  if (raw === undefined) return undefined
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { scope, path, error: `invalid JSON: ${String(error)}` }
  }
  return { scope, path, data }
}
