// Matrix tests for dsh-cc-hooks parsing coverage.
//
// Consumes the generated fixture corpus (scripts/generate-hook-fixtures.mjs):
//   matrix/  465 fixtures — 31 events × 5 types × 3-of-5 field variants (60%)
//   special/ 12 boundary cases (S01..S12)
// Every fixture must parse without throwing and land in the expected bucket
// (command → config; other types → skipped; specials → their documented class).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHooksConfig } from '../packages/cc-hooks/src/parse.js'

const DATA = join('packages', 'cc-hooks', 'testdata', 'hooks')
const matrixDir = join(DATA, 'matrix')
const specialDir = join(DATA, 'special')

const TYPE_SPECIFIC_KEYS = {
  command: 'command',
  http: 'url',
  mcp_tool: 'server',
  prompt: 'prompt',
  agent: 'prompt',
}

test(`matrix: all ${465} fixtures parse without throwing and classify correctly`, () => {
  const files = readdirSync(matrixDir).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 465, 'generator must emit exactly 465 matrix fixtures')

  const seenEvents = new Set()
  const seenTypes = new Set()
  const seenVariants = new Set()

  for (const file of files) {
    const [event, type, variant] = file.replace(/\.json$/, '').split('__')
    assert.ok(event && type && variant, `fixture name must be <event>__<type>__<variant>: ${file}`)
    seenEvents.add(event)
    seenTypes.add(type)
    seenVariants.add(variant)

    const doc = JSON.parse(readFileSync(join(matrixDir, file), 'utf8'))
    const groups = doc.hooks[event]
    assert.ok(Array.isArray(groups) && groups.length === 1, `${file}: one matcher group expected`)
    const group = groups[0]
    const hook = group.hooks[0]
    assert.equal(hook.type, type, `${file}: type matches filename`)
    // Mandatory type-specific field is present.
    assert.ok(typeof hook[TYPE_SPECIFIC_KEYS[type]] === 'string', `${file}: ${TYPE_SPECIFIC_KEYS[type]} present`)

    let parsed
    assert.doesNotThrow(() => { parsed = parseHooksConfig(doc) }, `${file}: parse must not throw`)

    if (type === 'command') {
      // command hooks land in config with command + variant fields.
      assert.ok(parsed.config[event]?.[0]?.hooks?.[0], `${file}: command hook in config`)
      const out = parsed.config[event][0].hooks[0]
      assert.equal(out.command, `echo ${event}`)
      if (variant === 'F2' || variant === 'F5') assert.equal(out.timeoutSec, 30, `${file}: timeout → timeoutSec`)
      if (variant === 'F3' || variant === 'F5') assert.equal(out.if, 'Bash(git *)', `${file}: if passed through`)
      if (variant === 'F4' || variant === 'F5') assert.equal(out.statusMessage, 'hook running', `${file}: statusMessage passed through`)
    } else {
      // other types are parsed-and-skipped, never fatal.
      assert.ok(parsed.skipped.some((s) => s.event === event && s.type === type), `${file}: ${type} hook reported skipped`)
    }
  }

  // Coverage: every event, type and variant appears in the corpus.
  assert.equal(seenEvents.size, 31, 'all 31 events covered')
  assert.equal(seenTypes.size, 5, 'all 5 types covered')
  assert.equal(seenVariants.size, 5, 'all 5 variants covered')
})

test('special: fixtures land in their documented class (S01..S12)', () => {
  const read = (name) => readFileSync(join(specialDir, name), 'utf8')

  // S01 invalid regex matcher → SyntaxError
  assert.throws(() => parseHooksConfig(JSON.parse(read('S01-invalid-matcher.json'))), SyntaxError)

  // S02 invalid JSON file → not JSON at all
  assert.throws(() => JSON.parse(read('S02-invalid-json.json')))

  // S03 settings shape (wrapped in { permissions, hooks }) → parses
  const s3 = parseHooksConfig(JSON.parse(read('S03-settings-shape.json')))
  assert.equal(s3.config.PreToolUse[0].hooks[0].command, 'echo settings')

  // S04 http hook without url → skipped, not fatal
  const s4 = parseHooksConfig(JSON.parse(read('S04-http-no-url.json')))
  assert.ok(s4.skipped.some((s) => s.type === 'http'))

  // S05 UserPromptSubmit matcher is discarded
  const s5 = parseHooksConfig(JSON.parse(read('S05-prompt-submit-matcher-ignored.json')))
  assert.equal('matcher' in s5.config.UserPromptSubmit[0], false)

  // S06 unknown event ignored
  const s6 = parseHooksConfig(JSON.parse(read('S06-unknown-event.json')))
  assert.deepEqual(s6.config, {})

  // S07 empty hooks object → empty config
  const s7 = parseHooksConfig(JSON.parse(read('S07-empty-hooks.json')))
  assert.deepEqual(s7.config, {})

  // S08 `if` on a non-tool event is passed through syntactically
  const s8 = parseHooksConfig(JSON.parse(read('S08-if-on-non-tool-event.json')))
  assert.equal(s8.config.Stop[0].hooks[0].if, 'Bash(rm *)')

  // S09 command without command field → hook dropped
  const s9 = parseHooksConfig(JSON.parse(read('S09-command-without-command-field.json')))
  assert.deepEqual(s9.config, {})

  // S10 hooks value not an array → group dropped
  const s10 = parseHooksConfig(JSON.parse(read('S10-hooks-not-array.json')))
  assert.deepEqual(s10.config, {})

  // S11 non-numeric timeout → no timeoutSec
  const s11 = parseHooksConfig(JSON.parse(read('S11-timeout-not-number.json')))
  assert.equal('timeoutSec' in s11.config.PreToolUse[0].hooks[0], false)

  // S12 compound literal + regex matchers both parse
  const s12 = parseHooksConfig(JSON.parse(read('S12-compound-and-regex-matcher.json')))
  assert.equal(s12.config.PreToolUse.length, 2)
  assert.equal(s12.config.PreToolUse[0].matcher, 'Bash|Write|Edit')
  assert.equal(s12.config.PreToolUse[1].matcher, '^mcp__.*__write.*')
})

test('coverage report: 60% target with full event/type/variant presence', () => {
  const cov = JSON.parse(readFileSync(join(DATA, 'coverage.json'), 'utf8'))
  assert.equal(cov.totalCombinations, 31 * 5 * 5)
  assert.equal(cov.matrixCount, 465)
  assert.ok(Math.abs(cov.coverageRatio - 0.6) < 1e-9)
  assert.equal(Object.values(cov.byEvent).filter(Boolean).length, 31)
  assert.equal(Object.values(cov.byType).filter(Boolean).length, 5)
  assert.equal(Object.values(cov.byVariant).filter(Boolean).length, 5)
  assert.equal(cov.specialCount, 12)
})
