// cc-hooks Stop/SubagentStop payload contract: the CC dialect Stop input must
// carry `last_assistant_message` (the text of the agent's final reply) so a
// prompt/agent Stop hook can judge the just-completed turn without parsing the
// transcript. Regression: without the field a prompt-type Stop hook cannot see
// what the agent did and defaults to {"ok":true} (pass), so a turn that made
// meaningful changes without syncing hot.md is never blocked.
//
// Self-contained: builds a throwaway project with a Stop command hook that
// echoes its stdin payload to a capture file, drives the real `apply()` with
// the minimal mock ctx, then asserts on the captured payload.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../packages/cc-hooks/src/index.js'

function runShell(req) {
  return new Promise((resolve) => {
    const child = spawn(req.command, {
      cwd: req.workdir,
      shell: true,
      env: { ...process.env, ...req.env },
    })
    child.unref()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ exitCode: code, stdout: { text: stdout }, stderr: { text: stderr } }))
    if (req.stdin !== undefined && req.stdin !== '') child.stdin.end(req.stdin)
    else child.stdin.end()
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

function makeAgent(cwd, { withLastReply = true, sessionApi = 'events' } = {}) {
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  if (withLastReply) {
    events.push({
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'internal chain that must not leak into last_assistant_message' },
            { type: 'text', text: '我修改了 README.md，但没有同步 hot.md。' },
          ],
        },
      },
    })
  }
  // The 0.1.0/0.1.2 hosts expose the log as `session.events`; dsh 0.1.5
  // replaced that getter with `snapshotEvents()`. Both return the same frozen
  // snapshot, and the bridge must read history on either.
  const header = { id: 'sess-stop', cwd }
  const session = sessionApi === 'snapshotEvents'
    ? { header, snapshotEvents: () => Object.freeze([...events]), append: () => {} }
    : { header, events, append: () => {} }
  return {
    session,
    inject: () => {},
    steer: () => {},
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Build a throwaway project whose Stop hook writes its stdin payload to `capture`. */
function buildProject() {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-stop-payload-'))
  const hooksDir = join(project, '.claude', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  const capture = join(project, 'capture.json')
  const captureScript = join(hooksDir, 'capture.cjs')
  writeFileSync(captureScript, `require('node:fs').writeFileSync(process.argv[2], require('node:fs').readFileSync(0, 'utf8'))\n`)
  writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: `node "${captureScript}" "${capture}"` }] }],
    },
  }, null, 2))
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, '.git', 'marker'), '') // project-root marker
  return { project, capture }
}

test('Stop payload carries last_assistant_message (text blocks only, no reasoning)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
  const { project, capture } = buildProject()
  try {
    const ctx = makeCtx()
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
    const L = ctx._listeners

    const agent = makeAgent(project)
    L['agent/session-start']({ agent, source: 'test' })
    await sleep(400)

    await L['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    await sleep(300)

    const payload = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(payload.hook_event_name, 'Stop')
    assert.equal(payload.last_assistant_message, '我修改了 README.md，但没有同步 hot.md。')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('Stop payload reads history through snapshotEvents() (dsh 0.1.5 hosts)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
  const { project, capture } = buildProject()
  try {
    const ctx = makeCtx()
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
    const L = ctx._listeners

    const agent = makeAgent(project, { sessionApi: 'snapshotEvents' })
    L['agent/session-start']({ agent, source: 'test' })
    await sleep(400)

    await L['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    await sleep(300)

    const payload = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(payload.hook_event_name, 'Stop')
    // Without the port this is '' — the hook fires but sees nothing.
    assert.equal(payload.last_assistant_message, '我修改了 README.md，但没有同步 hot.md。')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('Stop payload with no prior assistant reply sends an empty last_assistant_message', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
  const { project, capture } = buildProject()
  try {
    const ctx = makeCtx()
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
    const L = ctx._listeners

    const agent = makeAgent(project, { withLastReply: false })
    L['agent/session-start']({ agent, source: 'test' })
    await sleep(400)

    await L['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    await sleep(300)

    const payload = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(payload.last_assistant_message, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
