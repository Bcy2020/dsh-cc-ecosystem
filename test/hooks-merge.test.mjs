// Unit tests for dsh-cc-hooks: CC hooks.json parsing, ${CLAUDE_*} substitution,
// three-source discovery (project/global/plugin), cross-source merging, protocol
// outcome folding (deny > ask > allow), and matcher semantics.
//
// The wire protocol (@deepseek-ai/dsh-hook-protocol) is imported through the
// package's own node_modules (pnpm-linked) because this repo root has no
// node_modules of its own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHooksConfig, substituteCommand, CLAUDE_EVENTS } from '../packages/cc-hooks/src/parse.js'
import { mergeHookConfigs } from '../packages/cc-hooks/src/merge.js'
import { discoverHookFiles } from '../packages/cc-hooks/src/discover.js'
import { mergeHookOutputs, matchesMatcher } from '../packages/cc-hooks/node_modules/@deepseek-ai/dsh-hook-protocol/lib/index.js'

// ─── parseHooksConfig ────────────────────────────────────────────────────────

test('parse: bare event map and settings {hooks} shape both parse', () => {
  const bare = {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 10000 }] },
    ],
  }
  const settings = { hooks: { ...bare } }
  for (const raw of [bare, settings]) {
    const { config, skipped } = parseHooksConfig(raw)
    assert.equal(skipped.length, 0)
    const groups = config.PreToolUse
    assert.equal(groups.length, 1)
    assert.equal(groups[0].matcher, 'Bash')
    assert.equal(groups[0].hooks.length, 1)
    assert.equal(groups[0].hooks[0].command, 'guard.sh')
    assert.equal(groups[0].hooks[0].timeoutSec, 10000) // wire unit: seconds
  }
})

test('parse: non-command hooks are skipped, unknown events and malformed entries ignored', () => {
  const raw = {
    PreToolUse: [
      { matcher: 'Bash', hooks: [
        { type: 'command', command: 'ok.sh' },
        { type: 'http', url: 'https://example.com' },
        { type: 'prompt', prompt: 'x' },
        { type: 'command' }, // no command string → malformed, ignored
        42,                  // not an object → ignored
      ] },
    ],
    SomeFutureEvent: [{ hooks: [{ type: 'command', command: 'future.sh' }] }], // not in the 7 → ignored
  }
  const { config, skipped } = parseHooksConfig(raw)
  assert.deepEqual(skipped, [
    { event: 'PreToolUse', type: 'http' },
    { event: 'PreToolUse', type: 'prompt' },
  ])
  assert.equal(config.PreToolUse[0].hooks.length, 1)
  assert.equal(config.PreToolUse[0].hooks[0].command, 'ok.sh')
  assert.equal(config.SomeFutureEvent, undefined)
})

test('parse: invalid regex matcher throws SyntaxError; match-all and UserPromptSubmit/Stop matchers are safe', () => {
  assert.throws(
    () => parseHooksConfig({ PreToolUse: [{ matcher: '(unclosed', hooks: [{ type: 'command', command: 'x' }] }] }),
    SyntaxError,
  )
  // Match-all sentinels are valid.
  for (const matcher of [undefined, '', '*']) {
    const { config } = parseHooksConfig({ PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'x' }] }] })
    assert.equal(config.PreToolUse[0].hooks[0].command, 'x')
  }
  // UserPromptSubmit / Stop have no matcher subject → matcher discarded.
  const { config } = parseHooksConfig({
    UserPromptSubmit: [{ matcher: 'Anything|at|all', hooks: [{ type: 'command', command: 'p.sh' }] }],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 's.sh' }] }],
  })
  assert.equal('matcher' in config.UserPromptSubmit[0], false)
  assert.equal('matcher' in config.Stop[0], false)
})

// ─── substituteCommand ───────────────────────────────────────────────────────

test('substituteCommand: replaces set vars, leaves unset tokens verbatim', () => {
  const cmd = 'node ${CLAUDE_PLUGIN_ROOT}/guard.mjs --dir ${CLAUDE_PROJECT_DIR}'
  assert.equal(
    substituteCommand(cmd, { pluginRoot: 'C:/p', projectDir: 'C:/w' }),
    'node C:/p/guard.mjs --dir C:/w',
  )
  // Only pluginRoot set → project token untouched.
  assert.equal(substituteCommand(cmd, { pluginRoot: 'C:/p' }), 'node C:/p/guard.mjs --dir ${CLAUDE_PROJECT_DIR}')
  // No vars → verbatim.
  assert.equal(substituteCommand(cmd), cmd)
})

// ─── discoverHookFiles ───────────────────────────────────────────────────────

