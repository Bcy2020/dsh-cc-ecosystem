// W2 tests for dsh-cc-hooks — the five synthesized/composed events:
//   1. PostToolBatch      ← previous step's tool/call + tool/result
//   2. TaskCreated        ← todo_write whole-list diff (new content)
//   3. TaskCompleted      ← todo_write whole-list diff (→ completed)
//   4. UserPromptExpansion ← command/run (observe-only + additionalContext)
//   5. Notification       ← approval/asked + subagent/end (1s dedupe)
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
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-'))
  mkdirSync(join(project, '.git'), { recursive: true })
  if (hooksMap !== undefined) {
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: hooksMap }))
  }
  return project
}

function makeCtx(run, agents) {
  const listeners = {}
  const warnings = []
  const disposers = []
  const webServer = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
    shell: { resolve: (req) => req, run },
    get: (name) => (name === 'agents' && agents !== undefined ? { get: (id) => agents.get(id) } : undefined),
    on: (event, handler, options) => { listeners[event] = handler },
    effect: (fn) => { disposers.push(fn) },
    inject: (deps, callback) => {
      if (deps.includes('webServer')) {
        callback({
          // Cordis runs an effect callback immediately; its return value is the disposer.
          effect: (fn) => { const disposer = fn(); disposers.push(disposer); return disposer },
          webServer: { register: (spec) => { webServer.push(spec); return () => {} } },
        })
      }
    },
    _listeners: listeners,
    _warnings: warnings,
    _disposers: disposers,
    _webServer: webServer,
  }
  return ctx
}

function makeAgent(cwd, sessionId = 'sess-1') {
  const injected = []
  const steered = []
  const followed = []
  return {
    session: {
      header: { id: sessionId, cwd },
      events: [],
      append: () => {},
    },
    inject: (message) => injected.push(message),
    steer: (message) => steered.push(message),
    followup: (message) => followed.push(message),
    _injected: injected,
    _steered: steered,
    _followed: followed,
  }
}

const EMPTY = { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Drive the plugin's notice route with a fake HTTP pair. */
async function requestNotices(spec, sessionId, headers = { 'x-cc-hooks': '1' }) {
  const response = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  }
  await spec.handler({
    url: `/cc-hooks/notices?sessionId=${encodeURIComponent(sessionId)}`,
    method: 'GET',
    headers,
  }, response)
  return { status: response.status, body: JSON.parse(response.body) }
}

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

/** Apply the plugin, announce the agent, and wait for the config preload. */
async function start({ home, run, agent, agents, shellDialect }) {
  const ctx = makeCtx(run, agents)
  apply(ctx, {
    enableGlobal: false,
    homeDir: home,
    // Tests pin the dialect: `auto` probes through the shell mock, which would
    // record an extra run and skew the payload assertions.
    shellDialect: shellDialect ?? 'posix',
  })
  await ctx._listeners['agent/session-start']({ agent, source: 'startup' })
  await sleep(300)
  return ctx
}

function execFor(agent, name, args) {
  return { name, arguments: args, callId: `c-${Math.random().toString(36).slice(2)}`, agent, signal: new AbortController().signal }
}

// ─── 1. PostToolBatch ───────────────────────────────────────────────────────

