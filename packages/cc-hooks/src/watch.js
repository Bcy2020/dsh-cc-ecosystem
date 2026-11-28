// watch.js — per-session filesystem watchers for the two disk-driven hook
// events.
//
// Claude Code runs two independent detectors (module-0316.js:92072-92220 and
// the skill detector in module-0571.js):
//
//   ConfigChange — settings files and the .claude/{skills,commands,agents,hooks}
//                  directories. The event's matcher subject is the SOURCE
//                  (user_settings / project_settings / local_settings / skills).
//   FileChanged  — files named literally in a FileChanged hook's matcher
//                  (`a|b` separated, resolved against the session cwd) plus
//                  absolute `watchPaths` returned by SessionStart / CwdChanged /
//                  FileChanged hooks. The event fires with the changed file's
//                  ABSOLUTE path and event change|add|unlink (CC has no
//                  `rename`).
//
// Both use chokidar with awaitWriteFinish {500, 200}, exactly like CC. The
// actual chokidar instance is injected (`createWatcher`) so tests can drive a
// fake emitter; the default lazily imports chokidar.
//
// This module is pure plumbing: it turns file events into
//   onConfigChange(source, absolutePath)
//   onFileChanged(absolutePath, event)
//   onHooksConfigChange(absolutePath)
// and never runs hooks itself.

import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { settingsPaths } from 'dsh-cc-loader'

// chokidar ships a CJS entry, so the require path keeps the factory synchronous
// (the watcher object is needed immediately). The dependency is still loaded
// lazily: a process that never starts a watcher never reads it.
const require = createRequire(import.meta.url)

/**
 * CC's watcher options (module-0316.js:92149), except `persistent`: CC is a CLI
 * that must stay alive for its watcher, while DSH is a long-running host. A
 * non-persistent handle still watches; it only stops holding the event loop
 * open, so unit tests and a host shutting down are never pinned by it.
 */
export const WATCH_OPTIONS = Object.freeze({
  persistent: false,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
  ignorePermissionErrors: true,
})

/** The four per-scope component directories CC treats as `source: "skills"`. */
const SKILL_DIRS = ['skills', 'commands', 'agents', 'hooks']

/** The ecosystem's bare hook config files: internal cache refresh, no hook event. */
function hooksConfigPaths(cwd, opts) {
  const base = opts.globalClaudeDir ?? join(opts.homeDir ?? homedir(), '.claude')
  return [
    join(resolve(cwd), '.claude', 'hooks', 'hooks.json'),
    join(base, 'hooks', 'hooks.json'),
  ]
}

/**
 * Everything whose change is a CC `ConfigChange`: three settings files plus the
 * per-scope component directories (`source: "skills"`).
 * @returns {{path: string, source: string}[]}
 */
export function configWatchEntries(cwd, opts = {}) {
  const paths = settingsPaths(cwd, opts)
  const base = opts.globalClaudeDir ?? join(opts.homeDir ?? homedir(), '.claude')
  const entries = [
    { path: resolve(paths.user), source: 'user_settings' },
    { path: resolve(paths.project), source: 'project_settings' },
    { path: resolve(paths.local), source: 'local_settings' },
  ]
  for (const dir of SKILL_DIRS) {
    entries.push({ path: join(resolve(cwd), '.claude', dir), source: 'skills' })
    entries.push({ path: join(resolve(base), dir), source: 'skills' })
  }
  return entries
}

/**
 * The literal filenames a `FileChanged` hook asks to watch. CC splits the
 * matcher on `|` regardless of its regex/literal dispatch form
 * (module-0316.js:92132-92142) and resolves relative names against the cwd.
 * @returns {{path: string}[]}
 */
export function fileWatchEntries(cwd, config) {
  const entries = []
  for (const group of config?.FileChanged ?? []) {
    if (typeof group?.matcher !== 'string') continue
    for (const token of group.matcher.split('|')) {
      const name = token.trim()
      if (name === '') continue
      entries.push({ path: isAbsolute(name) ? name : resolve(cwd, name) })
    }
  }
  return entries
}

/**
 * Normalize absolute `watchPaths` returned by a hook. Relative entries are
 * resolved against the session cwd (CC declares them absolute; being lenient
 * costs nothing).
 * @returns {{path: string}[]}
 */
