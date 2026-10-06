// node scripts/sync-readme-versions.mjs [--check]
//
// Owns the pinned version numbers in the README install snippets.
//
// WHY THEY ARE PINNED: pnpm 11 enables `minimumReleaseAge` by default (1440
// minutes), so a version published less than a day ago is never selected — the
// resolver quietly stays on an older release and still exits 0. Installing by
// bare package name therefore lands on a stale version and reports success
// anyway. Only an exact version is stable.
//
// Pinning means every release must refresh these numbers. This script does it,
// so the snippets cannot drift from `packages/*/package.json`:
//
//   npm run sync:readme            rewrite every block in place
//   npm run sync:readme -- --check exit 1 if any block is stale (CI, via check.mjs)
//
// A block is the text between `<!-- versions:begin -->` and
// `<!-- versions:end -->`; its contents are replaced wholesale, so to change
// what a README installs, edit BLOCKS below — not the README.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** README → the packages its install snippet installs, in order. */
const BLOCKS = new Map([
  ['README.md', ['dsh-cc-ecosystem']],
  ['packages/cc-ecosystem/README.md', ['dsh-cc-ecosystem']],
  ['packages/cc-skills/README.md', ['dsh-cc-skills']],
  ['packages/cc-permissions/README.md', ['dsh-cc-permissions']],
  ['packages/cc-agents/README.md', ['dsh-cc-agents']],
  ['packages/cc-hooks/README.md', ['dsh-cc-loader', 'dsh-cc-hooks']],
])

const BEGIN = '<!-- versions:begin -->'
const END = '<!-- versions:end -->'

/** The published version of `name`, read from its own package.json. */
function versionOf(name) {
  const dir = name.replace(/^dsh-/, '')
  const path = join(ROOT, 'packages', dir, 'package.json')
  let manifest
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    throw new Error(`no readable packages/${dir}/package.json for "${name}": ${String(error)}`)
  }
  // A rename would otherwise pin the wrong number silently, which is exactly
  // the failure this script exists to prevent.
  if (manifest.name !== name) {
    throw new Error(`packages/${dir} is named "${manifest.name}", expected "${name}"`)
  }
  return manifest.version
}

function blockFor(packages) {
  const specs = packages.map((name) => `${name}@${versionOf(name)}`).join(' ')
  return `${BEGIN}\n\`\`\`sh\ndsh plugin --profile <name> add ${specs}\n\`\`\`\n${END}`
}

function replaceBlock(text, block, file) {
  const from = text.indexOf(BEGIN)
  if (from < 0) throw new Error(`${file}: no ${BEGIN}`)
  const to = text.indexOf(END)
  if (to < 0) throw new Error(`${file}: no ${END}`)
  if (to < from) throw new Error(`${file}: ${END} precedes ${BEGIN}`)
  if (text.indexOf(BEGIN, from + 1) >= 0) throw new Error(`${file}: more than one version block`)
  return text.slice(0, from) + block + text.slice(to + END.length)
}

const check = process.argv.includes('--check')
const stale = []
for (const [file, packages] of BLOCKS) {
  const path = join(ROOT, file)
  const current = readFileSync(path, 'utf8')
  const next = replaceBlock(current, blockFor(packages), file)
  if (next === current) continue
  stale.push(file)
  if (!check) writeFileSync(path, next)
}

if (!check) {
  console.log(stale.length === 0 ? 'version snippets: already in sync' : `version snippets: updated ${stale.join(', ')}`)
} else if (stale.length > 0) {
  console.error(`version snippets: ${stale.length} out of date — ${stale.join(', ')}`)
  console.error('run: npm run sync:readme')
  process.exit(1)
} else {
  console.log(`version snippets: ${BLOCKS.size}/${BLOCKS.size} in sync`)
}
