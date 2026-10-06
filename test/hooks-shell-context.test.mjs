// cc-hooks' command-hook wiring, driven through the real `apply()`:
//   1. the calling session's sandbox policy travels with every hook request
//      (without it the executor sands against its deployment root, and on
//      Windows the ACL runner refuses the hook);
//   2. CLAUDE_PLUGIN_ROOT reaches the hook's environment, not just its command
//      text — Claude Code sets it there, and some plugins read it;
//   3. a leading quoted command is made callable when the host shell is
//      PowerShell, and left alone when it is POSIX.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../packages/cc-hooks/src/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeProject(hooksMap) {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-shellctx-'))
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true })
  writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: hooksMap }))
  return project
}

/**
 * A ctx whose shell records every resolved request. `policy` is the
 * `sandboxPolicy` service (or undefined to model a host without one).
 */
function makeCtx(policy) {
  const listeners = {}
  const requests = []
  const resolvedWith = []
  return {
    logger: { info: () => {}, warn: () => {} },
    shell: {
      resolve: (request) => {
        requests.push(request)
        return request
      },
      run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }),
    },
    get: (name) => {
      if (name !== 'sandboxPolicy') return undefined
      if (policy === undefined) return undefined
      return {
        resolve: (request) => {
          resolvedWith.push(request)
          return policy
        },
      }
    },
    on: (event, handler) => { listeners[event] = handler },
    effect: () => {},
    _listeners: listeners,
    _requests: requests,
    _resolvedWith: resolvedWith,
  }
}

function makeAgent(cwd) {
  return { session: { header: { id: 'sess-1', cwd }, events: [], append: () => {} } }
}

/** Apply the plugin, fire SessionStart, and return the ctx for inspection. */
async function runSessionStart(hooksMap, { config = {}, policy } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'))
  const project = makeProject(hooksMap)
  const ctx = makeCtx(policy)
  apply(ctx, {
    enableGlobal: false,
    homeDir: home,
    projectRootMarkers: ['.git'],
    shellDialect: 'posix', // keeps the probe off this path unless a test says otherwise
    ...config,
  })
  await ctx._listeners['agent/session-start']({ agent: makeAgent(project), source: 'startup' })
  await sleep(300)
  return { ctx, project, home }
}

const STARTUP_ECHO = { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }] }

test('the session sandbox policy is resolved per call and stamped on the request', async () => {
  const policy = { mode: 'workspace-write', workspaceRoot: '/session/ws' }
  const { ctx, project, home } = await runSessionStart(STARTUP_ECHO, { policy })
  try {
    assert.equal(ctx._requests.length >= 1, true, 'the hook reached the shell')
    assert.deepEqual(ctx._requests[0].sandboxPolicy, policy)
    // Resolved with the calling session, which is what roots the sandbox at
    // the session workspace instead of the deployment directory.
    assert.equal(ctx._resolvedWith.length, 1)
    assert.equal(ctx._resolvedWith[0].session.header.cwd, project)
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sandboxMode config overrides the session policy at resolve time', async () => {
  const policy = { mode: 'danger-full-access', workspaceRoot: '/session/ws' }
  const { ctx, project, home } = await runSessionStart(STARTUP_ECHO, {
    policy,
    config: { sandboxMode: 'danger-full-access' },
  })
  try {
    assert.equal(ctx._resolvedWith[0].mode, 'danger-full-access')
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('a host without the sandboxPolicy service still runs the hook', async () => {
  const { ctx, project, home } = await runSessionStart(STARTUP_ECHO)
  try {
    assert.equal(ctx._requests.length >= 1, true)
    assert.equal('sandboxPolicy' in ctx._requests[0], false)
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('CLAUDE_PLUGIN_ROOT is exported to the hook, alongside CLAUDE_PROJECT_DIR', async () => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'cc-hooks-plugin-'))
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true })
  writeFileSync(
    join(pluginDir, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/x.mjs' }] }] } }),
  )
  const { ctx, project, home } = await runSessionStart(undefined, { config: { pluginDirs: [pluginDir] } })
  try {
    const request = ctx._requests.find((r) => r.command.includes('x.mjs'))
    assert.notEqual(request, undefined, 'the plugin hook ran')
    // Substituted in the command text…
    assert.equal(request.command, `node ${pluginDir}/x.mjs`)
    // …and exported, which is what a plugin reading the variable actually sees.
    assert.equal(request.env.CLAUDE_PLUGIN_ROOT, pluginDir)
    assert.equal(request.env.CLAUDE_PROJECT_DIR, project)
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('a leading quoted command gains the call operator on pwsh and keeps it off on posix', async () => {
  const quoted = '"C:/Program Files/nodejs/node.exe" script.mjs'
  const hooksMap = { SessionStart: [{ hooks: [{ type: 'command', command: quoted }] }] }

  const pwsh = await runSessionStart(hooksMap, { config: { shellDialect: 'pwsh' } })
  try {
    assert.equal(pwsh.ctx._requests[0].command, `& ${quoted}`)
  } finally {
    rmSync(pwsh.project, { recursive: true, force: true })
    rmSync(pwsh.home, { recursive: true, force: true })
  }

  const posix = await runSessionStart(hooksMap, { config: { shellDialect: 'posix' } })
  try {
    assert.equal(posix.ctx._requests[0].command, quoted)
  } finally {
    rmSync(posix.project, { recursive: true, force: true })
    rmSync(posix.home, { recursive: true, force: true })
  }
})
