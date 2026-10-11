// Per-component configuration scopes — Claude Code's actual discovery model.
//
// Claude Code has NO "project root". Each component walks on its own
// (module-0316.js:58420 `iQ`, :76362, :61346; module-0045.js:11331):
//
//   bounded ancestor   skills, commands, agents, output-styles, workflows
//                      cwd → home (EXCLUDED) or the git/worktree root
//                      (INCLUDED), whichever comes first; near → far.
//                      Outside a repository there is no git boundary, so the
//                      walk runs up to just below home — CC does the same.
//   full ancestor      .claude/rules/** (root-first) and .mcp.json
//                      (far → near, so the nearest file assigns last and wins)
//                      cwd → filesystem root, the root itself EXCLUDED
//   fixed location     settings.json / settings.local.json — <cwd>/.claude/,
//                      never an ancestor's
//   file scope         MCP user/local — ~/.claude.json top level, and
//                      projects[<key>] where the key is the git root
//                      (forward slashes), or the PARENT of cwd outside a repo
//
// Pure reads, no writes. The inconsistencies above are CC's own; they are
// copied rather than unified, because the inconsistency is the semantics.

import { readFile, stat } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { homedir } from 'node:os'

export async function pathExists(path) {
  try { await stat(path); return true } catch { return false }
}

export async function readTextSafe(path) {
  try { return await readFile(path, { encoding: 'utf8' }) } catch { return undefined }
}

/** CC normalizes paths it compares with NFC (module-0316.js:58422). */
const nfc = (p) => p.normalize('NFC')

/** Forward-slash form used for `~/.claude.json` project keys. */
export function posixPath(p) {
  return nfc(resolve(p)).replace(/\\/g, '/')
}

/**
 * Nearest ancestor of `cwd` carrying `.git` — a directory for a repository, a
 * file for a worktree or submodule. `undefined` outside any repository.
 * CC's `Gn`; the walk starts at cwd itself, so a repo root is its own root.
 */
export async function findGitRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Bounded-ancestor walk — skills, commands, agents. Near → far.
 *
 * CC's `iQ`: test home first (break before pushing, so home is excluded), push
 * the directory, then test the git root (push before breaking, so the git root
 * is included).
 *
 * @param {string} cwd
 * @param {{ homeDir?: string, gitRoot?: string }} [opts] - `gitRoot` overrides
 *   the search (callers that already resolved it avoid a second walk).
 * @returns {Promise<string[]>} directories, cwd first, git root last.
 */
export async function boundedAncestors(cwd, opts = {}) {
  const home = opts.homeDir === undefined ? undefined : nfc(resolve(opts.homeDir))
  const gitRoot = opts.gitRoot !== undefined ? opts.gitRoot : await findGitRoot(cwd)
  const git = gitRoot === undefined ? undefined : nfc(gitRoot)
  const out = []
  let current = resolve(cwd)
  for (;;) {
    if (home !== undefined && nfc(current) === home) break
    out.push(current)
    if (git !== undefined && nfc(current) === git) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

/**
 * Full-ancestor walk — `.claude/rules/**`, `.mcp.json`. Near → far, the
 * filesystem root itself excluded (CC: `while (w !== parse(w).root)`).
 * Callers wanting CC's root-first reading order reverse it.
 */
export function fullAncestors(cwd) {
  const out = []
  let current = resolve(cwd)
  for (;;) {
    if (current === parse(current).root) break
    out.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

/**
 * `~/.claude.json` project key for a session directory. CC's `DJe`: the git
 * root with forward slashes, or — outside a repository — the PARENT of cwd.
 */
export function claudeJsonProjectKey(cwd, gitRoot) {
  return gitRoot === undefined ? posixPath(dirname(resolve(cwd))) : posixPath(gitRoot)
}

/** `.mcp.json` shape: a plain object of server configs, or undefined. */
function serversObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value
}

/**
 * The two file scopes of MCP config that live inside `~/.claude.json`:
 *   user  — top-level `mcpServers`
 *   local — `projects[<key>].mcpServers`
 * The file also holds unrelated per-project state, so this reads only those two
 * keys. A missing file is not an error; an unreadable one is.
 *
 * @param {string} cwd
 * @param {{ homeDir?: string, gitRoot?: string, claudeJsonPath?: string }} [opts]
 * @returns {Promise<{ path: string, key: string, user?: object, local?: object,
 *   present: boolean, error?: string }>}
 */
export async function readClaudeJsonScopes(cwd, opts = {}) {
  const homeDir = opts.homeDir ?? homedir()
  const path = opts.claudeJsonPath ?? join(homeDir, '.claude.json')
  const gitRoot = opts.gitRoot !== undefined ? opts.gitRoot : await findGitRoot(cwd)
  const key = claudeJsonProjectKey(cwd, gitRoot)
  const out = { path, key, present: false }
  const raw = await readTextSafe(path)
  if (raw === undefined) return out
  out.present = true
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    out.error = `invalid JSON: ${String(error.message ?? error)}`
    return out
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    out.error = 'config root must be a JSON object'
    return out
  }
  out.user = serversObject(data.mcpServers)
  const project = data.projects
  if (typeof project === 'object' && project !== null && !Array.isArray(project)) {
    out.local = serversObject(project[key]?.mcpServers)
  }
  return out
}

/**
 * Fixed locations of the settings files. CC resolves project/local settings
 * against the session cwd (`module-0045.js:11331` → `<cwd>/.claude/…`), NOT
 * against an ancestor — running from a subdirectory does not pick up the
 * repository root's settings. Managed/policy settings live outside the user
 * and project directories and are not read here.
 *
 * @returns {{ user: string, project: string, local: string }}
 */
export function settingsPaths(cwd, opts = {}) {
  const homeDir = opts.homeDir ?? homedir()
  const base = opts.globalClaudeDir ?? join(homeDir, '.claude')
  const claudeDir = join(resolve(cwd), '.claude')
  return {
    user: join(base, 'settings.json'),
    project: join(claudeDir, 'settings.json'),
    local: join(claudeDir, 'settings.local.json'),
  }
}
