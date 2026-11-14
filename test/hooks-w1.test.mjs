// W1 tests for dsh-cc-hooks — the five direct mappings:
//   1. CwdChanged   ← working-directory/change (plugin keeps old_cwd)
//   2. StopFailure  ← turn/end with reason.kind === 'error'
//   3. InstructionsLoaded ← agent-instructions user messages
//   4. PermissionRequest ← approval/request waterfall
//   5. PermissionDenied  ← approval/asked + approval/decided
//
// The plugin is driven through its real `apply()` with a minimal mock ctx; the
// hook commands are executed through the shell mock, which captures the exact
// stdin payload the plugin hands each hook.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../packages/cc-hooks/src/index.js'

/** Make a scratch project with a `.git` marker and the given hooks.json. */
function makeProject(hooksMap) {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-w1-'))
  mkdirSync(join(project, '.git'), { recursive: true })
  if (hooksMap !== undefined) {
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: hooksMap }))
  }
  return project
}

function makeCtx(run) {
  const listeners = {}
  const onOptions = {}
  const disposers = []
  return {
    logger: { info: () => {}, warn: () => {} },
    shell: { resolve: (req) => req, run },
    get: () => undefined,
    on: (event, handler, options) => { listeners[event] = handler; onOptions[event] = options },
    effect: (fn) => { disposers.push(fn) },
    _listeners: listeners,
    _onOptions: onOptions,
    _disposers: disposers,
  }
}

function makeAgent(cwd, sessionId = 'sess-1', header = {}) {
  const injected = []
  return {
    session: { header: { id: sessionId, cwd, ...header }, events: [], append: () => {} },
    inject: (msg) => injected.push(msg),
    steer: () => {},
    _injected: injected,
  }
}

const EMPTY = { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Record every hook invocation and its stdin payload. */
function recorder() {
  const runs = []
  return {
    runs,
    run: async (req) => {
      runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return EMPTY
    },
  }
}

/** Apply the plugin, start a session, and wait for the config preload. */
async function start({ home, project, run, agent }) {
  const ctx = makeCtx(run)
  apply(ctx, { enableGlobal: false, homeDir: home })
  await ctx._listeners['agent/session-start']({ agent, source: 'startup' })
  await sleep(300)
  return ctx
}

// ─── 1. CwdChanged ──────────────────────────────────────────────────────────

test('W1: CwdChanged fires from working-directory/change with old and new cwd', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w1-home-'))
  const project = makeProject({ CwdChanged: [{ hooks: [{ type: 'command', command: 'cwd-changed' }] }] })
  try {
    const rec = recorder()
    const agent = makeAgent(project)
    const ctx = await start({ home, project, run: rec.run, agent })
    const event = ctx._listeners['session/event']

    const sub = join(project, 'packages')
    event(agent.session, { type: 'working-directory/change', seq: 1, data: { cwd: sub } })
    await sleep(300)
    assert.equal(rec.runs.length, 1, 'one CwdChanged hook run')
    assert.equal(rec.runs[0].payload.hook_event_name, 'CwdChanged')
    assert.equal(rec.runs[0].payload.old_cwd, project, 'old_cwd comes from the cached/initial cwd')
    assert.equal(rec.runs[0].payload.new_cwd, sub)

    // Re-committing the same directory is not a change.
    event(agent.session, { type: 'working-directory/change', seq: 2, data: { cwd: sub } })
    await sleep(300)
    assert.equal(rec.runs.length, 1, 'an unchanged cwd fires nothing')

    // The cache advances: the next move starts from the previous target.
    const other = join(project, 'other')
    event(agent.session, { type: 'working-directory/change', seq: 3, data: { cwd: other } })
    await sleep(300)
    assert.equal(rec.runs.length, 2)
    assert.equal(rec.runs[1].payload.old_cwd, sub)
    assert.equal(rec.runs[1].payload.new_cwd, other)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// ─── 2. StopFailure ─────────────────────────────────────────────────────────

test('W1: StopFailure fires on a failed turn end and matches the CC error class', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w1-home-'))
  const project = makeProject({
    StopFailure: [
      { matcher: 'rate_limit', hooks: [{ type: 'command', command: 'stop-rate-limit' }] },
      { matcher: 'server_error', hooks: [{ type: 'command', command: 'stop-server-error' }] },
    ],
  })
  try {
    const rec = recorder()
    const agent = makeAgent(project)
    agent.session.events.push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'I was almost done' }] } },
    })
    const ctx = await start({ home, project, run: rec.run, agent })
    const event = ctx._listeners['session/event']

    event(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'slow down' } } } })
    await sleep(300)
    assert.equal(rec.runs.length, 1)
    assert.equal(rec.runs[0].command, 'stop-rate-limit', 'matcher selects on the mapped CC error value')
    assert.equal(rec.runs[0].payload.error, 'rate_limit')
    assert.equal(rec.runs[0].payload.error_details.code, 'RATE_LIMIT')
    assert.equal(rec.runs[0].payload.error_details.status, 429)
    assert.equal(rec.runs[0].payload.last_assistant_message, 'I was almost done')

    // An unknown code falls back to the HTTP status class.
    event(agent.session, { type: 'turn/end', seq: 2, data: { turn: 2, reason: { kind: 'error', error: { code: 'PROVIDER_5XX', status: 503, message: 'bad gateway' } } } })
    await sleep(300)
    assert.equal(rec.runs.length, 2)
    assert.equal(rec.runs[1].command, 'stop-server-error')
    assert.equal(rec.runs[1].payload.error, 'server_error')

    // A clean turn end is not a failure.
    event(agent.session, { type: 'turn/end', seq: 3, data: { turn: 3, reason: { kind: 'completed' } } })
    await sleep(300)
    assert.equal(rec.runs.length, 2, 'completed turns fire nothing')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// ─── 3. InstructionsLoaded ──────────────────────────────────────────────────

