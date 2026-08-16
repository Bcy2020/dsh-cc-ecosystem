// Integration test for dsh-cc-hooks wiring: drives the real `apply()` with a
// minimal mock ctx against the real cc-demo-project hook assets
// (guard-rm.mjs / annotate.mjs), asserting:
//   - PreToolUse deny on rm (guard exit 2)
//   - PreToolUse pass-through on git status (guard exit 0)
//   - PostToolUse additionalContext injection ([hook note])
//   - UserPromptSubmit pass-through (no hook configured)
//   - per-session discovery + caching (configFor hit)
// No GUI / host runtime needed; the shell mock executes the hook commands
// for real with the session workspace as cwd.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../packages/cc-hooks/src/index.js'

const demoRoot = join(import.meta.dirname, '..', '..', 'cc-demo-project') // teno/cc-demo-project

// ─── harness mocks ───────────────────────────────────────────────────────────

function runShell(req) {
  return new Promise((resolve) => {
    const child = spawn(req.command, {
      cwd: req.workdir,
      shell: true,
      env: { ...process.env, ...req.env },
    })
    // A Windows `shell: true` spawn can leak a console/stdio handle that keeps
    // the parent process alive; the hook result is what we await, so unref.
    child.unref()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ exitCode: code, stdout: { text: stdout }, stderr: { text: stderr } }))
    if (req.stdin !== undefined && req.stdin !== '') child.stdin.end(req.stdin)
    else child.stdin.end()
    // Guard against a wedged stdin/stdout pipe wedging the whole suite.
    const killTimer = setTimeout(() => {
      child.kill()
      resolve({ exitCode: null, stdout: { text: stdout }, stderr: { text: stderr + '\n[hook-run timed out]' } })
    }, 8000)
    child.on('close', () => clearTimeout(killTimer))
  })
}

function makeCtx() {
  const listeners = {}
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    shell: { resolve: (req) => req, run: runShell },
    get: () => undefined,
    on: (event, handler) => { listeners[event] = handler },
    effect: (fn) => { disposers.push(fn) },
    _listeners: listeners,
    _disposers: disposers,
  }
  return ctx
}

function makeAgent(cwd, sessionId = 'sess-1') {
  const injected = []
  const steered = []
  return {
    session: {
      header: { id: sessionId, cwd },
      events: [],
      append: () => {},
    },
    inject: (msg) => injected.push(msg),
    steer: (msg) => steered.push(msg),
    _injected: injected,
    _steered: steered,
  }
}

function execFor(agent, name, args) {
  return {
    name,
    arguments: args,
    callId: `c-${Math.random().toString(36).slice(2)}`,
    agent,
    signal: new AbortController().signal,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('integration: PreToolUse denies rm, passes git status; PostToolUse injects context', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
  try {
    const ctx = makeCtx()
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
    const L = ctx._listeners
    assert.ok(L['agent/session-start'])
    assert.ok(L['agent/pre-step'])
    assert.ok(L['tools/pre-execute'])
    assert.ok(L['tools/post-execute'])
    assert.ok(L['agent/turn-stopping'])
    assert.ok(L['subagent/start'])
    assert.ok(L['subagent/end'])

    const agent = makeAgent(demoRoot)
    L['agent/session-start']({ agent, source: 'test' })
    await sleep(400) // let the detached session-start discovery settle

    // PreToolUse: rm → deny by the guard hook.
    const rmExec = execFor(agent, 'bash', { command: 'rm -rf sample/' })
    let rmNextCalled = false
    const rmDecision = await L['tools/pre-execute'](rmExec, async () => { rmNextCalled = true; return { kind: 'allow' } })
    assert.equal(rmDecision.kind, 'deny')
    assert.match(rmDecision.reason, /Deleting files is forbidden/)
    assert.equal(rmNextCalled, false, 'deny must not delegate to next()')

    // PreToolUse: git status → hook passes, next() runs, allow returned.
    const gitExec = execFor(agent, 'bash', { command: 'git status' })
    let gitNextCalled = false
    const gitDecision = await L['tools/pre-execute'](gitExec, async () => { gitNextCalled = true; return { kind: 'allow' } })
    assert.equal(gitNextCalled, true)
    assert.equal(gitDecision.kind, 'allow')

    // PostToolUse: annotate.mjs appends additionalContext → injected message.
    const result = { content: [{ type: 'text', text: 'ok' }] }
    const postDecision = await L['tools/post-execute'](gitExec, result, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] }))
    assert.equal(postDecision.kind, 'accept')
    assert.ok(Array.isArray(postDecision.additionalContexts))
    const note = postDecision.additionalContexts.find((m) => m.source?.plugin === 'cc-hooks')
    assert.ok(note, 'PostToolUse context must be injected with the cc-hooks source')
    assert.match(note.content.map((b) => b.text).join(''), /\[hook note\]/)

    // UserPromptSubmit: demo config has a context-note hook → context appended
    // to the downstream enter decision.
    const preStep = await L['agent/pre-step'](
      { agent, messages: [{ content: [{ type: 'text', text: 'hi' }] }], turn: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: 'hi' }] }] }),
    )
    assert.equal(preStep.kind, 'enter')
    assert.equal(preStep.messages.length, 2, 'UserPromptSubmit context note appended')
    assert.match(preStep.messages[1].content.map((b) => b.text).join(''), /\[hook note\] UserPromptSubmit/)

    // Per-session cache: a second session on the same cwd reuses the entry.
    const agent2 = makeAgent(demoRoot, 'sess-2')
    L['agent/session-start']({ agent: agent2, source: 'test' })
    await sleep(200)
    const git2 = execFor(agent2, 'pwsh', { command: 'Get-ChildItem' })
    const d2 = await L['tools/pre-execute'](git2, async () => ({ kind: 'allow' }))
    assert.equal(d2.kind, 'allow')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