test('discover: finds project + global + plugin sources with per-plugin root; skips missing files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-hooks-'))
  try {
    const home = join(root, 'home')
    const proj = join(root, 'proj')            // has .git → project root marker
    const sub = join(proj, 'src', 'deep')      // session cwd deep inside
    const plugin = join(root, 'plugin-a')
    mkdirSync(join(proj, '.git'), { recursive: true })
    mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true })
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true })
    mkdirSync(join(plugin, 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'proj.sh' }] }] } }))
    writeFileSync(join(home, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'user.sh' }] }] } }))
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/sign.sh' }] }] } }))

    const { projectRoot, sources } = await discoverHookFiles(sub, {
      homeDir: home,
      projectRootMarkers: ['.git'],
      pluginDirs: [plugin],
    })
    assert.equal(projectRoot, proj)
    assert.deepEqual(sources.map((s) => s.scope), ['project', 'user', 'plugin'])
    assert.equal(sources[0].path, join(proj, '.claude', 'hooks', 'hooks.json'))
    assert.equal(sources[1].path, join(home, '.claude', 'hooks', 'hooks.json'))
    assert.equal(sources[2].path, join(plugin, 'hooks', 'hooks.json'))
    assert.equal(sources[2].pluginRoot, plugin)

    // ${CLAUDE_PLUGIN_ROOT} substitutes to the plugin root at parse time.
    const parsed = parseHooksConfig(sources[2].data, { pluginRoot: sources[2].pluginRoot })
    assert.equal(parsed.config.PostToolUse[0].hooks[0].command, `${plugin}/sign.sh`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discover: no hooks anywhere → empty sources; enableGlobal=false drops the user source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-hooks-'))
  try {
    const home = join(root, 'home')
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(home, '.claude', 'hooks', 'hooks.json'), '{"hooks":{}}')
    const a = await discoverHookFiles(root, { homeDir: home, projectRootMarkers: ['.git'] })
    assert.deepEqual(a.sources.map((s) => s.scope), ['user'])
    const b = await discoverHookFiles(root, { homeDir: home, projectRootMarkers: ['.git'], enableGlobal: false })
    assert.deepEqual(b.sources, [])
    assert.equal(b.projectRoot, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─── mergeHookConfigs ────────────────────────────────────────────────────────

test('merge: same-event matcher groups stack across sources in order; empty input → {}', () => {
  const project = { config: { PreToolUse: [{ hooks: [{ command: 'p1.sh' }] }] } }
  const user = { config: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'u1.sh' }] }], Stop: [{ hooks: [{ command: 'u2.sh' }] }] } }
  const plugin = { config: { PreToolUse: [{ matcher: 'Bash|Write', hooks: [{ command: 'k1.sh' }] }] } }
  const merged = mergeHookConfigs([project, user, plugin])
  assert.deepEqual(Object.keys(merged).sort(), ['PreToolUse', 'Stop'])
  assert.equal(merged.PreToolUse.length, 3)
  assert.equal(merged.PreToolUse[0].hooks[0].command, 'p1.sh')
  assert.equal(merged.PreToolUse[1].matcher, 'Bash')
  assert.equal(merged.PreToolUse[2].matcher, 'Bash|Write')
  assert.equal(merged.Stop[0].hooks[0].command, 'u2.sh')
  assert.deepEqual(mergeHookConfigs([]), {})
  assert.deepEqual(mergeHookConfigs([{ config: {} }, { config: undefined }]), {})
})

// ─── protocol folding + matcher semantics (what runPoint relies on) ──────────

test('fold: deny > ask > allow with reasons joined and context accumulated in hook order', () => {
  const outputs = [
    { exitCode: 0, stderr: '', stdout: '', decision: 'allow', additionalContext: 'first' },
    { exitCode: 0, stderr: '', stdout: '', decision: 'ask', reason: 'ask me' },
    { exitCode: 0, stderr: '', stdout: '', decision: 'deny', reason: 'no way' },
  ]
  const merged = mergeHookOutputs(outputs)
  assert.equal(merged.decision, 'deny')
  assert.equal(merged.reason, 'no way') // only the winning rank's reason survives
  assert.deepEqual(merged.additionalContext, ['first'])
  assert.equal(merged.stop, false)
})

test('fold: continue:false stop is sticky and surfaces stopReason', () => {
  const merged = mergeHookOutputs([
    { exitCode: 0, stderr: '', stdout: '', continue: false, stopReason: 'halt now' },
    { exitCode: 0, stderr: '', stdout: '', continue: false, stopReason: 'ignored' },
  ])
  assert.equal(merged.stop, true)
  assert.equal(merged.stopReason, 'halt now')
})

test('matcher: CC literal pipe alternation, regex, and match-all sentinels', () => {
  assert.equal(matchesMatcher('Bash|Write', 'Bash', 'claude-code'), true)
  assert.equal(matchesMatcher('Bash|Write', 'Read', 'claude-code'), false)
  assert.equal(matchesMatcher('.*Tool', 'PreToolUse', 'claude-code'), true)
  assert.equal(matchesMatcher('.*Tool', 'UserPromptSubmit', 'claude-code'), false)
  for (const m of [undefined, '', '*']) {
    assert.equal(matchesMatcher(m, 'anything', 'claude-code'), true)
  }
})

test('events: the 7 mapped events are exactly the official bridge set', () => {
  assert.deepEqual(CLAUDE_EVENTS, [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'Stop', 'SubagentStart', 'SubagentStop',
  ])
})
