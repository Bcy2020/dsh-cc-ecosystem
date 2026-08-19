// Batch-A tests for dsh-cc-hooks:
//   1. `if` field execution filtering (tool-event-only, fail-open, Bash
//      subcommand / $() / backtick semantics).
//   2. PostToolUseFailure wiring — tools/post-execute on a failed tool fires
//      the failure event, not PostToolUse.
//   3. SessionEnd — agent/disposed fires it for top-level sessions only.
//   4. PreCompact/PostCompact — session compaction events map to the points
//      with trigger manual|auto and the matching matcher subject.
//
// The plugin is driven through its real `apply()` with a minimal mock ctx;
// hook commands are executed for real through the shell mock when needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../packages/cc-hooks/src/index.js'
import { matchesIf } from '../packages/cc-hooks/src/if-filter.js'
import { WIRED_EVENTS } from '../packages/cc-hooks/src/parse.js'

const demoRoot = join(import.meta.dirname, '..', '..', 'cc-demo-project') // teno/cc-demo-project

/** Make a scratch project with a `.git` marker and the given hooks.json. */
function makeProject(hooksMap) {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-proj-'))
  mkdirSync(join(project, '.git'), { recursive: true })
  if (hooksMap !== undefined) {
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: hooksMap }))
  }
  return project
}

// ─── harness mocks (same shape as hooks-integration.mjs) ────────────────────

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

function makeAgent(cwd, sessionId = 'sess-1', header = {}) {
  const injected = []
  const steered = []
  return {
    session: {
      header: { id: sessionId, cwd, ...header },
      events: [],
      append: () => {},
    },
    inject: (msg) => injected.push(msg),
    steer: (msg) => steered.push(msg),
    _injected: injected,
    _steered: steered,
  }
}

