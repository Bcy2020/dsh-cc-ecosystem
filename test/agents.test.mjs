// Unit tests: .claude/agents discovery + IR classification + CC→DSH tool expansion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverAgents, mergeAgentCatalog, buildAgentEntry,
  classifyAgentFields, expandCcToolToDsh,
} from '../packages/cc-loader/src/agents.js'

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-agents-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, content)
  }
  return dir
}

const BASIC = `---
name: code-reviewer
description: Reviews pull requests for style and correctness
tools:
  - Read
  - Grep
disallowedTools:
  - Write
  - Edit
model: claude-opus-4-1
---

You are a strict code reviewer. Focus on correctness and style.
`

test('discoverAgents parses frontmatter + body into IR', async () => {
  const dir = await fixture({ 'agents/code-reviewer.md': BASIC })
  try {
    const agents = await discoverAgents(join(dir, 'agents'), 'project', 150)
    assert.equal(agents.length, 1)
    const a = agents[0]
    assert.equal(a.kind, 'agent')
    assert.equal(a.name, 'code-reviewer')
    assert.equal(a.description, 'Reviews pull requests for style and correctness')
    assert.deepEqual(a.tools, ['Read', 'Grep'])
    assert.deepEqual(a.disallowedTools, ['Write', 'Edit'])
    assert.equal(a.model, 'claude-opus-4-1')
    assert.equal(a.systemPrompt, 'You are a strict code reviewer. Focus on correctness and style.')
    assert.equal(a.status, 'DIRECT')
    assert.equal(a.scope, 'project')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('discoverAgents falls back to file stem name; skips missing description/body', async () => {
  const dir = await fixture({
    'agents/my-agent.md': `---\ndescription: No name field\n---\nBody here.\n`,
    'agents/no-desc.md': `---\nname: no-desc\n---\nBody.\n`,
    'agents/empty.md': `---\nname: empty\ndescription: x\n---\n`,
    'agents/no-fm.md': `Just markdown without frontmatter.\n`,
    'agents/bad-name.md': `---\nname: Not Kebab!\ndescription: x\n---\nBody.\n`,
  })
  try {
    const warnings = []
    const agents = await discoverAgents(join(dir, 'agents'), 'project', 150, warnings)
    assert.deepEqual(agents.map((a) => a.name), ['my-agent'])
    assert.equal(agents[0].systemPrompt, 'Body here.')
    assert.ok(warnings.some((w) => w.includes('no-desc')))
    assert.ok(warnings.some((w) => w.includes('empty')))
    assert.ok(warnings.some((w) => w.includes('no frontmatter')))
    assert.ok(warnings.some((w) => w.includes('Not Kebab')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('classifyAgentFields: worktree BLOCKED, hooks/permissionMode UNSUPPORTED, memory ADAPTED', () => {
  assert.equal(classifyAgentFields({ name: 'a', description: 'd' }), 'DIRECT')
  assert.equal(classifyAgentFields({ name: 'a', description: 'd', isolation: 'worktree' }), 'BLOCKED')
  const notes1 = []
  assert.equal(classifyAgentFields({ hooks: { PreToolUse: [] } }, notes1), 'UNSUPPORTED')
  assert.ok(notes1.some((n) => n.includes('hooks')))
  const notes2 = []
  assert.equal(classifyAgentFields({ memory: 'project' }, notes2), 'ADAPTED')
  const notes3 = []
  assert.equal(classifyAgentFields({ unknownField: 1 }, notes3), 'ADAPTED')
})

test('buildAgentEntry: unknown fields land in notes, isolation captured', () => {
  const e = buildAgentEntry({
    path: '/x/a.md', directory: '/x', name: 'a', description: 'd',
    body: 'body', fm: { name: 'a', description: 'd', isolation: 'worktree' },
    scope: 'global', rank: 160,
  })
  assert.equal(e.status, 'BLOCKED')
  assert.equal(e.isolation, 'worktree')
  assert.ok(e.notes.some((n) => n.includes('worktree')))
})

test('buildAgentEntry: context/memory/color extracted, agent field reported', () => {
  const e = buildAgentEntry({
    path: '/x/a.md', directory: '/x', name: 'a', description: 'd',
    body: 'body',
    fm: {
      name: 'a', description: 'd',
      context: ['Extra guidance one', 'Extra guidance two'],
      memory: 'project',
      color: 'blue',
      agent: 'parent-agent',
    },
    scope: 'project', rank: 150,
  })
  assert.deepEqual(e.context, ['Extra guidance one', 'Extra guidance two'])
  assert.equal(e.memory, 'project')
  assert.equal(e.color, 'blue')
  assert.equal(e.agent, 'parent-agent')
  // agent is non-official → ADAPTED with a report note; context/memory/color
  // keep the entry DIRECT-capable (context is consumed by the persona).
  assert.equal(e.status, 'ADAPTED')
  assert.ok(e.notes.some((n) => n.includes('agent field')))
})

test('classifyAgentFields: color and agent are ADAPTED, not unknown', () => {
  const notes = []
  assert.equal(classifyAgentFields({ color: 'red' }, notes), 'ADAPTED')
  assert.ok(notes.some((n) => n.includes('color')))
  const notes2 = []
  assert.equal(classifyAgentFields({ agent: 'x' }, notes2), 'ADAPTED')
  assert.ok(notes2.some((n) => n.includes('agent field')))
})

test('mergeAgentCatalog: project beats global on name clash, fail loud', async () => {
  const dir = await fixture({
    'proj/agents/dup.md': `---\nname: dup\ndescription: project one\n---\nProject body.\n`,
    'glob/agents/dup.md': `---\nname: dup\ndescription: global one\n---\nGlobal body.\n`,
  })
  try {
    const warnings = []
    const { agents } = await mergeAgentCatalog([
      { root: join(dir, 'proj/agents'), scope: 'project', rank: 150 },
      { root: join(dir, 'glob/agents'), scope: 'global', rank: 160 },
    ], warnings)
    assert.equal(agents.length, 1)
    assert.equal(agents[0].description, 'project one')
    assert.equal(agents[0].systemPrompt, 'Project body.')
    assert.ok(warnings.some((w) => w.includes('dup')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('expandCcToolToDsh: buckets expand, mcp__/exact pass through, globs rejected', () => {
  assert.deepEqual(expandCcToolToDsh('Read'), ['read', 'read_image'])
  assert.deepEqual(expandCcToolToDsh('Bash').slice(0, 2), ['bash', 'pwsh'])
  assert.deepEqual(expandCcToolToDsh('Edit'), ['edit', 'str_replace_editor'])
  assert.deepEqual(expandCcToolToDsh('mcp__github__get_issue'), ['mcp__github__get_issue'])
  assert.deepEqual(expandCcToolToDsh('terminal_open'), ['terminal_open'])
  assert.deepEqual(expandCcToolToDsh('WebFetch'), ['web_fetch'])
  assert.deepEqual(expandCcToolToDsh('Bash*'), [])
  assert.deepEqual(expandCcToolToDsh(''), [])
  assert.deepEqual(expandCcToolToDsh('Bash', ['n']).length, 8)
})

test('loadClaude includes agents component', async () => {
  const dir = await fixture({
    '.claude/agents/reviewer.md': BASIC,
    '.git/HEAD': 'ref: refs/heads/main\n',
  })
  try {
    const { loadClaude } = await import('../packages/cc-loader/src/load.js')
    const ir = await loadClaude({ cwd: dir, enableGlobal: false })
    assert.equal(ir.components.agents.length, 1)
    assert.equal(ir.components.agents[0].name, 'code-reviewer')
    assert.ok(ir.report.agents === undefined || ir.report.total >= 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
