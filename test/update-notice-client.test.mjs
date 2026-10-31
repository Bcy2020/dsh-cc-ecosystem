// The update-notice block is shipped twice (both client halves must work
// standalone, and a classic script cannot import). This test keeps the two
// copies byte-identical and asserts the security property the block exists to
// hold: only a validated semver ever reaches a copyable command.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const BEGIN = '  // ─── cc-update notice (begin shared block)'
const END = '  // ─── cc-update notice (end shared block)'

function block(relative) {
  const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  assert.ok(start >= 0 && end > start, `${relative} must contain the shared block`)
  return text.slice(start, end)
}

const mcp = block('../packages/cc-mcp/client/index.js')
const memory = block('../packages/cc-memory/client/index.js')

test('both client halves carry the same notice block', () => {
  assert.equal(mcp, memory)
})

test('the block validates before it substitutes into a command', () => {
  assert.ok(mcp.includes('var CU_SEMVER ='))
  assert.ok(mcp.includes('CU_SEMVER.test(value)'))
  assert.ok(mcp.includes('CU_PACKAGES.indexOf(entry.name) < 0'))
  assert.ok(mcp.includes('!cuValidVersion(update.bundle)'))
  assert.equal(mcp.includes('innerHTML'), false)
})

test('the block never executes anything', () => {
  assert.doesNotMatch(mcp, /exec\(|spawn\(|execCommand\('open'|child_process/)
})