function execFor(agent, name, args, isError = false) {
  return {
    name,
    arguments: args,
    callId: `c-${Math.random().toString(36).slice(2)}`,
    agent,
    signal: new AbortController().signal,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── 1. if-filter pure semantics ─────────────────────────────────────────────

test('if-filter: Bash any-subcommand, $()/backtick, env-stripping, fail-open', () => {
  const env = { cwd: demoRoot, homeDir: tmpdir() }
  const bash = (command) => ({ tool: 'bash', args: { command } })

  // Any subcommand matches.
  assert.equal(matchesIf('Bash(git *)', bash('FOO=bar git push'), env), true)
  assert.equal(matchesIf('Bash(git *)', bash('npm test && git push'), env), true)
  assert.equal(matchesIf('Bash(git *)', bash('npm test'), env), false)
  // $()/backtick contents are inspected.
  assert.equal(matchesIf('Bash(rm *)', bash('echo $(rm -rf /)'), env), true)
  assert.equal(matchesIf('Bash(rm *)', bash('echo `rm -rf /`'), env), true)
  assert.equal(matchesIf('Bash(rm *)', bash('echo $(date)'), env), false)
  // Patterns naming more than the command run anyway on $()/backticks/$VAR.
  assert.equal(matchesIf('Bash(git push *)', bash('echo $(date)'), env), true)
  // PowerShell case-insensitive matching.
  assert.equal(matchesIf('PowerShell(remove-item *)', { tool: 'pwsh', args: { command: 'Remove-Item -Recurse x' } }, env), true)
  // Non-Bash tools never match a command rule.
  assert.equal(matchesIf('Bash(git *)', { tool: 'read', args: {} }, env), false)
})

test('if-filter: bare/tool-glob/path/param rules and unparseable fail-open', () => {
  const env = { cwd: demoRoot, homeDir: tmpdir() }
  assert.equal(matchesIf('Bash', { tool: 'bash', args: { command: 'anything' } }, env), true)
  assert.equal(matchesIf('Read', { tool: 'read', args: {} }, env), true)
  // Path rule on a file tool.
  assert.equal(matchesIf('Edit(src/**)', { tool: 'edit', args: { file_path: join(demoRoot, 'src', 'a.ts') } }, env), true)
  assert.equal(matchesIf('Edit(src/**)', { tool: 'edit', args: { file_path: join(tmpdir(), 'other', 'b.ts') } }, env), false)
  // Param rule.
  assert.equal(matchesIf('Bash(run_in_background:true)', { tool: 'bash', args: { command: 'ls', run_in_background: true } }, env), true)
  // Unparseable rule → fail open (hook runs).
  assert.equal(matchesIf('(((', { tool: 'bash', args: { command: 'ls' } }, env), true)
  // Skill-name rule.
  assert.equal(matchesIf('Skill(deploy)', { tool: 'skill', args: { name: 'deploy' } }, env), true)
  assert.equal(matchesIf('Skill(deploy)', { tool: 'skill', args: { name: 'lint' } }, env), false)
})

// ─── 2-4. wiring through apply() ─────────────────────────────────────────────

test('batch-A wiring: if filtering on PreToolUse runs only matching hooks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-ba-'))
  const project = makeProject({
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: 'echo guarded', if: 'Bash(rm *)' },
        { type: 'command', command: 'echo always' },
      ],
    }],
    // `if` on a non-tool event must NEVER run.
    Stop: [{
      hooks: [{ type: 'command', command: 'echo stop-if', if: 'Bash(rm *)' }],
    }],
  })
  try {
    const runs = []
    const ctx = makeCtx()
    ctx.shell.run = async (req) => {
      runs.push(req)
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })

    const agent = makeAgent(project)
    await ctx._listeners['agent/session-start']({ agent, source: 'startup' })
    await sleep(300)

    const exec = execFor(agent, 'bash', { command: 'rm -rf x' })
    await ctx._listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    // Both hooks ran for rm.
    const cmds = runs.map((r) => r.command)
    assert.ok(cmds.includes('echo guarded'), 'rm matches the if rule → guarded hook runs')
    assert.ok(cmds.includes('echo always'))

    runs.length = 0
    const exec2 = execFor(agent, 'bash', { command: 'git status' })
    await ctx._listeners['tools/pre-execute'](exec2, async () => ({ kind: 'allow' }))
    assert.equal(runs.some((r) => r.command === 'echo guarded'), false, 'git status does not match Bash(rm *)')
    assert.equal(runs.some((r) => r.command === 'echo always'), true)

    // Stop: if-bearing hook must not run (non-tool event).
    runs.length = 0
    await ctx._listeners['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(runs.some((r) => r.command === 'echo stop-if'), false, 'if on a non-tool event never runs')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('batch-A wiring: PostToolUseFailure fires on a failed tool, PostToolUse on success', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-ba-'))
  const project = makeProject({
    PostToolUse: [{ hooks: [{ type: 'command', command: 'node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:\'PostToolUse\',additionalContext:\'ok note\'}}))"' }] }],
    PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:\'PostToolUseFailure\',additionalContext:\'fail note\'}}))"' }] }],
  })
  try {
    const seen = []
    const ctx = makeCtx()
    ctx.shell.run = async (req) => {
      // Replay what the real shell would produce for the fixture commands.
      if (req.command.includes('ok note')) seen.push('PostToolUse')
      if (req.command.includes('fail note')) seen.push('PostToolUseFailure')
      return { exitCode: 0, stdout: { text: req.command.includes('fail note')
        ? '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"fail note"}}'
        : '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"ok note"}}' }, stderr: { text: '' } }
    }
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })

    const agent = makeAgent(project)
    await ctx._listeners['agent/session-start']({ agent, source: 'startup' })
    await sleep(300)

    // Successful tool → PostToolUse.
    const okExec = execFor(agent, 'bash', { command: 'ls' })
    const okResult = { isError: false, content: [{ type: 'text', text: 'files' }] }
    const okDecision = await ctx._listeners['tools/post-execute'](okExec, okResult, async () => ({ kind: 'accept', content: [] }))
    assert.ok(seen.includes('PostToolUse'))
    assert.ok(!seen.includes('PostToolUseFailure'))
    assert.ok(Array.isArray(okDecision.additionalContexts) && okDecision.additionalContexts.length === 1, 'PostToolUse context injected')

    // Failed tool → PostToolUseFailure.
    seen.length = 0
    const failExec = execFor(agent, 'bash', { command: 'rm -rf x' })
    const failResult = { isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'Error: boom' }] }
    const failDecision = await ctx._listeners['tools/post-execute'](failExec, failResult, async () => ({ kind: 'accept', content: [] }))
    assert.ok(seen.includes('PostToolUseFailure'))
    assert.ok(!seen.includes('PostToolUse'))
    assert.ok(Array.isArray(failDecision.additionalContexts) && failDecision.additionalContexts.length === 1, 'PostToolUseFailure context injected')

    // DSH shell tools exit non-zero WITHOUT isError (canonical value carries
    // exitCode) — CC treats that as a failed tool → PostToolUseFailure too.
    seen.length = 0
    const nonzeroExec = execFor(agent, 'bash', { command: 'bash -c "exit 1"' })
    const nonzeroResult = {
      isError: false,
      content: [{ type: 'text', text: '[exit code: 1] failed' }],
      value: { kind: 'foreground', exitCode: 1, signal: null, timedOut: false, aborted: false },
    }
    const nonzeroDecision = await ctx._listeners['tools/post-execute'](nonzeroExec, nonzeroResult, async () => ({ kind: 'accept', content: [] }))
    assert.ok(seen.includes('PostToolUseFailure'), 'non-zero exit without isError must fire PostToolUseFailure')
    assert.ok(!seen.includes('PostToolUse'))
    assert.ok(Array.isArray(nonzeroDecision.additionalContexts) && nonzeroDecision.additionalContexts.length === 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('batch-A wiring: SessionEnd fires on top-level disposal only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-ba-'))
  const project = makeProject({ SessionEnd: [{ hooks: [{ type: 'command', command: 'echo end' }] }] })
  try {
    const runs = []
    const ctx = makeCtx()
    ctx.shell.run = async (req) => { runs.push(req); return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } } }
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })

    const top = makeAgent(project, 'top-1')
    await ctx._listeners['agent/session-start']({ agent: top, source: 'startup' })
    await sleep(300)

    await ctx._listeners['agent/disposed']({ agent: top })
    await sleep(300)
    assert.equal(runs.length, 1, 'SessionEnd hook ran once for the top-level session')

    // Subagent disposal → no SessionEnd (it is SubagentStop instead).
    const child = makeAgent(project, 'child-1', { origin: 'subagent', parentSession: 'top-1', delegationDepth: 1 })
    await ctx._listeners['agent/disposed']({ agent: child })
    await sleep(300)
    assert.equal(runs.length, 1, 'subagent disposal must not fire SessionEnd')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('batch-A wiring: PreCompact/PostCompact fire from the session event stream with manual|auto', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-ba-'))
  const project = makeProject({
    PreCompact: [
      { matcher: 'manual', hooks: [{ type: 'command', command: 'echo pre-manual' }] },
      { matcher: 'auto', hooks: [{ type: 'command', command: 'echo pre-auto' }] },
    ],
    PostCompact: [
      { matcher: 'auto', hooks: [{ type: 'command', command: 'echo post-auto' }] },
    ],
  })
  try {
    const runs = []
    const ctx = makeCtx()
    ctx.shell.run = async (req) => { runs.push(req); return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } } }
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })

    const agent = makeAgent(project)
    await ctx._listeners['agent/session-start']({ agent, source: 'startup' })
    await sleep(300)

    // Automatic compaction (no sourceCommandId) → PreCompact auto + PostCompact auto.
    const ev = ctx._listeners['session/event']
    assert.ok(ev, 'session/event listener registered')
    ev(agent.session, { type: 'compaction/start', seq: 1, time: 1, data: { compactionId: 'c1', turn: null } })
    ev(agent.session, { type: 'compaction/end', seq: 2, time: 2, data: { compactionId: 'c1', turn: null } })
    await sleep(300)
    assert.ok(runs.some((r) => r.command === 'echo pre-auto'))
    assert.ok(runs.some((r) => r.command === 'echo post-auto'))
    assert.ok(!runs.some((r) => r.command === 'echo pre-manual'))

    // Manual compaction (sourceCommandId present) → PreCompact manual only.
    runs.length = 0
    ev(agent.session, { type: 'compaction/start', seq: 3, time: 3, data: { compactionId: 'c2', sourceCommandId: 'cmd-9', turn: 5 } })
    await sleep(300)
    assert.ok(runs.some((r) => r.command === 'echo pre-manual'))
    assert.ok(!runs.some((r) => r.command === 'echo pre-auto'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('batch-A: WIRED_EVENTS covers the 11 wired events', () => {
  assert.deepEqual(WIRED_EVENTS, [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
    'SubagentStart', 'SubagentStop', 'PostToolUseFailure', 'SessionEnd',
    'PreCompact', 'PostCompact',
  ])
})

test('demo hooks.json: 19 hooks across 11 events — all five handler types parse, nothing skipped', async (t) => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { parseHooksConfig } = await import('../packages/cc-hooks/src/parse.js')
  const demoFile = join(demoRoot, '.claude', 'hooks', 'hooks.json')
  if (!existsSync(demoFile)) {
    t.skip('cc-demo-project not present (local-machine-only fixture)')
    return
  }
  const raw = JSON.parse(readFileSync(demoFile, 'utf8'))
  const { config, skipped } = parseHooksConfig(raw)

  // 12 events carry hooks (the 11 wired plus Notification, whose http hook is
  // parsed-but-inert — Notification has no DSH extension point); every wired
  // event is present.
  const events = Object.keys(config)
  assert.equal(events.length, 12)
  for (const ev of WIRED_EVENTS) assert.ok(events.includes(ev), `wired event ${ev} configured in demo`)

  // 19 entries = 14 command + http (PreToolUse, Notification) + mcp_tool
  // (PostToolUse) + prompt (UserPromptSubmit) + agent (Stop).
  const count = events.reduce((n, ev) => n + config[ev].reduce((m, g) => m + g.hooks.length, 0), 0)
  assert.equal(count, 19)

  // The `if` fields survive parsing on the guarded observe hooks (bash rm +
  // pwsh Remove-Item, matching CC's two-handler-per-tool pattern).
  const preTool = config.PreToolUse.flatMap((g) => g.hooks)
  assert.ok(preTool.some((h) => h.if === 'Bash(rm *)'))
  assert.ok(preTool.some((h) => h.if === 'PowerShell(Remove-Item *)'))
  // Both matcher styles parse: CC bucket names (Bash|PowerShell, Read|Edit|Write)
  // and DSH names (bash|pwsh).
  const matchers = config.PreToolUse.map((g) => g.matcher).sort()
  assert.deepEqual(matchers, ['Bash|PowerShell', 'Read|Edit|Write'])
  assert.equal(config.PostToolUse[0].matcher, 'bash|pwsh')

  // All five handler types survive parsing on their events.
  assert.ok(preTool.some((h) => h.type === 'http' && h.url === 'http://127.0.0.1:8787/hooks/pre-tool-use' && h.timeoutSec === 5))
  assert.ok(config.Notification[0].hooks.some((h) => h.type === 'http'))
  assert.ok(config.PostToolUse.flatMap((g) => g.hooks).some((h) => h.type === 'mcp_tool' && h.server === 'demo' && h.tool === 'notify'))
  assert.ok(config.UserPromptSubmit[0].hooks.some((h) => h.type === 'prompt'))
  assert.ok(config.Stop[0].hooks.some((h) => h.type === 'agent'))

  // Every demo combination is inside the official event × type matrix: nothing
  // is skipped with a warning anymore.
  assert.deepEqual(skipped, [])
})
