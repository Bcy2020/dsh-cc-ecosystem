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
process.exit(failed > 0 ? 1 : 0)
