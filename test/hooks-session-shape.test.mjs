// Regression tests for cc-hooks' two session-log readers under BOTH DSH
// session shapes.
//
// `lastTurn(agent)` and `lastAssistantMessage(agent)` used to be
// `[...agent.session.events].findLast(...)`. `Session.events` was removed in
// DSH 0.1.2-alpha.4, so on 0.1.5 both threw
// "agent.session.events is not iterable" — the exact crash reported at
// runtime. They now read through `sessionLastEvent()`.
//
// Coverage is end-to-end through the real `apply()` wiring, with a fake
// session object (no DSH process):
//   - lastTurn             → observed on the appended `hook/invoked.turn`
//   - lastAssistantMessage → observed on the Stop hook's stdin payload

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../packages/cc-hooks/src/index.js'

const REPLY = '我修改了 README.md，但没有同步 hot.md。'

/** The event log both shapes serve, with turn 3 open and one assistant reply. */
function buildLog() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'turn/start', data: { turn: 3 } },
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'internal chain that must not leak' },
            { type: 'text', text: REPLY },
          ],
        },
      },
    },
  ]
}

/**
 * A session in one of the two host shapes. `kind === 'new'` exposes only the
 * 0.1.5 readers and has NO `events` property, like a real 0.1.5 session.
 */
function fakeSession(cwd, kind, appended) {
  const log = buildLog()
  const base = {
    header: { id: 'sess-shape', cwd },
    surface: { nodes: [] },
    append: (type, data) => { appended.push({ type, data }) },
  }
  if (kind === 'legacy') return { ...base, events: log }
  return {
    ...base,
    get seq() { return log.length },
    eventAt(seq) { return log[seq] },
    snapshotEvents(from = 0, to = log.length) { return Object.freeze(log.slice(from, to)) },
  }
}

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
  return {
    logger: { info: () => {}, warn: () => {} },
    shell: { resolve: (req) => req, run: runShell },
    get: () => undefined,
    on: (event, handler) => { listeners[event] = handler },
    effect: () => {},
    _listeners: listeners,
  }
}

/** A throwaway project: a PreToolUse no-op hook and a Stop capture hook. */
function buildProject() {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-shape-'))
  const hooksDir = join(project, '.claude', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  const capture = join(project, 'capture.json')
  const captureScript = join(hooksDir, 'capture.cjs')
  const noopScript = join(hooksDir, 'noop.cjs')
  writeFileSync(captureScript, "require('node:fs').writeFileSync(process.argv[2], require('node:fs').readFileSync(0, 'utf8'))\n")
  writeFileSync(noopScript, 'process.exit(0)\n')
  writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${noopScript}"` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `node "${captureScript}" "${capture}"` }] }],
    },
  }, null, 2))
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, '.git', 'marker'), '')
  return { project, capture }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const kind of ['new', 'legacy']) {
  const label = kind === 'new' ? '0.1.5 session (snapshotEvents/eventAt)' : 'legacy session (events array)'

  test(`lastTurn reads the newest turn/start — ${label}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
    const { project } = buildProject()
    try {
      const ctx = makeCtx()
      apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
      const appended = []
      const agent = { session: fakeSession(project, kind, appended) }

      await ctx._listeners['tools/pre-execute']({
        agent,
        name: 'bash',
        arguments: { command: 'ls' },
        callId: 'c1',
        signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'allow' }))
      await sleep(500)

      const invoked = appended.filter((e) => e.type === 'hook/invoked')
      assert.ok(invoked.length >= 1, `expected a hook/invoked append, got ${JSON.stringify(appended.map((e) => e.type))}`)
      assert.equal(invoked[0].data.turn, 3, 'newest turn/start is turn 3')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
  })

  test(`lastAssistantMessage reads the newest assistant reply — ${label}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
    const { project, capture } = buildProject()
    try {
      const ctx = makeCtx()
      apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
      const appended = []
      const agent = { session: fakeSession(project, kind, appended) }

      ctx._listeners['agent/session-start']({ agent, source: 'test' })
      await sleep(400)
      await ctx._listeners['agent/turn-stopping']({
        agent, turn: 3, signal: new AbortController().signal,
      })
      await sleep(400)

      const payload = JSON.parse(readFileSync(capture, 'utf8'))
      assert.equal(payload.hook_event_name, 'Stop')
      assert.equal(payload.last_assistant_message, REPLY,
        'text blocks only — the reasoning block must not leak')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
  })
}

test('the readers are total: a session with no readable log yields the neutral values', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
  const { project, capture } = buildProject()
  try {
    const ctx = makeCtx()
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
    // A session exposing neither reader — the pre-0.1.2 shape minus `events`,
    // i.e. whatever a future host might hand us. Must degrade, never throw.
    const agent = { session: { header: { id: 's', cwd: project }, append: () => {} } }

    ctx._listeners['agent/session-start']({ agent, source: 'test' })
    await sleep(400)
    await ctx._listeners['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    await sleep(400)

    const payload = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(payload.last_assistant_message, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
