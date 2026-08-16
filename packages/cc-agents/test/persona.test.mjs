// personaFor: CC agent body + frontmatter `context` merged into the delegation
// persona. Lives in the package so it can import cc-agents' ESM deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { personaFor } from '../src/index.js'

test('personaFor appends context to the system prompt', () => {
  assert.equal(personaFor({ systemPrompt: 'Body.', context: ['C1', 'C2'] }),
    'Body.\n\nC1\n\nC2')
  assert.equal(personaFor({ systemPrompt: 'Body.' }), 'Body.')
  assert.equal(personaFor({ systemPrompt: 'Body.', context: [] }), 'Body.')
})
