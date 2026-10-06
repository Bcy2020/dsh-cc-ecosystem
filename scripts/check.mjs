// node scripts/check.mjs — syntax-check every package src file.
// Cross-platform: Windows npm runs scripts under cmd.exe which does NOT
// expand `*.js` globs, so node --check must receive explicit file paths.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

let failed = 0
let total = 0
for (const pkg of readdirSync('packages')) {
  const src = join('packages', pkg, 'src')
  let files
  try { files = readdirSync(src) } catch { continue }
  for (const name of files) {
    if (!name.endsWith('.js')) continue
    total += 1
    const file = join(src, name)
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
    if (result.status !== 0) failed += 1
  }
}
console.log(`syntax check: ${total - failed}/${total} files OK`)

// The README install snippets pin exact versions (pnpm 11 withholds a release
// younger than 24h, so a bare name installs an older one). A release that bumps
// the packages without refreshing them ships a command that installs the wrong
// version — and the 24h rule means nobody would notice for a day.
const snippets = spawnSync(process.execPath, [join('scripts', 'sync-readme-versions.mjs'), '--check'], { stdio: 'inherit' })
process.exit(failed > 0 || snippets.status !== 0 ? 1 : 0)
