// personaFor: CC agent body + frontmatter `context` merged into the delegation
// persona. Lives in the package so it can import cc-agents' ESM deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { personaFor, mergePluginAgents } from '../src/index.js'

test('personaFor appends context to the system prompt', () => {
  assert.equal(personaFor({ systemPrompt: 'Body.', context: ['C1', 'C2'] }),
    'Body.\n\nC1\n\nC2')
  assert.equal(personaFor({ systemPrompt: 'Body.' }), 'Body.')
  assert.equal(personaFor({ systemPrompt: 'Body.', context: [] }), 'Body.')
})

test('mergePluginAgents namespaces plugin agents plugin-<plugin>-<name>', () => {
  const ir = {
    components: {
      agents: [{ name: 'local', description: 'project agent', scope: 'project' }],
      plugins: [
        {
          name: 'superpowers',
          components: {
            agents: [
              { name: 'brainstorming', description: 'brainstorms', scope: 'plugin', status: 'DIRECT', systemPrompt: 'x' },
              { name: 'planner', description: 'plans', scope: 'plugin', status: 'BLOCKED', systemPrompt: 'y' },
            ],
          },
        },
      ],
    },
  }
  const merged = mergePluginAgents(ir)
  assert.equal(merged.length, 3)
  assert.equal(merged[0].name, 'local') // top-level untouched
  assert.equal(merged[1].name, 'plugin-superpowers-brainstorming')
  assert.equal(merged[1].scope, 'plugin')
  assert.equal(merged[1].systemPrompt, 'x') // IR fields preserved
  // BLOCKED plugin agents stay in the catalog; delegation rejects them later.
  assert.equal(merged[2].name, 'plugin-superpowers-planner')
  assert.equal(merged[2].status, 'BLOCKED')
})

test('mergePluginAgents: empty plugins is a no-op', () => {
  const ir = { components: { agents: [{ name: 'a' }], plugins: [] } }
  const merged = mergePluginAgents(ir)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].name, 'a')
})
