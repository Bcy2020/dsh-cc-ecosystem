// Drift guard for the `dsh-cc-ecosystem` umbrella bundle.
//
// The umbrella mounts the five adapters by COPYING each adapter's own
// `cordis.patch.yml` row into its own patch. A copy is required — installing
// the umbrella alone never activates the siblings' patches, because `dsh plugin`
// reconciles `dsh.profile.bundles` against the PROFILE's direct dependencies
// and the adapters are transitive here. The cost of a copy is that the two
// copies evolve independently: change a config default in `cc-skills` and the
// umbrella keeps mounting the old one, silently, for every umbrella user.
//
// These tests make that drift a failure: every mounted row must be identical to
// the row the adapter mounts for itself, and every mounted package must be a
// declared dependency (so the patch's `name` rows are resolvable).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Anchor the YAML reader on the loader package so the test parses with the same
// `yaml` copy the loader ships with (the repo root has no node_modules).
const require = createRequire(new URL('../packages/cc-loader/src/index.js', import.meta.url))
const YAML = require('yaml')

const UMBRELLA = join(root, 'packages', 'cc-ecosystem')

/** The five adapter packages the umbrella mounts, with their directory names. */
const ADAPTERS = [
  { dir: 'cc-skills', pkg: 'dsh-cc-skills' },
  { dir: 'cc-permissions', pkg: 'dsh-cc-permissions' },
  { dir: 'cc-agents', pkg: 'dsh-cc-agents' },
  { dir: 'cc-hooks', pkg: 'dsh-cc-hooks' },
  { dir: 'cc-mcp', pkg: 'dsh-cc-mcp' },
]

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Every `insert` row a patch file contributes, flattened across its entries. */
function rows(patchPath) {
  const doc = YAML.parse(readFileSync(patchPath, 'utf8'))
  assert.ok(Array.isArray(doc), `${patchPath} must be a top-level YAML array`)
  return doc.flatMap((entry) => entry.insert ?? [])
}

const umbrellaManifest = readJson(join(UMBRELLA, 'package.json'))
const umbrellaRows = rows(join(UMBRELLA, 'cordis.patch.yml'))

test('umbrella declares dsh.bundle.patch and the file exists', () => {
  const patch = umbrellaManifest.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string')
  assert.notEqual(patch, '')
  readFileSync(join(UMBRELLA, patch), 'utf8')
})

test('umbrella mounts exactly the five adapters, each once', () => {
  assert.equal(umbrellaRows.length, ADAPTERS.length)
  const names = umbrellaRows.map((row) => row.name)
  assert.deepEqual([...names].sort(), ADAPTERS.map((a) => a.pkg).sort())
  const ids = umbrellaRows.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate row id in the umbrella patch')
})

test('every mounted row is identical to the adapter\'s own patch row', () => {
  for (const adapter of ADAPTERS) {
    const own = rows(join(root, 'packages', adapter.dir, 'cordis.patch.yml'))
    assert.equal(own.length, 1, `${adapter.dir} should mount one row of its own`)
    const mounted = umbrellaRows.find((row) => row.name === adapter.pkg)
    assert.ok(mounted, `umbrella does not mount ${adapter.pkg}`)
    assert.equal(mounted.id, own[0].id, `${adapter.pkg}: row id differs`)
    assert.deepEqual(mounted.config, own[0].config, `${adapter.pkg}: row config drifted from its own patch`)
  }
})

test('every mounted package is a declared dependency, plus the shared loader', () => {
  const deps = umbrellaManifest.dependencies ?? {}
  for (const adapter of ADAPTERS) {
    assert.ok(deps[adapter.pkg], `${adapter.pkg} is mounted but not a dependency — its row could not resolve`)
  }
  assert.ok(deps['dsh-cc-loader'], 'the umbrella must depend on dsh-cc-loader so the adapters can import it')
})

test('the umbrella has no peer expectations of its own', () => {
  // Compatibility of the mounted adapters is checked through the patch's
  // component manifests, so the umbrella itself must not add a second,
  // potentially conflicting, gate.
  assert.equal(umbrellaManifest.peerDependencies, undefined)
})
