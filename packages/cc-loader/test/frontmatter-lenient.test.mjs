// Frontmatter parsing: strict YAML first, flat `key: value` fallback for the
// blocks Claude Code accepts but strict YAML rejects (#9). A file that CC reads
// must not be dropped here — the failure was silent, reported only as
// "no frontmatter" on a file that plainly had one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../src/skills.js'
import { discoverAgents } from '../src/agents.js'
import { loadClaude } from '../src/load.js'

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-frontmatter-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, content)
  }
  return dir
}

// The shape from the report: the unquoted description carries a second `: `,
// so strict YAML stops on "Nested mappings are not allowed in compact mappings".
const REPORTED = `---
name: documentation-expert
description: Writes docs. Context: use when the user asks for docs. <example>user: 'write docs'</example>
tools: Read, Grep, Glob
---

You are a documentation expert.
`

test('non-strict YAML is read instead of dropping the file', () => {
  const parsed = parseFrontmatter(REPORTED)
  assert.notEqual(parsed, undefined)
  assert.equal(parsed.data.name, 'documentation-expert')
  assert.equal(
    parsed.data.description,
    "Writes docs. Context: use when the user asks for docs. <example>user: 'write docs'</example>",
  )
  assert.equal(parsed.body, '\nYou are a documentation expert.\n')
})

test('a lenient read is reported through warnings, not degraded in silence', () => {
  const warnings = []
  parseFrontmatter(REPORTED, warnings, 'agent "/p/documentation-expert.md"')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^agent "\/p\/documentation-expert\.md"/)
  assert.match(warnings[0], /not strict YAML|strict YAML rejects/)
})

test('strict YAML stays silent and keeps its own types', () => {
  const warnings = []
  const parsed = parseFrontmatter('---\nname: x\nmaxTurns: 3\n---\nbody\n', warnings, 'agent "x"')
  assert.equal(warnings.length, 0)
  assert.equal(parsed.data.maxTurns, 3) // a real number, as YAML intended
})

test('documented comma lists are split on the lenient path', () => {
  const parsed = parseFrontmatter(REPORTED)
  assert.deepEqual(parsed.data.tools, ['Read', 'Grep', 'Glob'])
})

test('fields that are not documented lists keep their commas', () => {
  const parsed = parseFrontmatter('---\ndescription: a, b, c\nname: x, y\n---\nbody\n')
  assert.equal(parsed.data.description, 'a, b, c')
  assert.equal(parsed.data.name, 'x, y')
})

test('lenient values stay strings — a numeric-looking one must not become a number', () => {
  // `description: 2024` coerced to a number would fail stringField and lose the
  // field entirely, trading a dropped file for a dropped field.
  const parsed = parseFrontmatter(
    '---\nname: x\ndescription: 2024 is the year. Context: note the colon\nmaxTurns: 3\n---\nbody\n',
  )
  assert.equal(parsed.data.maxTurns, '3')
  assert.equal(parsed.data.description, '2024 is the year. Context: note the colon')
})

test('other strict-YAML failures recover the same way', () => {
  // Tab indentation, and a duplicated key — both throw under strict YAML.
  const tabbed = parseFrontmatter('---\nname: x\ndescription: ok\n\ttools: Read\n---\nbody\n')
  assert.equal(tabbed.data.name, 'x')
  assert.equal(tabbed.data.description, 'ok')
  const dup = parseFrontmatter('---\nname: x\nname: y\ndescription: z\n---\nbody\n')
  assert.equal(dup.data.name, 'y') // last line wins
  assert.equal(dup.data.description, 'z')
})

test('a block with nothing readable is still undefined', () => {
  // No top-level `key: value` line survives → the caller's "no frontmatter"
  // remains accurate, so it must not be papered over.
  assert.equal(parseFrontmatter('---\n\t: :\n---\nbody\n'), undefined)
  assert.equal(parseFrontmatter('---\njust a bare scalar\n---\nbody\n'), undefined)
})

test('files without frontmatter are still undefined', () => {
  assert.equal(parseFrontmatter('no frontmatter here\n'), undefined)
  assert.equal(parseFrontmatter('---\nname: x\n'), undefined) // unclosed
})

test('discoverAgents loads the reported file end to end', async () => {
  const dir = await fixture({ 'agents/documentation-expert.md': REPORTED })
  try {
    const warnings = []
    const agents = await discoverAgents(join(dir, 'agents'), 'project', 150, warnings)
    assert.equal(agents.length, 1)
    const agent = agents[0]
    assert.equal(agent.name, 'documentation-expert')
    assert.equal(agent.systemPrompt, 'You are a documentation expert.')
    assert.deepEqual(agent.tools, ['Read', 'Grep', 'Glob'])
    assert.equal(warnings.filter((w) => w.includes('skipped')).length, 0)
    assert.equal(warnings.filter((w) => w.includes('strict YAML')).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadClaude reports each lenient read once — skills, commands and agents alike', async () => {
  const dir = await fixture({
    '.claude/agents/documentation-expert.md': REPORTED,
    '.claude/skills/frontmatter-demo/SKILL.md':
      '---\nname: frontmatter-demo\ndescription: Demo. Marker: colon breaks strict YAML\n---\nbody\n',
    '.claude/commands/frontmatter-demo.md':
      '---\ndescription: Demo. Marker: colon breaks strict YAML\n---\nbody\n',
  })
  try {
    const ir = await loadClaude({
      cwd: dir,
      homeDir: join(tmpdir(), 'cc-no-such-home'),
      enableGlobal: false,
    })
    assert.equal(ir.projectRoot, dir)
    assert.deepEqual(ir.components.skills.map((s) => s.name), ['frontmatter-demo'])
    assert.deepEqual(ir.components.commands.map((c) => c.name), ['frontmatter-demo'])
    assert.deepEqual(ir.components.agents.map((a) => a.name), ['documentation-expert'])
    // Three files degrade, three notices — not six: loadClaude used to re-push
    // the collector mergeAgentCatalog had already filled.
    assert.equal(ir.warnings.filter((w) => w.includes('strict YAML')).length, 3)
    assert.equal(ir.warnings.filter((w) => w.includes('skipped')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
