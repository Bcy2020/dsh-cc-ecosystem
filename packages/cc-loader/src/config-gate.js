// config-gate.js — one process-wide switch shared by the hook runner and every
// adapter that caches `.claude` configuration.
//
// Claude Code's ConfigChange hooks can block a configuration change: the change
// is seen on disk but must not reach the running session. In DSH the watchers
// live in dsh-cc-hooks (it owns hook execution), while the caches live in the
// other adapters (permissions, skills, agents). This module is the hand-off:
//
//   - the watcher owner calls activateConfigGate(cwd) when it starts watching a
//     session's cwd and deactivateConfigGate(cwd) when that session ends;
//   - an adapter asks isConfigGateActive(cwd) before trusting its cache. While
//     the gate is active the adapter serves its last warmed snapshot and does
//     NOT reload from disk: only the warmer below reads the files;
//   - after a change is ALLOWED, the watcher owner bumps the generation once
//     and immediately calls warmConfigGate(cwd), while the files still hold the
//     allowed content. A blocked or still-undecided change never warms, so
//     every adapter keeps serving its pre-change snapshot.
//
// While the gate is inactive (cc-hooks not installed, or a session without a
// watcher) adapters keep their previous behavior — there is no hook that could
// have blocked the change.
//
// State hangs off globalThis under a Symbol: each dsh-cc-* package may resolve
// its own copy of dsh-cc-loader, and the gate must still be one object.

import { resolve } from 'node:path'

const GATE_STATE = Symbol.for('dsh-cc-config-gate')

function state() {
  let found = globalThis[GATE_STATE]
  if (found === undefined) {
    found = { cwds: new Map(), warmers: new Set() }
    globalThis[GATE_STATE] = found
  }
  found.warmers ??= new Set()
  return found
}

function entryFor(cwd) {
  const key = resolve(cwd)
  const map = state().cwds
  let entry = map.get(key)
  if (entry === undefined) {
    entry = { active: 0, generation: 0 }
    map.set(key, entry)
  }
  return entry
}

/** Record one watcher on this cwd. Pair every call with deactivateConfigGate. */
export function activateConfigGate(cwd) {
  entryFor(cwd).active += 1
}

/** Release one watcher on this cwd. */
export function deactivateConfigGate(cwd) {
  const entry = entryFor(cwd)
  if (entry.active > 0) entry.active -= 1
}

/** Whether any watcher currently owns this cwd (i.e. a ConfigChange hook can block). */
export function isConfigGateActive(cwd) {
  return entryFor(cwd).active > 0
}

/** The current allowed-change generation for this cwd. */
export function configGeneration(cwd) {
  return entryFor(cwd).generation
}

/**
 * Mark one change as allowed. Adapters do NOT reload on their own; the watcher
 * owner calls warmConfigGate right after this, while the files still hold the
 * allowed content. A read that happens while the gate is active therefore
 * serves the last warmed snapshot and never consults the disk — which is what
 * keeps a later blocked write from being read back.
 */
export function bumpConfigGeneration(cwd) {
  const entry = entryFor(cwd)
  entry.generation += 1
  return entry.generation
}

/**
 * Register a cache warmer. The watcher owner calls warmConfigGate(cwd) when it
 * starts watching a session; every adapter that caches config loads its
 * snapshot then, BEFORE any change can be blocked. Without this, a lazy cache
 * built after a blocked change would read the new files from disk and the
 * block would be lost.
 *
 * @param {(cwd: string) => unknown} warmer
 * @returns {() => void} unregister
 */
export function registerConfigWarmer(warmer) {
  const warmers = state().warmers
  warmers.add(warmer)
  return () => { warmers.delete(warmer) }
}

/** Preload every registered adapter's cache for this cwd. Never throws. */
export async function warmConfigGate(cwd) {
  const warmers = [...state().warmers]
  await Promise.allSettled(warmers.map(async (warmer) => warmer(cwd)))
}
