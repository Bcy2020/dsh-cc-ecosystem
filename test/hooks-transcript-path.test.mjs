// Regression tests for cc-hooks' `transcript_path` resolution.
//
// DSH 0.1.5's public `SessionPersistence` service exposes only
// create/open/flush/stat/list — NO artifact-path accessor. The JSONL backend's
// `locate` is a TypeScript `private` method, so it is not part of the contract
// and another provider may not implement it.
//
// The old expression was:
//
//     ctx.get('sessionPersistence')?.locate(session.header)?.path ?? ''
//
// The optional chain guards the SERVICE, not the method. With the service
// registered — the normal case — `locate` is read and CALLED, so a provider
// without it threw `TypeError: …locate is not a function` synchronously inside
// every payload builder (`base()`), which SessionStart, UserPromptSubmit,
// PreToolUse, PostToolUse, Stop, SessionEnd and the compact hooks all use.
//
// These tests drive the real `apply()` + a PreToolUse command hook that echoes
// its stdin, and vary only the `sessionPersistence` service object.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../packages/cc-hooks/src/index.js'

function runShell(req) {
  return new Promise((resolve) => {
    const child = spawn(req.command, { cwd: req.workdir, shell: true, env: { ...process.env, ...req.env } })
    child.unref()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ exitCode: code, stdout: { text: stdout }, stderr: { text: stderr } }))
    child.stdin.end(req.stdin ?? '')
    const killTimer = setTimeout(() => {
      child.kill()
      resolve({ exitCode: null, stdout: { text: stdout }, stderr: { text: stderr + '\n[timed out]' } })
    }, 8000)
    child.on('close', () => clearTimeout(killTimer))
  })
}

/** A ctx whose `sessionPersistence` service is `persistence`. */
function makeCtx(persistence) {
  const listeners = {}
  const warnings = []
  return {
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
    shell: { resolve: (req) => req, run: runShell },
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
    on: (event, handler) => { listeners[event] = handler },
    effect: () => {},
    _listeners: listeners,
    _warnings: warnings,
  }
}

/** A throwaway project with a PreToolUse command hook capturing its stdin. */
function buildProject() {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-tpath-'))
  const hooksDir = join(project, '.claude', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  const capture = join(project, 'capture.json')
  const script = join(hooksDir, 'capture.cjs')
  writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], require('node:fs').readFileSync(0, 'utf8'))\n")
  writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${script}" "${capture}"` }] }] },
  }, null, 2))
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, '.git', 'marker'), '')
  return { project, capture }
}

/** Legacy-shaped session (the reader is not what this file tests). */
function fakeAgent(cwd) {
  return {
    session: {
      header: { id: 'sess-tpath', cwd },
      surface: { nodes: [] },
      events: [{ type: 'turn/start', data: { turn: 1 } }],
      append: () => {},
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Drive one PreToolUse through the real plugin and return the captured payload.
 * @param {object} persistence - the value `ctx.get('sessionPersistence')` returns.
 */
async function capturedPayload(persistence) {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
  const { project, capture } = buildProject()
  try {
    const ctx = makeCtx(persistence)
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })
    const agent = fakeAgent(project)
    const decision = await ctx._listeners['tools/pre-execute']({
      agent,
      name: 'bash',
      arguments: { command: 'ls' },
      callId: 'c1',
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'allow' }))
    await sleep(600)
    return {
      payload: JSON.parse(readFileSync(capture, 'utf8')),
      decision,
      warnings: ctx._warnings,
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
}

test('transcript_path: a service WITHOUT locate degrades to "" instead of throwing', async () => {
  // This is the regression: the abstract SessionPersistence contract in DSH
  // 0.1.5 has no `locate`, so a conforming provider looks exactly like this.
  const { payload, decision } = await capturedPayload({})
  assert.equal(payload.hook_event_name, 'PreToolUse')
  assert.equal(payload.transcript_path, '')
  assert.equal(decision.kind, 'allow', 'the hook still ran to completion')
})

test('transcript_path: an absent service degrades to ""', async () => {
  const { payload } = await capturedPayload(undefined)
  assert.equal(payload.transcript_path, '')
})

test('transcript_path: a throwing locate degrades to ""', async () => {
  const { payload } = await capturedPayload({
    locate() { throw new Error('backend exploded') },
  })
  assert.equal(payload.transcript_path, '')
})

test('transcript_path: a locate returning a malformed value degrades to ""', async () => {
  assert.equal((await capturedPayload({ locate: () => undefined })).payload.transcript_path, '')
  assert.equal((await capturedPayload({ locate: () => ({}) })).payload.transcript_path, '')
  assert.equal((await capturedPayload({ locate: () => null })).payload.transcript_path, '')
})

test('transcript_path: a working locate still populates the field', async () => {
  const { payload } = await capturedPayload({
    locate: (header) => ({ path: `X:/sessions/${header.id}.jsonl` }),
  })
  assert.equal(payload.transcript_path, 'X:/sessions/sess-tpath.jsonl',
    'the field is preserved where the backend genuinely exposes it')
})

test('transcript_path: a non-function locate property is not called', async () => {
  const { payload } = await capturedPayload({ locate: 'not-a-function' })
  assert.equal(payload.transcript_path, '')
})

test('the previously-crashing expression really does throw on a locate-less provider', () => {
  // Documents exactly what the fix removes: `?.` guards the SERVICE, not the
  // method, so the member is still read and invoked.
  const persistence = {}
  assert.throws(() => persistence?.locate({ id: 'x' })?.path ?? '', TypeError)
})