export function normalizeWatchPaths(list, cwd) {
  const out = []
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== 'string' || value.trim() === '') continue
    out.push({ path: isAbsolute(value) ? resolve(value) : resolve(cwd, value) })
  }
  return out
}

/** Exact path, or a child of that path (case-insensitive on Windows). */
const CASE_INSENSITIVE = process.platform === 'win32'
function fold(path) {
  return CASE_INSENSITIVE ? path.toLowerCase() : path
}
function covers(entryPath, eventPath) {
  const entry = fold(entryPath)
  const event = fold(eventPath)
  return event === entry || event.startsWith(entry + sep)
}
function samePath(a, b) {
  return fold(a) === fold(b)
}

/** Deduplicate by path; later entries win (a source never changes per path). */
function dedupe(entries) {
  const seen = new Map()
  for (const entry of entries) seen.set(entry.path, entry)
  return [...seen.values()]
}

/**
 * One session's watcher. Call `setConfigEntries` / `setFileEntries` with the
 * complete desired sets; each call rebuilds the underlying watcher (rare: once
 * at session start and on cwd changes / hook-returned watchPaths).
 */
export function createSessionWatcher({
  cwd,
  homeDir,
  globalClaudeDir,
  onConfigChange,
  onFileChanged,
  onHooksConfigChange,
  onError,
  createWatcher = defaultCreateWatcher,
}) {
  let configEntries = []
  let fileEntries = []
  let internalPaths = new Set(hooksConfigPaths(cwd, { homeDir, globalClaudeDir }))
  let watcher
  let closed = false
  let watchedKey = ''

  function currentPaths() {
    return [...new Set([
      ...configEntries.map((entry) => entry.path),
      ...fileEntries.map((entry) => entry.path),
      ...internalPaths,
    ])]
  }

  function rebuild(force = false) {
    if (closed) return
    const paths = [...new Set(currentPaths())]
    const key = paths.slice().sort().join('\n')
    if (!force && key === watchedKey) return
    watchedKey = key
    if (watcher !== undefined) {
      const previous = watcher
      watcher = undefined
      void previous.close().catch(() => {})
    }
    if (paths.length === 0) return
    watcher = createWatcher(paths, WATCH_OPTIONS)
    watcher.on('change', (path) => dispatch(path, 'change'))
    watcher.on('add', (path) => dispatch(path, 'add'))
    watcher.on('unlink', (path) => dispatch(path, 'unlink'))
    watcher.on('error', (error) => { onError?.(error) })
  }

  function dispatch(rawPath, event) {
    if (closed || typeof rawPath !== 'string' || rawPath === '') return
    const path = resolve(rawPath)
    if ([...internalPaths].some((known) => samePath(known, path))) {
      onHooksConfigChange?.(path)
      return
    }
    const sources = new Set()
    for (const entry of configEntries) {
      if (covers(entry.path, path)) sources.add(entry.source)
    }
    for (const source of sources) onConfigChange?.(source, path)
    for (const entry of fileEntries) {
      if (covers(entry.path, path)) {
        onFileChanged?.(path, event)
        return
      }
    }
  }

  return {
    /** Replace the ConfigChange watch set (settings files + component dirs). */
    setConfigEntries(entries) {
      configEntries = dedupe(entries)
      rebuild()
    },
    /** Replace the FileChanged watch set (matcher filenames + hook watchPaths). */
    setFileEntries(entries) {
      fileEntries = dedupe(entries)
      rebuild()
    },
    /** Rebuild after the session cwd changes. */
    setCwd(nextCwd, opts = {}) {
      cwd = nextCwd
      internalPaths = new Set(hooksConfigPaths(cwd, { homeDir, globalClaudeDir }))
      if (opts.configEntries !== undefined) configEntries = dedupe(opts.configEntries)
      if (opts.fileEntries !== undefined) fileEntries = dedupe(opts.fileEntries)
      rebuild(true)
    },
    close() {
      if (closed) return Promise.resolve()
      closed = true
      const previous = watcher
      watcher = undefined
      return previous === undefined ? Promise.resolve() : Promise.resolve(previous.close()).catch(() => {})
    },
    get watchedPaths() {
      return currentPaths()
    },
  }
}

/**
 * Default watcher factory: chokidar v4. Loaded on first use so process startup
 * without a watcher never pays for it.
 */
export function defaultCreateWatcher(paths, options) {
  const { watch } = require('chokidar')
  return watch(paths, options)
}
