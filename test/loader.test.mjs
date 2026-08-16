// Unit tests for dsh-cc-loader: rule parsing, pattern compilation, evaluation,
// and full IR loading from a temp .claude tree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRule } from '../packages/cc-loader/src/parse-rule.js'
import { compileCommandPattern, compilePathPattern, compileDomainPattern, winPathToPosix } from '../packages/cc-loader/src/patterns.js'
import { parseRulesFor, evaluateCall, splitSubcommands, removedToolNames } from '../packages/cc-loader/src/classify.js'
import { loadClaude } from '../packages/cc-loader/src/load.js'

// ─── parse-rule ──────────────────────────────────────────────────────────────

test('parseRule: bare tool', () => {
  const r = parseRule('Bash')
  assert.equal(r.kind, 'bare')
  assert.equal(r.tool, 'Bash')
})

test('parseRule: Bash(*) is bare', () => {
  assert.equal(parseRule('Bash(*)').kind, 'bare')
  assert.equal(parseRule('Bash(:*)').kind, 'bare')
})

test('parseRule: command glob', () => {
  const r = parseRule('Bash(npm run *)')
  assert.equal(r.kind, 'command')
  assert.match('npm run build', r.command)
  assert.doesNotMatch('npm install', r.command)
})

test('parseRule: :* suffix ≡ trailing space-star', () => {
  const r = parseRule('Bash(ls:*)')
  assert.match('ls -la', r.command)
  assert.doesNotMatch('lsof', r.command) // word boundary: `ls ` required
})

test('parseRule: trailing " *" enforces word boundary', () => {
  const space = parseRule('Bash(ls *)')
  assert.match('ls -la', space.command)
  assert.doesNotMatch('lsof', space.command)
  const noSpace = parseRule('Bash(ls*)')
  assert.match('lsof', noSpace.command)
})

test('parseRule: path rule', () => {
  const r = parseRule('Read(//etc/secrets/**)')
  assert.equal(r.kind, 'path')
  assert.equal(r.pathPattern.kind, 'absolute')
})

test('parseRule: domain rule', () => {
  const r = parseRule('WebFetch(domain:*.example.com)')
  assert.equal(r.kind, 'domain')
})

test('parseRule: WebFetch without domain: is invalid', () => {
  const r = parseRule('WebFetch(example.com)')
  assert.equal(r.invalid, true)
})

test('parseRule: param rule', () => {
  const r = parseRule('Agent(model:opus)')
  assert.equal(r.kind, 'param')
  assert.equal(r.param, 'model')
  assert.equal(r.value, 'opus')
})

test('parseRule: primary-field param is invalid (CC ignores)', () => {
  const r = parseRule('Bash(command:rm *)')
  assert.equal(r.invalid, true)
})

test('parseRule: agent name', () => {
  const r = parseRule('Agent(Explore)')
  assert.equal(r.kind, 'agent-name')
  assert.equal(r.name, 'Explore')
})

test('parseRule: tool glob', () => {
  const r = parseRule('mcp__*')
  assert.equal(r.kind, 'tool-glob')
  assert.match('mcp__github__get_issue', r.glob)
  assert.doesNotMatch('bash', r.glob)
})

// ─── patterns ────────────────────────────────────────────────────────────────

test('command pattern: git * main', () => {
  const re = compileCommandPattern('git * main')
  assert.match('git checkout main', re)
  assert.match('git log --oneline main', re)
})

test('command pattern: * install', () => {
  const re = compileCommandPattern('* install')
  assert.match('npm install', re)
})

test('path pattern: // absolute', () => {
  const c = compilePathPattern('//etc/secrets/**')
  assert.equal(c.kind, 'absolute')
  assert.match('/etc/secrets/x', c.re)
  assert.doesNotMatch('/etc/other', c.re)
})

test('path pattern: single-segment src/** is depth-flexible', () => {
  const c = compilePathPattern('src/**')
  assert.equal(c.singleSegment, true)
  assert.match('src/app.ts', c.re)
  assert.match('src', c.re)
  assert.doesNotMatch('vendor/pkg/src/lib.js', c.re) // depth added by evaluator for deny/ask
})