test('W2: PostToolBatch synthesizes tool_calls from the previous step', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({ PostToolBatch: [{ hooks: [{ type: 'command', command: 'batch-check' }] }] })
  try {
    const rec = recorder()
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })
    agent.session.events.push(
      // A call from another turn must not leak into this batch (the log is
      // chronological, so older entries come first).
      { type: 'tool/call', data: { turn: 1, step: 4, callId: 'old', name: 'bash', arguments: '{"command":"pwd"}' } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } } },
    )

    let nextCalled = false
    const decision = await ctx._listeners['agent/pre-step'](
      { agent, messages: [], turn: 2, step: 2, signal: new AbortController().signal },
      async () => { nextCalled = true; return { kind: 'enter', messages: [] } },
    )

    assert.equal(nextCalled, true)
    assert.equal(decision.kind, 'enter')
    assert.equal(rec.runs.length, 1)
    assert.equal(rec.runs[0].payload.hook_event_name, 'PostToolBatch')
    assert.deepEqual(rec.runs[0].payload.tool_calls, [{
      tool_name: 'bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'c1',
      tool_response: 'a.txt',
    }])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('W2: PostToolBatch block rejects the step and leaves an English notice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({ PostToolBatch: [{ hooks: [{ type: 'command', command: 'batch-check' }] }] })
  try {
    const rec = recorder()
    let exitCode = 0
    let stdout = '{"decision":"block","reason":"touching legacy code"}'
    let stderr = ''
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode, stdout: { text: stdout }, stderr: { text: stderr } }
    }
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })
    agent.session.events.push(
      { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } } },
    )

    const decision = await ctx._listeners['agent/pre-step'](
      { agent, messages: [], turn: 2, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )

    assert.deepEqual(decision, { kind: 'reject' })
    assert.equal(agent._injected.length, 1, 'the model gets the stop reason as context')
    assert.equal(agent._injected[0].source.form, 'notice')
    assert.match(
      agent._injected[0].content[0].text,
      /^Execution stopped by PostToolBatch hook: touching legacy code\nThe turn was stopped;/,
    )

    // The browser half reads the human-facing notice from the plugin route.
    const spec = ctx._webServer[0]
    assert.equal(spec.path, '/cc-hooks')
    const first = await requestNotices(spec, 'sess-1')
    assert.equal(first.status, 200)
    assert.equal(first.body.value.notices.length, 1)
    assert.equal(first.body.value.notices[0].text, 'Execution stopped by PostToolBatch hook: touching legacy code')
    const refused = await requestNotices(spec, 'sess-1', {})
    assert.equal(refused.status, 403, 'another origin cannot read the notices')

    // Re-entering the same step must not duplicate the notice or the context.
    const repeat = await ctx._listeners['agent/pre-step'](
      { agent, messages: [], turn: 2, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.deepEqual(repeat, { kind: 'reject' })
    assert.equal(agent._injected.length, 1, 'a re-entered step injects nothing new')
    assert.equal((await requestNotices(spec, 'sess-1')).body.value.notices.length, 1)

    // The fallback text is CC's own when the hook supplies no reason.
    exitCode = 2
    stdout = ''
    stderr = ''
    agent.session.events.push(
      { type: 'tool/call', data: { turn: 2, step: 2, callId: 'c2', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', data: { turn: 2, step: 2, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'b.txt' }] } } },
    )
    const second = await ctx._listeners['agent/pre-step'](
      { agent, messages: [], turn: 2, step: 3, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.deepEqual(second, { kind: 'reject' })
    const secondNotices = await requestNotices(spec, 'sess-1')
    assert.equal(secondNotices.body.value.notices.length, 2)
    assert.equal(secondNotices.body.value.notices[1].text, 'Execution stopped by PostToolBatch hook')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('W2: PostToolBatch additionalContext rides the enter decision', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({ PostToolBatch: [{ hooks: [{ type: 'command', command: 'batch-note' }] }] })
  try {
    const context = '{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":"These files belong to the ledger module."}}'
    const rec = recorder()
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 0, stdout: { text: context }, stderr: { text: '' } }
    }
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })
    agent.session.events.push(
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] } } },
    )

    const decision = await ctx._listeners['agent/pre-step'](
      { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1)
    assert.equal(decision.messages[0].content[0].text, 'These files belong to the ledger module.')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// ─── 2/3. TaskCreated / TaskCompleted ──────────────────────────────────────

test('W2: TaskCreated fires for new todo entries and denies the whole write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({ TaskCreated: [{ hooks: [{ type: 'command', command: 'task-created' }] }] })
  try {
    const rec = recorder()
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 2, stdout: { text: '' }, stderr: { text: 'subjects need a [TICKET-123] prefix' } }
    }
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })
    agent.session.events.push({
      type: 'todo/write',
      data: { todos: [{ content: 'existing task', status: 'pending' }] },
    })

    const decision = await ctx._listeners['tools/pre-execute'](
      execFor(agent, 'todo_write', {
        todos: [
          { content: 'existing task', status: 'pending' },
          { content: 'new task', status: 'pending' },
        ],
      }),
      async () => ({ kind: 'allow' }),
    )

    assert.equal(decision.kind, 'deny')
    assert.equal(decision.reason, 'TaskCreated hook blocked creating "new task": subjects need a [TICKET-123] prefix')
    assert.equal(rec.runs.length, 1)
    assert.equal(rec.runs[0].payload.hook_event_name, 'TaskCreated')
    assert.equal(rec.runs[0].payload.task_id, 'todo-2')
    assert.equal(rec.runs[0].payload.task_subject, 'new task')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('W2: an unchanged todo list fires nothing and delegates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({
    TaskCreated: [{ hooks: [{ type: 'command', command: 'task-created' }] }],
    TaskCompleted: [{ hooks: [{ type: 'command', command: 'task-completed' }] }],
  })
  try {
    const rec = recorder()
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })
    agent.session.events.push({
      type: 'todo/write',
      data: { todos: [{ content: 'same task', status: 'pending' }] },
    })

    let nextCalled = false
    const decision = await ctx._listeners['tools/pre-execute'](
      execFor(agent, 'todo_write', { todos: [{ content: 'same task', status: 'pending' }] }),
      async () => { nextCalled = true; return { kind: 'allow' } },
    )

    assert.deepEqual(decision, { kind: 'allow' })
    assert.equal(nextCalled, true)
    assert.equal(rec.runs.length, 0, 'no diff, no task hook')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('W2: TaskCompleted fires on the pending → completed transition', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({ TaskCompleted: [{ hooks: [{ type: 'command', command: 'task-completed' }] }] })
  try {
    const rec = recorder()
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 2, stdout: { text: '' }, stderr: { text: 'tests are failing' } }
    }
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })
    agent.session.events.push({
      type: 'todo/write',
      data: { todos: [{ content: 'add login', status: 'in_progress' }] },
    })

    const decision = await ctx._listeners['tools/pre-execute'](
      execFor(agent, 'todo_write', { todos: [{ content: 'add login', status: 'completed' }] }),
      async () => ({ kind: 'allow' }),
    )

    assert.equal(decision.kind, 'deny')
    assert.equal(decision.reason, 'TaskCompleted hook blocked completing "add login": tests are failing')
    assert.equal(rec.runs[0].payload.task_subject, 'add login')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('W2: a pwsh hook exit 2 keeps its blocking meaning', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({ TaskCreated: [{ hooks: [{ type: 'command', command: 'task-created' }] }] })
  try {
    const rec = recorder()
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 2, stdout: { text: '' }, stderr: { text: 'blocked by exit 2' } }
    }
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent, shellDialect: 'pwsh' })
    agent.session.events.push({ type: 'todo/write', data: { todos: [] } })

    const decision = await ctx._listeners['tools/pre-execute'](
      execFor(agent, 'todo_write', { todos: [{ content: 'new task', status: 'pending' }] }),
      async () => ({ kind: 'allow' }),
    )

    assert.equal(decision.kind, 'deny')
    assert.match(rec.runs[0].command, /^\$global:LASTEXITCODE = 0; .*; exit \$LASTEXITCODE$/, 'pwsh must re-export the native exit code')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// ─── 4. UserPromptExpansion ────────────────────────────────────────────────
