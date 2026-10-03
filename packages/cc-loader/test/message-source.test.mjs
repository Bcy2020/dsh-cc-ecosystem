// Regression tests for the injected-message source boundary.
//
// DSH's session format v4 validates the `source` of EVERY durable message slot
// before adopting the event. The gate's whole rule is reproduced verbatim below
// from the host (`lib/types/message-sources.js`), under the policy line that
// heads it: "Native source admission preserves unknown attribution and refuses
// retired plugin wrappers."
//
// cc-hooks and cc-agents shipped the retired V3 wrapper — `{ kind: 'plugin',
// plugin: 'cc-hooks' }` — so the first time either injected anything
// (SessionStart context, hook-injected context, the catalog reminder, a
// prompt/agent hook result) the turn died with
// "format v4 message requires a producer-owned source kind". Nothing in the
// suite noticed, because no test asserted on the injected source's shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { injectedSource } from '../src/message-source.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The host's own admission check, transcribed from DSH. Throws what the host
 * throws; returns nothing when the source is admitted.
 */
function hostAdmits(value) {
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isObject(value)
    || typeof value.kind !== 'string'
    || value.kind.length === 0
    || value.kind === 'plugin') {
    throw new Error('format v4 message requires a producer-owned source kind')
  }
}

// ─── what we build is admitted ──────────────────────────────────────────────

test('injectedSource produces a source the host admits', () => {
  for (const kind of ['cc-hooks', 'cc-agents', 'cc-skills', 'cc-mcp']) {
    assert.doesNotThrow(() => hostAdmits(injectedSource(kind)), kind)
  }
})

test('the built source names the producer and carries nothing else', () => {
  assert.deepEqual(injectedSource('cc-hooks'), { kind: 'cc-hooks' })
})

// ─── the premise: the retired V3 wrapper is what broke ──────────────────────

test('premise: the retired V3 wrapper is refused by the host', () => {
  assert.throws(
    () => hostAdmits({ kind: 'plugin', plugin: 'cc-hooks' }),
    /producer-owned source kind/,
  )
})

test('every rejection shape the host refuses is refused here too', () => {
  for (const bad of [
    undefined, null, 'cc-hooks', 42, [], {},
    { kind: '' }, { kind: 1 }, { kind: 'plugin' }, { kind: 'plugin', plugin: 'x' },
  ]) {
    assert.throws(() => hostAdmits(bad), /producer-owned source kind/, JSON.stringify(bad))
  }
})

test('unknown attribution is PRESERVED — extra fields are not a rejection', () => {
  // cc-skills stamps `form: 'rules'`; the host keeps unknown fields verbatim.
  assert.doesNotThrow(() => hostAdmits({ kind: 'cc-skills', form: 'rules' }))
})

// ─── the drift guard: no package may reintroduce the V3 wrapper ─────────────

test('no package source injects `kind: \'plugin\'`', () => {
  const offenders = []
  const packagesDir = join(REPO, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src')
    let files
    try { files = readdirSync(srcDir) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.js')) continue
      const text = readFileSync(join(srcDir, file), 'utf8')
      for (const line of text.split('\n')) {
        // The shape itself, not prose that mentions it in a comment.
        const trimmed = line.trimStart()
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
        if (/kind:\s*['"]plugin['"]/.test(line)) {
          offenders.push(`${pkg}/src/${file}: ${line.trim()}`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'the retired V3 plugin wrapper fails the whole turn')
})