test('domain pattern: *.example.com subdomains only', () => {
  const re = compileDomainPattern('*.example.com')
  assert.match('api.example.com', re)
  assert.match('a.b.example.com', re)
  assert.doesNotMatch('example.com', re)
})

test('domain pattern: middle * stays within a label', () => {
  const re = compileDomainPattern('example.*')
  assert.match('example.org', re)
  assert.doesNotMatch('example.evil.com', re)
})

test('winPathToPosix', () => {
  assert.equal(winPathToPosix('C:\\Users\\alice'), '/c/Users/alice')
  assert.equal(winPathToPosix('C:/Users/alice'), '/c/Users/alice')
})

// ─── splitSubcommands ────────────────────────────────────────────────────────

test('splitSubcommands: operators and quotes', () => {
  assert.deepEqual(splitSubcommands('git status && npm test'), ['git status', 'npm test'])
  assert.deepEqual(splitSubcommands('echo "a && b"'), ['echo "a && b"'])
  assert.deepEqual(splitSubcommands('a;b|c'), ['a', 'b', 'c'])
  assert.deepEqual(splitSubcommands('x & y'), ['x', 'y'])
})

// ─── evaluate ────────────────────────────────────────────────────────────────

function rules(perm) {
  return parseRulesFor({
    deny: (perm.deny ?? []).map((raw) => ({ raw })),
    ask: (perm.ask ?? []).map((raw) => ({ raw })),
    allow: (perm.allow ?? []).map((raw) => ({ raw })),
  })
}

function env(cwd = '/proj') {
  return { cwd, homeDir: '/home/u', projectRoot: '/proj' }
}

test('deny > ask > allow order', () => {
  const parsed = rules({ deny: ['Bash(rm *)'], ask: ['Bash(*)'], allow: ['Bash(rm -rf tmp *)'] })
  const r = evaluateCall(parsed, { tool: 'bash', args: { command: 'rm -rf tmp/x' } }, env())
  assert.equal(r.decision, 'deny')
})

test('ask wins over allow', () => {
  const parsed = rules({ ask: ['Bash(git push *)'], allow: ['Bash(git *)'] })
  const r = evaluateCall(parsed, { tool: 'bash', args: { command: 'git push origin main' } }, env())
  assert.equal(r.decision, 'ask')
})

test('allow matches when nothing denies/asks', () => {
  const parsed = rules({ allow: ['Bash(npm run *)'] })
  const r = evaluateCall(parsed, { tool: 'bash', args: { command: 'npm run build' } }, env())
  assert.equal(r.decision, 'allow')
  const n = evaluateCall(parsed, { tool: 'bash', args: { command: 'npm install' } }, env())
  assert.equal(n.decision, 'none')
})

test('bare deny removes tool', () => {
  const parsed = rules({ deny: ['WebFetch'] })
  const r = evaluateCall(parsed, { tool: 'web_fetch', args: { url: 'https://example.com' } }, env())
  assert.equal(r.decision, 'deny')
  assert.match(r.reason, /removed from context/)
  assert.deepEqual(removedToolNames(parsed), { names: ['WebFetch'], globs: [] })
})

