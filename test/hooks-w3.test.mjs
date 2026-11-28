// W3 tests for dsh-cc-hooks — the two disk-driven events:
//   1. FileChanged  ← matcher filenames + hook-returned watchPaths
//   2. ConfigChange ← settings files + component directories, with blocking
//
// Real chokidar is replaced by an injectable fake emitter; the actual watch
// sets, dispatch rules and gate effects are the production code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __setWatcherFactory } from '../packages/cc-hooks/src/index.js'
import { configGeneration, isConfigGateActive, registerConfigWarmer } from '../packages/cc-loader/src/config-gate.js'
import {
  configWatchEntries, createSessionWatcher, fileWatchEntries, normalizeWatchPaths,
} from '../packages/cc-hooks/src/watch.js'

function makeProject(hooksMap) {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-'))
  mkdirSync(join(project, '.git'), { recursive: true })
  if (hooksMap !== undefined) {
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: hooksMap }))
  }
  return project
}

function makeCtx(run) {
  const listeners = {}
  const warnings = []
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
    shell: { resolve: (req) => req, run },
    get: () => undefined,
    on: (event, handler) => { listeners[event] = handler },
    effect: (fn) => { disposers.push(fn) },
    inject: () => {},
    _listeners: listeners,
    _warnings: warnings,
    _disposers: disposers,
  }
  return ctx
}

function makeAgent(cwd, sessionId = 'sess-1') {
  return {
    session: { header: { id: sessionId, cwd }, events: [], append: () => {} },
    inject: () => {},
    steer: () => {},
    followup: () => {},
  }
}

