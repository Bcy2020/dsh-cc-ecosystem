// link-local.mjs — point every dependent package's `dsh-cc-loader` at THIS
// working tree instead of the npm-published copy.
//
// WHY
// ---
// The monorepo deliberately has no workspace management: each package declares
// `dsh-cc-loader: ^0.1.0` and installs it from the registry, because that is
// exactly what a consumer (and the DSH profile) resolves. The cost is that a
// change to `packages/cc-loader/src` is invisible to the packages that import
// it — their tests keep running against the last PUBLISHED loader. That blind
// spot is how the 0.1.5 breakage reached a live profile: the adapters were
// edited against assumptions the installed loader did not satisfy, and the
// only way to observe a cross-package change was to publish or to hand-patch
// the installed copy.
//
// This script closes that hole for local runs and CI: after the normal
// per-package `npm install`, it replaces each dependent's
// `node_modules/dsh-cc-loader` with a link to `packages/cc-loader`. The
// published `package.json` keeps the real semver range; only the installed
// tree is redirected, so nothing about the release changes.
//
// Run: `npm run link` (idempotent). CI runs it after installing dependencies.
// A plain `cd packages/<pkg> && npm install` reverts the link to the registry
// copy — rerun `npm run link` afterwards.

import { existsSync, mkdirSync, lstatSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const loaderDir = join(root, 'packages', 'cc-loader')

/** Packages that depend on dsh-cc-loader. */
const DEPENDENTS = ['cc-skills', 'cc-permissions', 'cc-agents', 'cc-hooks', 'cc-mcp']

if (!existsSync(join(loaderDir, 'package.json'))) {
  console.error(`link-local: no packages/cc-loader at ${loaderDir}`)
  process.exit(1)
}

/** Remove whatever currently occupies `path` (link or directory) without following it. */
function clear(path) {
  let stat
  try { stat = lstatSync(path) } catch { return }
  if (stat.isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { recursive: true, force: true })
}

let linked = 0
for (const pkg of DEPENDENTS) {
  const modulesDir = join(root, 'packages', pkg, 'node_modules')
  if (!existsSync(modulesDir)) {
    // Dependencies were never installed for this package; nothing to redirect.
    console.log(`skip  ${pkg} (no node_modules — run npm install first)`)
    continue
  }
  const target = join(modulesDir, 'dsh-cc-loader')
  clear(target)
  mkdirSync(dirname(target), { recursive: true })
  // A junction needs an absolute target and works on Windows without
  // elevation; 'dir' is the portable choice elsewhere.
  symlinkSync(loaderDir, target, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`link  packages/${pkg}/node_modules/dsh-cc-loader -> packages/cc-loader`)
  linked += 1
}

console.log(linked === 0
  ? 'link-local: nothing linked (install dependencies first)'
  : `link-local: ${linked} package(s) now use the working-tree dsh-cc-loader`)
