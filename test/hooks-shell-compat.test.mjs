// Regression tests for cc-hooks' shell-executor compatibility boundary.
//
// `@deepseek-ai/dsh-hook-protocol`'s `runHook()` used to own the host shell
// call. That call changed in DSH 0.2.0:
//
//     0.1.5-rc.2   const result = await bash.run(bash.resolve(request))
//     0.2.0-rc.2   const result = await (await bash.execute(bash.resolve(request))).result()
//
// The two protocol releases are byte-identical apart from that line, so no
// dependency range can satisfy both hosts. cc-hooks now owns the call in
// `shell-compat.js` and picks `execute` or `run` by feature detection.
//
// These tests drive that boundary directly against fake shell services shaped
// like each host generation, and assert the request handed to the host is
// unchanged (timeout, stdin framing, workdir/env passthrough).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runShellHook } from '../packages/cc-hooks/src/shell-compat.js'

const NOW = () => 1000

/** Build a fake shell service; `kind` selects the host generation's surface. */
function fakeShell(kind, result = { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) {
  const seen = []
  const shell = {
    resolve(request) {
      seen.push(request)
      return { ...request, resolved: true }
    },
  }
  if (kind === 'execute') {
    shell.execute = async () => ({ result: async () => result })
  } else if (kind === 'execute-direct') {
    // Defensive: an `execute` that resolves to a bare result, no `result()`.
    shell.execute = async () => result
  } else if (kind === 'run') {
    shell.run = async () => result
  }
  return { shell, seen }
}

const HOOK = { command: 'echo hi' }
const OPTIONS = { payload: { a: 1 }, defaultTimeoutMs: 600_000, trailingNewline: true }

test('prefers execute (0.2.0 host) and parses the result', async () => {
  const { shell, seen } = fakeShell('execute', {
    exitCode: 0,
    stdout: { text: '{"decision":"block","reason":"no"}' },
    stderr: { text: 'warned' },
  })
  const { output, durationMs } = await runShellHook(shell, HOOK, OPTIONS, NOW)
  assert.equal(seen.length, 1)
  assert.equal(output.exitCode, 0)
  assert.equal(output.decision, 'block')
  assert.equal(output.reason, 'no')
  assert.equal(output.stderr, 'warned')
  assert.equal(typeof durationMs, 'number')
})

test('falls back to run (0.1.5 host)', async () => {
  const { shell, seen } = fakeShell('run', { exitCode: 2, stdout: { text: '' }, stderr: { text: 'boom' } })
  const { output } = await runShellHook(shell, HOOK, OPTIONS, NOW)
  assert.equal(seen.length, 1)
  assert.equal(output.exitCode, 2)
  assert.equal(output.reason, 'boom')
})

test('accepts an execute that resolves to a bare result', async () => {
  const { shell } = fakeShell('execute-direct', { exitCode: 0, stdout: { text: 'ok' }, stderr: { text: '' } })
  const { output } = await runShellHook(shell, HOOK, OPTIONS, NOW)
  assert.equal(output.exitCode, 0)
  assert.equal(output.stdout, 'ok')
})

test('execute wins when the host exposes both', async () => {
  const { shell } = fakeShell('run')
  let executed = false
  shell.execute = async () => {
    executed = true
    return { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }
  }
  await runShellHook(shell, HOOK, OPTIONS, NOW)
  assert.equal(executed, true)
})

test('a shell exposing neither reader degrades to an error output, never throws', async () => {
  const shell = { resolve: (request) => request }
  const { output } = await runShellHook(shell, HOOK, OPTIONS, NOW)
  assert.equal(output.exitCode, undefined)
  assert.match(output.stderr, /is not a function/)
})

test('a throwing executor degrades to an error output', async () => {
  const shell = {
    resolve: (request) => request,
    run: async () => {
      throw new Error('executor exploded')
    },
  }
  const { output } = await runShellHook(shell, HOOK, OPTIONS, NOW)
  assert.equal(output.exitCode, undefined)
  assert.equal(output.stderr, 'executor exploded')
})

test('hook timeoutSec wins over the event default and stdin keeps CC framing', async () => {
  const { shell, seen } = fakeShell('run')
  await runShellHook(shell, { command: 'x', timeoutSec: 5 }, OPTIONS, NOW)
  assert.equal(seen[0].timeoutMs, 5_000)
  assert.equal(seen[0].stdin, JSON.stringify({ a: 1 }) + '\n')
})

test('cwd and env pass through as workdir/env; absent ones stay absent', async () => {
  const { shell, seen } = fakeShell('run')
  await runShellHook(
    shell,
    HOOK,
    { ...OPTIONS, cwd: '/tmp/work', env: { K: 'v' }, trailingNewline: false },
    NOW,
  )
  assert.equal(seen[0].workdir, '/tmp/work')
  assert.deepEqual(seen[0].env, { K: 'v' })
  assert.equal(seen[0].stdin, JSON.stringify({ a: 1 }))

  const bare = fakeShell('run')
  await runShellHook(bare.shell, HOOK, { payload: {}, defaultTimeoutMs: 1 }, NOW)
  assert.equal('workdir' in bare.seen[0], false)
  assert.equal('env' in bare.seen[0], false)
})