const EMPTY = { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake chokidar: records each instance and lets the test emit events. */
function fakeWatchers() {
  const instances = []
  function create(paths, options) {
    const handlers = {}
    const instance = {
      paths,
      options,
      closed: false,
      on(event, fn) {
        ;(handlers[event] ??= []).push(fn)
        return instance
      },
      emit(event, path) {
        for (const fn of handlers[event] ?? []) fn(path)
      },
      async close() { instance.closed = true },
    }
    instances.push(instance)
    return instance
  }
  return { instances, create, latest: () => instances[instances.length - 1] }
}

function recorder() {
  const runs = []
  const rec = {
    runs,
    respond: async () => EMPTY,
    run: async (req) => {
      runs.push({ command: req.command, payload: JSON.parse(req.stdin) })
      return rec.respond(req)
    },
  }
  return rec
}

async function start({ home, run, agent, factory }) {
  __setWatcherFactory(factory.create)
  const ctx = makeCtx(run)
  apply(ctx, { enableGlobal: false, homeDir: home, shellDialect: 'posix' })
  await ctx._listeners['agent/session-start']({ agent, source: 'startup' })
  await sleep(300)
  return ctx
}

function cleanup(home, project) {
  __setWatcherFactory(undefined)
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
}

// ─── watch sets ─────────────────────────────────────────────────────────────

test('W3: config watch set maps settings files and component dirs to CC sources', () => {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-proj-'))
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  try {
    const entries = configWatchEntries(project, { homeDir: home })
    const bySource = (source) => entries.filter((e) => e.source === source).map((e) => e.path)

    assert.ok(bySource('user_settings').includes(join(home, '.claude', 'settings.json')))
    assert.ok(bySource('project_settings').includes(join(project, '.claude', 'settings.json')))
    assert.ok(bySource('local_settings').includes(join(project, '.claude', 'settings.local.json')))
    const skills = bySource('skills')
    for (const dir of ['skills', 'commands', 'agents', 'hooks']) {
      assert.ok(skills.includes(join(project, '.claude', dir)), `${dir} is a skills source`)
      assert.ok(skills.includes(join(home, '.claude', dir)), `user ${dir} is a skills source`)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('W3: FileChanged watches literal matcher filenames split on |', () => {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-proj-'))
  try {
    const absolute = join(project, 'abs.txt')
    const entries = fileWatchEntries(project, {
      FileChanged: [{ matcher: '.envrc| .env |' }, { matcher: absolute }],
    })
    assert.deepEqual(entries.map((e) => e.path), [
      join(project, '.envrc'),
      join(project, '.env'),
      absolute,
    ])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('W3: watchPaths are normalized and junk is dropped', () => {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-proj-'))
  try {
    assert.deepEqual(normalizeWatchPaths(['a.txt', '', 3, null, join(project, 'b.txt')], project), [
      { path: join(project, 'a.txt') },
      { path: join(project, 'b.txt') },
    ])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('W3: the watcher dispatches ConfigChange by source and keeps hooks.json internal', () => {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-proj-'))
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const events = []
  const internal = []
  const fake = fakeWatchers()
  const watcher = createSessionWatcher({
    cwd: project,
    homeDir: home,
    onConfigChange: (source, path) => events.push({ source, path }),
    onFileChanged: () => {},
    onHooksConfigChange: (path) => internal.push(path),
    createWatcher: fake.create,
  })
  watcher.setConfigEntries(configWatchEntries(project, { homeDir: home }))

  try {
    fake.latest().emit('change', join(project, '.claude', 'settings.json'))
    assert.deepEqual(events.at(-1), {
      source: 'project_settings',
      path: join(project, '.claude', 'settings.json'),
    })

    fake.latest().emit('change', join(project, '.claude', 'skills', 'demo', 'SKILL.md'))
    assert.equal(events.at(-1).source, 'skills')

    const beforeInternal = events.length
    fake.latest().emit('change', join(project, '.claude', 'hooks', 'hooks.json'))
    assert.equal(internal.at(-1), join(project, '.claude', 'hooks', 'hooks.json'))
    assert.equal(events.length, beforeInternal, 'hooks.json is internal-only, never a ConfigChange')
  } finally {
    void watcher.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ─── FileChanged ────────────────────────────────────────────────────────────

test('W3: FileChanged fires with the absolute path and chokidar event name', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({ FileChanged: [{ matcher: '.envrc|.env', hooks: [{ type: 'command', command: 'file-check' }] }] })
  const fake = fakeWatchers()
  const rec = recorder()
  const agent = makeAgent(project)
  try {
    await start({ home, run: rec.run, agent, factory: fake })
    const instance = fake.latest()
    assert.ok(instance !== undefined, 'a watcher was started for FileChanged hooks')
    assert.deepEqual(instance.options.awaitWriteFinish, { stabilityThreshold: 500, pollInterval: 200 })

    instance.emit('change', join(project, '.env'))
    await sleep(200)

    assert.equal(rec.runs.length, 1)
    assert.deepEqual(rec.runs[0].payload, {
      session_id: 'sess-1',
      transcript_path: '',
      cwd: project,
      hook_event_name: 'FileChanged',
      file_path: join(project, '.env'),
      event: 'change',
    })

    // A path outside the matcher list never reaches the hook.
    instance.emit('change', join(project, 'unrelated.txt'))
    await sleep(100)
    assert.equal(rec.runs.length, 1)

    // The three chokidar events CC forwards.
    instance.emit('add', join(project, '.envrc'))
    instance.emit('unlink', join(project, '.env'))
    await sleep(200)
    assert.deepEqual(rec.runs.slice(1).map((r) => r.payload.event), ['add', 'unlink'])
  } finally {
    cleanup(home, project)
  }
})

test('W3: a FileChanged hook can extend the watch set with watchPaths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  // `extra\.txt` is a regex matcher, so its literal text is not a real watch
  // path; only the hook-returned watchPaths can put the file on the list.
  const project = makeProject({
    FileChanged: [
      { matcher: '.env', hooks: [{ type: 'command', command: 'file-check' }] },
      { matcher: 'extra\\.txt', hooks: [{ type: 'command', command: 'file-extra' }] },
    ],
  })
  const fake = fakeWatchers()
  const extra = join(project, 'extra.txt')
  const rec = recorder()
  rec.respond = async (req) => (req.command === 'file-check'
    ? {
        exitCode: 0,
        stdout: { text: JSON.stringify({ hookSpecificOutput: { hookEventName: 'FileChanged', watchPaths: [extra] } }) },
        stderr: { text: '' },
      }
    : EMPTY)
  const agent = makeAgent(project)
  try {
    await start({ home, run: rec.run, agent, factory: fake })
    fake.latest().emit('change', join(project, '.env'))
    await sleep(200)
    assert.equal(rec.runs.length, 1)

    fake.latest().emit('change', extra)
    await sleep(200)
    assert.equal(rec.runs.length, 2)
    assert.equal(rec.runs[1].command, 'file-extra')
    assert.equal(rec.runs[1].payload.file_path, extra)
  } finally {
    cleanup(home, project)
  }
})

test('W3: SessionStart watchPaths are applied even when the hook beats the watcher', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({
    SessionStart: [{ hooks: [{ type: 'command', command: 'session-watch' }] }],
    FileChanged: [{ matcher: 'extra\\.txt', hooks: [{ type: 'command', command: 'file-extra' }] }],
  })
  const fake = fakeWatchers()
  const extra = join(project, 'session-extra.txt')
  const rec = recorder()
  rec.respond = async (req) => (req.command === 'session-watch'
    ? {
        exitCode: 0,
        stdout: { text: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: [extra] } }) },
        stderr: { text: '' },
      }
    : EMPTY)
  const agent = makeAgent(project)
  try {
    await start({ home, run: rec.run, agent, factory: fake })
    fake.latest().emit('change', extra)
    await sleep(200)
    assert.ok(rec.runs.some((r) => r.payload.hook_event_name === 'FileChanged' && r.payload.file_path === extra))
  } finally {
    cleanup(home, project)
  }
})

// ─── ConfigChange ───────────────────────────────────────────────────────────

test('W3: an allowed ConfigChange fires the hook, bumps the gate and reloads config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({ ConfigChange: [{ matcher: 'project_settings', hooks: [{ type: 'command', command: 'config-check' }] }] })
  const fake = fakeWatchers()
  const rec = recorder()
  const agent = makeAgent(project)
  try {
    const ctx = await start({ home, run: rec.run, agent, factory: fake })
    assert.equal(isConfigGateActive(project), true, 'a ConfigChange hook activates the gate')
    const before = configGeneration(project)

    const settings = join(project, '.claude', 'settings.json')
    fake.latest().emit('change', settings)
    await sleep(250)

    assert.equal(rec.runs.length, 1)
    assert.deepEqual(rec.runs[0].payload, {
      session_id: 'sess-1',
      transcript_path: '',
      cwd: project,
      hook_event_name: 'ConfigChange',
      source: 'project_settings',
      file_path: settings,
    })
    assert.equal(configGeneration(project), before + 1)
    assert.ok(!ctx._warnings.some((line) => /blocked/.test(line)))
  } finally {
    cleanup(home, project)
  }
})

test('W3: an allowed ConfigChange re-warms adapters AFTER bumping the generation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({ ConfigChange: [{ hooks: [{ type: 'command', command: 'config-check' }] }] })
  const fake = fakeWatchers()
  const rec = recorder()
  const agent = makeAgent(project)
  const warmedAt = []
  const unregister = registerConfigWarmer((cwd) => { warmedAt.push(configGeneration(cwd)) })
  try {
    await start({ home, run: rec.run, agent, factory: fake })
    warmedAt.length = 0 // ignore the session-start warm

    const before = configGeneration(project)
    fake.latest().emit('change', join(project, '.claude', 'settings.json'))
    await sleep(300)

    assert.deepEqual(warmedAt, [before + 1], 'adapters reload at the NEW generation, not the old one')
  } finally {
    unregister()
    cleanup(home, project)
  }
})

test('W3: a blocked ConfigChange keeps the generation and every cache frozen', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({ ConfigChange: [{ hooks: [{ type: 'command', command: 'config-check' }] }] })
  const fake = fakeWatchers()
  const rec = recorder()
  rec.respond = async () => ({ exitCode: 2, stdout: { text: '' }, stderr: { text: 'no config edits mid-task' } })
  const agent = makeAgent(project)
  try {
    const ctx = await start({ home, run: rec.run, agent, factory: fake })
    const before = configGeneration(project)

    fake.latest().emit('change', join(project, '.claude', 'settings.json'))
    await sleep(250)

    assert.equal(rec.runs.length, 1)
    assert.equal(configGeneration(project), before, 'a blocked change never advances the gate')
    assert.ok(ctx._warnings.some((line) => /ConfigChange hook blocked project_settings/.test(line)))
  } finally {
    cleanup(home, project)
  }
})

test('W3: a ConfigChange hook only receives its matcher source', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({
    ConfigChange: [{ matcher: 'user_settings', hooks: [{ type: 'command', command: 'config-check' }] }],
  })
  const fake = fakeWatchers()
  const rec = recorder()
  const agent = makeAgent(project)
  try {
    await start({ home, run: rec.run, agent, factory: fake })
    fake.latest().emit('change', join(project, '.claude', 'settings.json'))
    await sleep(200)
    assert.equal(rec.runs.length, 0, 'project_settings does not match a user_settings matcher')

    fake.latest().emit('change', join(home, '.claude', 'settings.json'))
    await sleep(200)
    assert.equal(rec.runs.length, 1)
    assert.equal(rec.runs[0].payload.source, 'user_settings')
  } finally {
    cleanup(home, project)
  }
})

test('W3: disposal closes the watcher and releases the gate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({ ConfigChange: [{ hooks: [{ type: 'command', command: 'config-check' }] }] })
  const fake = fakeWatchers()
  const rec = recorder()
  const agent = makeAgent(project)
  try {
    const ctx = await start({ home, run: rec.run, agent, factory: fake })
    assert.equal(isConfigGateActive(project), true)
    const instance = fake.latest()

    ctx._listeners['agent/disposed']({ agent })
    await sleep(50)

    assert.equal(isConfigGateActive(project), false)
    assert.equal(instance.closed, true)
  } finally {
    cleanup(home, project)
  }
})

test('W3: editing the project hooks.json takes effect in the open session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-home-'))
  const project = makeProject({ FileChanged: [{ matcher: '.env', hooks: [{ type: 'command', command: 'old-hook' }] }] })
  const fake = fakeWatchers()
  const rec = recorder()
  const agent = makeAgent(project)
  try {
    await start({ home, run: rec.run, agent, factory: fake })

    // Add a second FileChanged matcher while the session is open.
    writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        FileChanged: [
          { matcher: '.env', hooks: [{ type: 'command', command: 'old-hook' }] },
          { matcher: '.extra', hooks: [{ type: 'command', command: 'new-hook' }] },
        ],
      },
    }))
    fake.latest().emit('change', join(project, '.claude', 'hooks', 'hooks.json'))
    await sleep(300)

    fake.latest().emit('change', join(project, '.extra'))
    await sleep(200)
    assert.ok(rec.runs.some((r) => r.command === 'new-hook'), 'the edited hook config is live')
  } finally {
    cleanup(home, project)
  }
})

// ─── default watcher smoke test ────────────────────────────────────────────

async function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(100)
  }
  return predicate()
}

test('W3: the default chokidar watcher reports a real disk change', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-hooks-w3-real-'))
  const file = join(cwd, '.env')
  writeFileSync(file, 'A=1\n')
  const events = []
  const watcher = createSessionWatcher({
    cwd,
    homeDir: join(tmpdir(), 'cc-hooks-w3-real-home'),
    onFileChanged: (path, event) => events.push({ path, event }),
    onConfigChange: () => {},
  })
  try {
    watcher.setFileEntries([{ path: file }])
    await sleep(500)
    writeFileSync(file, 'A=2\n')
    assert.equal(
      await waitFor(() => events.some((e) => e.event === 'change'), 8000),
      true,
      'chokidar reports the change (500 ms awaitWriteFinish)',
    )
    assert.equal(events.find((e) => e.event === 'change').path, file)
  } finally {
    await watcher.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})
