// Persisted runtime switches for dsh-cc-memory.
//
// The two Config fields (`enabled`, `mode`) are DEFAULTS for the first run.
// Once `/cc-memory` flips a switch, the state file is authoritative so the
// choice survives a DSH restart without editing the profile.
//
// Location follows cc-mcp: `$DSH_HOME/cc-memory-state.json`, falling back to
// `~/.dsh/cc-memory-state.json`. A missing file is normal; an unreadable or
// malformed one is reported by the caller and ignored (defaults win), never
// thrown into plugin loading.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Shape version of the persisted file. */
export const STATE_VERSION = 1

/** Effective access modes. */
export const MODES = ['read-only', 'read-write']

/**
 * Default state-file location.
 * @returns {string} absolute path
 */
export function defaultStatePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'cc-memory-state.json')
}

/**
 * Load the persisted switches, falling back to the supplied defaults.
 * @param {string} path
 * @param {{ enabled: boolean, mode: 'read-only' | 'read-write' }} defaults
 * @returns {{ enabled: boolean, mode: string, source: 'file' | 'defaults', error?: string, path: string }}
 */
export function loadState(path, defaults) {
  const target = resolve(path)
  let raw
  try {
    raw = readFileSync(target, { encoding: 'utf8' })
  } catch {
    return { ...defaults, source: 'defaults', path: target }
  }
  try {
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ...defaults, source: 'defaults', error: 'state root must be an object', path: target }
    }
    if (data.version !== STATE_VERSION) {
      return { ...defaults, source: 'defaults', error: `unsupported state version ${JSON.stringify(data.version)}`, path: target }
    }
    if (typeof data.enabled !== 'boolean') {
      return { ...defaults, source: 'defaults', error: 'enabled must be a boolean', path: target }
    }
    if (!MODES.includes(data.mode)) {
      return { ...defaults, source: 'defaults', error: `mode must be one of ${MODES.join(', ')}`, path: target }
    }
    return { enabled: data.enabled, mode: data.mode, source: 'file', path: target }
  } catch (error) {
    return { ...defaults, source: 'defaults', error: `invalid JSON: ${String(error?.message ?? error)}`, path: target }
  }
}

/**
 * Atomically persist the switches.
 * @param {string} path
 * @param {{ enabled: boolean, mode: string }} state
 */
export function saveState(path, state) {
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  const text = `${JSON.stringify({
    version: STATE_VERSION,
    enabled: state.enabled,
    mode: state.mode,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, text, { encoding: 'utf8' })
    renameSync(temporary, target)
  } finally {
    try { unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
}