test('W1: InstructionsLoaded fires once per loaded file with scope and load reason', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w1-home-'))
  const project = makeProject({
    InstructionsLoaded: [
      { matcher: 'session_start', hooks: [{ type: 'command', command: 'instructions-start' }] },
      { matcher: 'nested_traversal', hooks: [{ type: 'command', command: 'instructions-nested' }] },
    ],
  })
  try {
    const rec = recorder()
    const agent = makeAgent(project)
    const ctx = await start({ home, project, run: rec.run, agent })
    const event = ctx._listeners['session/event']

    event(agent.session, {
      type: 'user/message',
      seq: 1,
      data: {
        role: 'user',
        content: [],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          changes: [
            { action: 'set', scope: 'project', path: '/p/AGENTS.md' },
            { action: 'remove', scope: 'project', path: '/p/GONE.md' },
            { action: 'replace', scope: 'user-global', path: '/u/AGENTS.md' },
          ],
        },
      },
    })
    await sleep(300)
    assert.equal(rec.runs.length, 2, 'the removed file fires nothing')
    assert.deepEqual(rec.runs.map((r) => r.payload.file_path).sort(), ['/p/AGENTS.md', '/u/AGENTS.md'])
    assert.ok(rec.runs.every((r) => r.command === 'instructions-start'))
    assert.ok(rec.runs.every((r) => r.payload.load_reason === 'session_start'))
    const byPath = new Map(rec.runs.map((r) => [r.payload.file_path, r.payload.memory_type]))
    assert.equal(byPath.get('/p/AGENTS.md'), 'Project')
    assert.equal(byPath.get('/u/AGENTS.md'), 'User')

    // A later delta is a nested traversal.
    event(agent.session, {
      type: 'user/message',
      seq: 2,
      data: {
        role: 'user',
        content: [],
        source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'replace', scope: 'project', path: '/p/sub/AGENTS.md' }] },
      },
    })
    await sleep(300)
    assert.equal(rec.runs.length, 3)
    assert.equal(rec.runs[2].command, 'instructions-nested')
    assert.equal(rec.runs[2].payload.load_reason, 'nested_traversal')

    // Ordinary user messages are not instruction loads.
    event(agent.session, { type: 'user/message', seq: 3, data: { role: 'user', content: [], source: { kind: 'user' } } })
    await sleep(300)
    assert.equal(rec.runs.length, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// ─── 4. PermissionRequest ───────────────────────────────────────────────────

test('W1: PermissionRequest deny claims the approval and suppresses PermissionDenied', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w1-home-'))
  const project = makeProject({
    PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'permission-request' }] }],
    PermissionDenied: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'permission-denied' }] }],
  })
  try {
    const rec = { runs: [] }
    const denied = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not allowed"}}}'
    const run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 0, stdout: { text: req.command === 'permission-request' ? denied : '' }, stderr: { text: '' } }
    }
    const agent = makeAgent(project)
    agent.session.events.push({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } })
    const ctx = await start({ home, project, run, agent })
    rec.runs.length = 0
    assert.equal(ctx._onOptions['approval/request']?.prepend, true, 'must run before the terminal desktop answerer')

    let nextCalled = false
    const outcome = await ctx._listeners['approval/request'](
      { agent, toolName: 'bash', callId: 'c1', reason: 'needs approval' },
      async () => { nextCalled = true; return 'unavailable' },
    )
    assert.equal(outcome, 'rejected')
    assert.equal(nextCalled, false, 'a hook verdict claims the request')
    assert.equal(rec.runs.length, 1)
    assert.equal(rec.runs[0].payload.hook_event_name, 'PermissionRequest')
    assert.equal(rec.runs[0].payload.tool_name, 'bash')
    assert.deepEqual(rec.runs[0].payload.tool_input, { command: 'npm test' }, 'tool_input is recovered by callId')
    assert.deepEqual(rec.runs[0].payload.permission_suggestions, [])

    // The audit pair the service writes for that request must not re-fire the
    // denial event: the hook itself made the denial.
    const event = ctx._listeners['session/event']
    event(agent.session, { type: 'approval/asked', seq: 1, data: { id: 'a1', toolName: 'bash', callId: 'c1', reason: 'needs approval' } })
    event(agent.session, { type: 'approval/decided', seq: 2, data: { id: 'a1', outcome: 'rejected' } })
    await sleep(300)
    assert.equal(rec.runs.some((r) => r.command === 'permission-denied'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('W1: PermissionRequest allow grants once; no verdict delegates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w1-home-'))
  const allowed = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  const project = makeProject({ PermissionRequest: [{ hooks: [{ type: 'command', command: 'permission-allow' }] }] })
  const plain = makeProject(undefined)
  try {
    const ctx = await start({
      home, project, agent: makeAgent(project),
      run: async () => ({ exitCode: 0, stdout: { text: allowed }, stderr: { text: '' } }),
    })
    const agent = makeAgent(project)
    let nextCalled = false
    const outcome = await ctx._listeners['approval/request'](
      { agent, toolName: 'bash' },
      async () => { nextCalled = true; return 'unavailable' },
    )
    assert.equal(outcome, 'allowed-once')
    assert.equal(nextCalled, false)

    // With no PermissionRequest hooks the waterfall must delegate untouched.
    const plainCtx = await start({ home, project: plain, agent: makeAgent(plain), run: async () => EMPTY })
    let delegated = false
    const passed = await plainCtx._listeners['approval/request'](
      { agent: makeAgent(plain), toolName: 'bash' },
      async () => { delegated = true; return 'unavailable' },
    )
    assert.equal(passed, 'unavailable')
    assert.equal(delegated, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
})

// ─── 5. PermissionDenied ────────────────────────────────────────────────────

test('W1: PermissionDenied fires on a rejected ask and injects the retry hint', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w1-home-'))
  const project = makeProject({
    PermissionDenied: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'permission-denied' }] }],
  })
  try {
    const rec = recorder()
    const retry = '{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}'
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 0, stdout: { text: retry }, stderr: { text: '' } }
    }
    const agent = makeAgent(project)
    agent.session.events.push({ type: 'tool/call', data: { callId: 'c9', name: 'bash', arguments: '{"command":"rm -rf build"}' } })
    const ctx = await start({ home, project, run: rec.run, agent })
    const event = ctx._listeners['session/event']

    event(agent.session, { type: 'approval/asked', seq: 1, data: { id: 'a1', toolName: 'bash', callId: 'c9', reason: 'auto mode denied' } })
    event(agent.session, { type: 'approval/decided', seq: 2, data: { id: 'a1', outcome: 'rejected' } })
    await sleep(300)
    assert.equal(rec.runs.length, 1)
    assert.equal(rec.runs[0].payload.hook_event_name, 'PermissionDenied')
    assert.equal(rec.runs[0].payload.tool_name, 'bash')
    assert.equal(rec.runs[0].payload.tool_use_id, 'c9')
    assert.equal(rec.runs[0].payload.reason, 'auto mode denied')
    assert.deepEqual(rec.runs[0].payload.tool_input, { command: 'rm -rf build' })
    assert.equal(agent._injected.length, 1, 'retry:true injects the hint')
    assert.match(JSON.stringify(agent._injected[0]), /may retry/)

    // A granted ask is not a denial.
    event(agent.session, { type: 'approval/asked', seq: 3, data: { id: 'a2', toolName: 'bash', callId: 'c9' } })
    event(agent.session, { type: 'approval/decided', seq: 4, data: { id: 'a2', outcome: 'allowed-once' } })
    await sleep(300)
    assert.equal(rec.runs.length, 1)
    assert.equal(agent._injected.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