test('bare deny maps DSH bash → CC Bash', () => {
  const parsed = rules({ deny: ['Bash'] })
  assert.equal(evaluateCall(parsed, { tool: 'bash', args: { command: 'ls' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'terminal_send', args: { text: 'ls' } }, env()).decision, 'deny')
})

test('wrapper stripping: timeout/nohup/env', () => {
  const parsed = rules({ deny: ['Bash(npm test *)'] })
  assert.equal(evaluateCall(parsed, { tool: 'bash', args: { command: 'timeout 30 npm test x' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'bash', args: { command: 'NODE_ENV=test npm test x' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'bash', args: { command: 'FOO=bar npm test x' } }, env()).decision, 'deny')
})

test('compound command: deny matches any subcommand', () => {
  const parsed = rules({ deny: ['Bash(rm *)'] })
  const r = evaluateCall(parsed, { tool: 'bash', args: { command: 'git status && rm -rf tmp' } }, env())
  assert.equal(r.decision, 'deny')
})

test('path rule: Read deny gates Edit/Write and Bash file commands', () => {
  const parsed = rules({ deny: ['Read(//etc/secrets/**)'] })
  assert.equal(evaluateCall(parsed, { tool: 'read', args: { path: '/etc/secrets/passwd' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'edit', args: { file_path: '/etc/secrets/passwd' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'bash', args: { command: 'cat /etc/secrets/passwd' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'bash', args: { command: 'cat /etc/hosts' } }, env()).decision, 'none')
})

test('path rule: relative single-segment matches at depth for deny', () => {
  const parsed = rules({ deny: ['Read(secrets/**)'] })
  assert.equal(evaluateCall(parsed, { tool: 'read', args: { path: '/proj/vendor/pkg/secrets/x' } }, env()).decision, 'deny')
})

test('domain rule', () => {
  const parsed = rules({ deny: ['WebFetch(domain:*.example.com)'] })
  assert.equal(evaluateCall(parsed, { tool: 'web_fetch', args: { url: 'https://api.example.com/x' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'web_fetch', args: { url: 'https://example.com/x' } }, env()).decision, 'none')
  assert.equal(evaluateCall(parsed, { tool: 'bash', args: { command: 'curl example.com' } }, env()).decision, 'none')
})

test('param rule: exact and wildcard', () => {
  const exact = rules({ deny: ['Agent(model:opus)'] })
  assert.equal(evaluateCall(exact, { tool: 'subagent', args: { model: 'opus' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(exact, { tool: 'subagent', args: {} }, env()).decision, 'none') // omitted never matches
  const wild = rules({ deny: ['Agent(isolation:*)'] })
  assert.equal(evaluateCall(wild, { tool: 'subagent', args: { isolation: 'worktree' } }, env()).decision, 'deny')
})

test('PowerShell rules and alias canonicalization', () => {
  const parsed = rules({ deny: ['PowerShell(Remove-Item *)'] })
  assert.equal(evaluateCall(parsed, { tool: 'pwsh', args: { command: 'Remove-Item -Recurse -Force .\\sample' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'pwsh', args: { command: 'del .\\sample' } }, env()).decision, 'deny')
  assert.equal(evaluateCall(parsed, { tool: 'pwsh', args: { command: 'rm -rf .\\sample' } }, env()).decision, 'deny')
  // Bash rules do NOT cover the pwsh tool (CC: Bash and PowerShell are separate tools)
  const bash = rules({ deny: ['Bash(rm -rf *)'] })
  assert.equal(evaluateCall(bash, { tool: 'pwsh', args: { command: 'Remove-Item -Recurse -Force .\\sample' } }, env()).decision, 'none')
  assert.equal(evaluateCall(bash, { tool: 'bash', args: { command: 'rm -rf tmp' } }, env()).decision, 'deny')
})

test('mcp rules', () => {
  const server = rules({ deny: ['mcp__github'] })
  assert.equal(evaluateCall(server, { tool: 'mcp__github__get_issue', args: {} }, env()).decision, 'deny')
  const tool = rules({ deny: ['mcp__github__delete_issue'] })
  assert.equal(evaluateCall(tool, { tool: 'mcp__github__delete_issue', args: {} }, env()).decision, 'deny')
  assert.equal(evaluateCall(tool, { tool: 'mcp__github__get_issue', args: {} }, env()).decision, 'none')
  const all = rules({ deny: ['mcp__*'] })
  assert.equal(evaluateCall(all, { tool: 'mcp__github__get_issue', args: {} }, env()).decision, 'deny')
  assert.equal(evaluateCall(all, { tool: 'bash', args: { command: 'ls' } }, env()).decision, 'none')
})

test('skill rule targets DSH skill tool', () => {
  const parsed = rules({ deny: ['Skill(some-skill)'] })
  assert.equal(evaluateCall(parsed, { tool: 'skill', args: { name: 'some-skill' } }, env()).decision, 'deny')
})

// ─── loadClaude end-to-end ───────────────────────────────────────────────────

test('loadClaude: skills/commands/rules/permissions from temp tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-loader-'))
  try {
    const claude = join(dir, '.claude')
    mkdirSync(join(claude, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(claude, 'skills', 'demo', 'SKILL.md'), [
      '---',
      'name: demo',
      'description: Demo skill for tests',
      'when_to_use: when testing',
      '---',
      'Do the demo thing.',
    ].join('\n'))
    mkdirSync(join(claude, 'commands'), { recursive: true })
    writeFileSync(join(claude, 'commands', 'deploy.md'), 'Deploy it.\n')
    mkdirSync(join(claude, 'rules'), { recursive: true })
    writeFileSync(join(claude, 'rules', '01-style.md'), 'Use kebab-case.\n')
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({
      permissions: { deny: ['Bash(rm *)'], ask: ['Bash(git push *)'], allow: ['Bash(npm run *)'] },
      defaultMode: 'dontAsk',
    }))
    writeFileSync(join(dir, '.git'), '')

    const ir = await loadClaude({ cwd: dir, homeDir: join(tmpdir(), 'nohome'), enableGlobal: false })
    assert.equal(ir.projectRoot, dir)
    assert.equal(ir.components.skills.length, 1)
    assert.equal(ir.components.skills[0].name, 'demo')
    assert.equal(ir.components.skills[0].description, 'Demo skill for tests')
    assert.equal(ir.components.commands.length, 1)
    assert.equal(ir.components.commands[0].name, 'deploy')
    assert.equal(ir.components.rules.length, 1)
    assert.equal(ir.components.rules[0].name, '01-style.md')

    const p = ir.components.permissions
    assert.equal(p.status, 'DIRECT')
    assert.equal(p.defaultMode, 'dontAsk')
    assert.equal(p.parsed.deny.length, 1)
    assert.equal(p.parsed.ask.length, 1)
    assert.equal(p.parsed.allow.length, 1)
    assert.equal(ir.report.direct, 4) // skill + command + rule + permissions

    // Full evaluate through the IR
    const result = evaluateCall(p.parsed, { tool: 'bash', args: { command: 'rm -rf tmp' } }, { cwd: dir, homeDir: join(tmpdir(), 'nohome'), projectRoot: dir })
    assert.equal(result.decision, 'deny')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadClaude: global ~/.claude merged with lower rank', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-loader-'))
  const home = mkdtempSync(join(tmpdir(), 'cc-home-'))
  try {
    mkdirSync(join(home, '.claude', 'skills', 'global-skill'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'global-skill', 'SKILL.md'), [
      '---', 'name: global-skill', 'description: A global skill', '---', 'global body',
    ].join('\n'))
    writeFileSync(join(dir, '.git'), '')
    const ir = await loadClaude({ cwd: dir, homeDir: home, enableGlobal: true })
    assert.equal(ir.components.skills.length, 1)
    assert.equal(ir.components.skills[0].source, 'user-claude')
    assert.equal(ir.components.skills[0].rank, 160)
    assert.equal(ir.components.skills[0].status, 'DIRECT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadClaude: skill allowed-tools / disallowed-tools parsed into IR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-loader-'))
  try {
    mkdirSync(join(dir, '.claude', 'skills', 'scoped'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', 'scoped', 'SKILL.md'), [
      '---',
      'name: scoped',
      'description: Skill with a tool scope',
      'allowed-tools:',
      '  - Read',
      '  - mcp__github__get_issue',
      'disallowed-tools:',
      '  - Write',
      '  - Edit',
      '---',
      'Use the allowed tools.',
    ].join('\n'))
    writeFileSync(join(dir, '.git'), '')
    const ir = await loadClaude({ cwd: dir, homeDir: join(tmpdir(), 'nohome'), enableGlobal: false })
    assert.equal(ir.components.skills.length, 1)
    const skill = ir.components.skills[0]
    assert.deepEqual(skill.allowedTools, ['Read', 'mcp__github__get_issue'])
    assert.deepEqual(skill.disallowedTools, ['Write', 'Edit'])
    assert.equal(skill.status, 'DIRECT')
    // No tool-scope fields → empty arrays, still DIRECT.
    mkdirSync(join(dir, '.claude', 'skills', 'plain'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', 'plain', 'SKILL.md'), [
      '---', 'name: plain', 'description: Plain skill', '---', 'plain body',
    ].join('\n'))
    const ir2 = await loadClaude({ cwd: dir, homeDir: join(tmpdir(), 'nohome'), enableGlobal: false })
    const plain = ir2.components.skills.find((s) => s.name === 'plain')
    assert.deepEqual(plain.allowedTools, [])
    assert.deepEqual(plain.disallowedTools, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