test('W2: UserPromptExpansion observes command/run and injects its context', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({
    UserPromptExpansion: [{ matcher: 'mcp', hooks: [{ type: 'command', command: 'expand' }] }],
  })
  try {
    const context = '{"hookSpecificOutput":{"hookEventName":"UserPromptExpansion","additionalContext":"MCP list is long; summarize it."}}'
    const rec = recorder()
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 0, stdout: { text: context }, stderr: { text: '' } }
    }
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })

    ctx._listeners['session/event'](agent.session, {
      type: 'command/run',
      data: { commandId: 'cmd-1', name: 'mcp', args: 'list', source: { kind: 'user' } },
    })
    await sleep(300)

    assert.equal(rec.runs.length, 1)
    assert.deepEqual(rec.runs[0].payload, {
      session_id: 'sess-1',
      transcript_path: '',
      cwd: project,
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'mcp',
      command_args: 'list',
      command_source: 'user',
      prompt: '',
    })
    assert.equal(agent._injected.length, 1)
    assert.equal(agent._injected[0].content[0].text, 'MCP list is long; summarize it.')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('W2: a UserPromptExpansion block is reported as degradation, not crash', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({
    UserPromptExpansion: [{ hooks: [{ type: 'command', command: 'expand-block' }] }],
  })
  try {
    const rec = recorder()
    rec.run = async (req) => {
      rec.runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return { exitCode: 0, stdout: { text: '{"decision":"block","reason":"no"}' }, stderr: { text: '' } }
    }
    const agent = makeAgent(project)
    const ctx = await start({ home, run: rec.run, agent })

    ctx._listeners['session/event'](agent.session, {
      type: 'command/run',
      data: { commandId: 'cmd-2', name: 'goal', source: { kind: 'user' } },
    })
    await sleep(300)

    assert.ok(ctx._warnings.some((line) => /UserPromptExpansion cannot block/.test(line)))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// ─── 5. Notification ───────────────────────────────────────────────────────

test('W2: Notification fires for permission prompts and subagent completion, deduped', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w2-home-'))
  const project = makeProject({
    Notification: [{ matcher: 'permission_prompt|agent_completed', hooks: [{ type: 'command', command: 'notify' }] }],
  })
  try {
    const rec = recorder()
    const agent = makeAgent(project)
    const child = makeAgent(project, 'child-1')
    const agents = new Map([['child-1', child]])
    const ctx = await start({ home, run: rec.run, agent, agents })
    const event = ctx._listeners['session/event']

    event(agent.session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
    await sleep(300)
    assert.equal(rec.runs.length, 1)
    assert.equal(rec.runs[0].payload.hook_event_name, 'Notification')
    assert.equal(rec.runs[0].payload.notification_type, 'permission_prompt')
    assert.equal(rec.runs[0].payload.message, 'Claude needs your permission to use bash')
    assert.equal(rec.runs[0].payload.title, 'Claude Code')

    // The same logical notification inside the 1s window is collapsed.
    event(agent.session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
    await sleep(100)
    assert.equal(rec.runs.length, 1)

    ctx._listeners['subagent/end']({ runId: 'r1', id: 'child-1', provider: 'local', local: true, stopReason: 'completed' })
    await sleep(300)
    assert.equal(rec.runs.length, 2)
    assert.equal(rec.runs[1].payload.notification_type, 'agent_completed')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
