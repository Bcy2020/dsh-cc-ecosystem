// One-shot validation of the real cc-demo-project against dsh-cc-loader.
import { loadClaude, evaluateCall } from '../packages/cc-loader/src/index.js'

const PROJECT = 'C:/Users/Lenovo/Desktop/teno/cc-demo-project'
const HOME = 'C:/Users/Lenovo'

const ir = await loadClaude({ cwd: PROJECT, homeDir: HOME })
console.log('== report ==')
console.log(JSON.stringify(ir.report, null, 1))
console.log('== skills ==')
for (const s of ir.components.skills) console.log(`  ${s.name} (source=${s.source}, rank=${s.rank}, status=${s.status})`)
console.log('== rules ==')
console.log('  ' + ir.components.rules.map((r) => r.name).join(', '))
const p = ir.components.permissions
console.log(`== permissions == status=${p.status} defaultMode=${p.defaultMode} deny=${p.parsed.deny.length} ask=${p.parsed.ask.length} allow=${p.parsed.allow.length} invalid=${p.parsed.invalid.length}`)

const env = { cwd: PROJECT, homeDir: HOME, projectRoot: PROJECT }
const cases = [
  ['bash: rm -rf sample/', { tool: 'bash', args: { command: 'rm -rf sample/' } }],
  ['bash: git status', { tool: 'bash', args: { command: 'git status' } }],
  ['bash: git push origin main', { tool: 'bash', args: { command: 'git push origin main' } }],
  ['bash: npm run build', { tool: 'bash', args: { command: 'npm run build' } }],
  ['bash: curl http://x', { tool: 'bash', args: { command: 'curl http://example.com' } }],
  ['web_fetch: developer.mozilla.org', { tool: 'web_fetch', args: { url: 'https://developer.mozilla.org/en-US/docs/Web' } }],
  ['web_fetch: spam-site.com', { tool: 'web_fetch', args: { url: 'https://sub.spam-site.com/x' } }],
  ['read: C:/Users/Lenovo/.ssh/id_rsa', { tool: 'read', args: { path: 'C:/Users/Lenovo/.ssh/id_rsa' } }],
  ['read: sample/index.html', { tool: 'read', args: { path: 'sample/index.html' } }],
]
console.log('== evaluation ==')
for (const [label, call] of cases) {
  const r = evaluateCall(p.parsed, call, env)
  console.log(`  ${label.padEnd(40)} -> ${r.decision}${r.reason ? ' — ' + r.reason : ''}`)
}
