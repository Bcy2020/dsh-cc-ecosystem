// Unit tests for the cc-permissions approval seam: CC allow rules answer
// `approval/request` (incl. sandbox escalation) with `allowed-once`, while
// deny/ask rules and unmatched calls defer to the human answerer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseRulesFor } from 'dsh-cc-loader'
import { findToolCall, parseArguments, decideApproval } from '../src/approval.js'
import { apply, Config } from '../src/index.js'

const ENV = { cwd: 'C:/proj', homeDir: 'C:/Users/u', projectRoot: 'C:/proj' }

/** Build `parseRulesFor` input from raw rule lists ({bucket: raw[]}). */
function rules({ deny = [], ask = [], allow = [] } = {}) {
  return parseRulesFor({
    deny: deny.map((raw) => ({ raw, scope: 'project', path: '/' })),
    ask: ask.map((raw) => ({ raw, scope: 'project', path: '/' })),
    allow: allow.map((raw) => ({ raw, scope: 'project', path: '/' })),
  })
}

function event(callId, name, args) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } }
}

const EVENTS = [
  { type: 'turn/start', data: {} },
  event('c1', 'bash', { command: 'pytest -q', description: 'run tests' }),
  { type: 'tool/result', data: { callId: 'c1' } },
  event('c2', 'bash', { command: 'rm -rf C:/x', description: 'cleanup' }),
  event('c3', 'mcp__filesys__list', {}),
  event('c4', 'mcp__plugin_myplugin_mysrv__tool', {}),
]

// ─── findToolCall ────────────────────────────────────────────────────────────

test('findToolCall: matches the newest tool/call by callId + toolName', () => {
  const call = findToolCall(EVENTS, 'c1', 'bash')
  assert.ok(call !== undefined)
  assert.equal(call.callId, 'c1')
  assert.equal(call.name, 'bash')
})

test('findToolCall: skips non-tool/call events and wrong names', () => {
  assert.equal(findToolCall(EVENTS, 'c1', 'pwsh'), undefined, 'toolName mismatch')
  assert.equal(findToolCall(EVENTS, 'nope', 'bash'), undefined, 'unknown callId')
  assert.equal(findToolCall(EVENTS, undefined, 'bash'), undefined, 'empty callId')
  assert.equal(findToolCall('not-an-array', 'c1', 'bash'), undefined, 'non-array events')
})

// ─── parseArguments ─────────────────────────────────────────────────────────

test('parseArguments: JSON text, object, absent, unparseable', () => {
  assert.deepEqual(parseArguments('{"command":"pytest"}'), { command: 'pytest' })
  assert.deepEqual(parseArguments({ command: 'pytest' }), { command: 'pytest' })
  assert.deepEqual(parseArguments(undefined), {})
  assert.deepEqual(parseArguments(null), {})
  assert.equal(parseArguments('{broken'), null)
})

// ─── decideApproval: command rules ───────────────────────────────────────────

test('decideApproval: Bash allow rule auto-approves a matching command', () => {
  const parsed = rules({ allow: ['Bash(pytest:*)'] })
  assert.equal(decideApproval({ events: EVENTS, callId: 'c1', toolName: 'bash', parsed, env: ENV }), 'allow')
})

test('decideApproval: allow rule does not cover a non-matching command', () => {
  const parsed = rules({ allow: ['Bash(pytest:*)'] })
  assert.equal(decideApproval({ events: EVENTS, callId: 'c2', toolName: 'bash', parsed, env: ENV }), 'defer')
})

test('decideApproval: bare tool allow covers every call of that tool', () => {
  const parsed = rules({ allow: ['Bash'] })
  assert.equal(decideApproval({ events: EVENTS, callId: 'c1', toolName: 'bash', parsed, env: ENV }), 'allow')
  assert.equal(decideApproval({ events: EVENTS, callId: 'c2', toolName: 'bash', parsed, env: ENV }), 'allow')
})

test('decideApproval: deny rule wins over allow (fold order)', () => {
  const parsed = rules({ deny: ['Bash(rm -rf *)'], allow: ['Bash(pytest:*)'] })
  assert.equal(decideApproval({ events: EVENTS, callId: 'c2', toolName: 'bash', parsed, env: ENV }), 'defer')
  assert.equal(decideApproval({ events: EVENTS, callId: 'c1', toolName: 'bash', parsed, env: ENV }), 'allow')
})

test('decideApproval: ask rule defers (ask still asks the human)', () => {
  const parsed = rules({ ask: ['Bash(rm -rf *)'], allow: ['Bash(pytest:*)'] })
  assert.equal(decideApproval({ events: EVENTS, callId: 'c2', toolName: 'bash', parsed, env: ENV }), 'defer')
})

test('decideApproval: no rules defers', () => {
  const parsed = rules()
  assert.equal(decideApproval({ events: EVENTS, callId: 'c1', toolName: 'bash', parsed, env: ENV }), 'defer')
})

// ─── decideApproval: enableAllProjectMcpServers ─────────────────────────────

test('decideApproval: project MCP tool auto-approved under enableAllProjectMcpServers', () => {
  const parsed = rules()
  const isProjectMcp = (name) => name.startsWith('mcp__') && !name.startsWith('mcp__plugin_')
  assert.equal(decideApproval({
    events: EVENTS, callId: 'c3', toolName: 'mcp__filesys__list', parsed, env: ENV,
    enableAllProjectMcpServers: true, isProjectMcpTool: isProjectMcp,
  }), 'allow')
  assert.equal(decideApproval({
    events: EVENTS, callId: 'c4', toolName: 'mcp__plugin_myplugin_mysrv__tool', parsed, env: ENV,
    enableAllProjectMcpServers: true, isProjectMcpTool: isProjectMcp,
  }), 'defer', 'plugin MCP tools are not covered')
})

test('decideApproval: flag off defers', () => {
  const parsed = rules()
  assert.equal(decideApproval({ events: EVENTS, callId: 'c3', toolName: 'mcp__filesys__list', parsed, env: ENV }), 'defer')
})

// ─── decideApproval: malformed inputs defer ─────────────────────────────────

test('decideApproval: unparseable or missing arguments defer', () => {
  const parsed = rules({ allow: ['Bash'] })
  const broken = [{ type: 'tool/call', data: { callId: 'x', name: 'bash', arguments: '{bad' } }]
  assert.equal(decideApproval({ events: broken, callId: 'x', toolName: 'bash', parsed, env: ENV }), 'defer')
  const absent = [{ type: 'tool/call', data: { callId: 'x', name: 'bash' } }]
  assert.equal(decideApproval({ events: absent, callId: 'x', toolName: 'bash', parsed, env: ENV }), 'defer')
})

// ─── waterfall integration ──────────────────────────────────────────────────

function tempProject(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-perm-approve-'))
  mkdirSync(join(dir, '.git'), { recursive: true }) // project-root marker
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  return {
    dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

function approvalCtx(projectDir, events) {
  const ctx = new Context()
  apply(ctx, Config({ homeDir: join(tmpdir(), 'cc-perm-nohome') }))
  const ask = (toolName, callId) => ctx.waterfall('approval/request', {
    agent: { session: { header: { cwd: projectDir }, events } },
    toolName,
    callId,
  }, () => 'unavailable')
  return { ctx, ask }
}

test('waterfall: allow rule answers allowed-once before the human answerer', async () => {
  const t = tempProject({ permissions: { allow: ['Bash(pytest:*)'] } })
  try {
    const events = [event('c1', 'bash', { command: 'pytest -q' })]
    const { ask } = approvalCtx(t.dir, events)
    assert.equal(await ask('bash', 'c1'), 'allowed-once')
  } finally {
    t.cleanup()
  }
})

test('waterfall: unmatched call defers to the terminal answerer', async () => {
  const t = tempProject({ permissions: { allow: ['Bash(pytest:*)'] } })
  try {
    const events = [event('c1', 'bash', { command: 'rm -rf C:/x' })]
    const { ask } = approvalCtx(t.dir, events)
    assert.equal(await ask('bash', 'c1'), 'unavailable')
  } finally {
    t.cleanup()
  }
})

test('waterfall: ask rule still defers (human decides)', async () => {
  const t = tempProject({ permissions: { ask: ['Bash(rm -rf *)'] } })
  try {
    const events = [event('c1', 'bash', { command: 'rm -rf C:/x' })]
    const { ask } = approvalCtx(t.dir, events)
    assert.equal(await ask('bash', 'c1'), 'unavailable')
  } finally {
    t.cleanup()
  }
})
