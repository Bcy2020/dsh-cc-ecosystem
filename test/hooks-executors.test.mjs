// Batch-B tests for dsh-cc-hooks: the four non-command handler types
// (http / mcp_tool / prompt / agent) execute with official CC semantics;
// unsupported event×type combinations are skipped with a warning at parse
// time; a missing runtime capability (tools/llm service, subagent tool, model
// route) degrades to a warning + neutral outcome, never a crash.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../packages/cc-hooks/src/index.js'
import { parseHooksConfig, EVENT_TYPE_SUPPORT, CC_EVENTS } from '../packages/cc-hooks/src/parse.js'
import {
  defaultTimeoutMsFor,
  interpolateHeaderValue,
  mcpToolPublicName,
  runAgentHook,
  runHttpHook,
  runMcpToolHook,
  runPromptHook,
  substituteArguments,
  substituteInputPaths,
} from '../packages/cc-hooks/src/executors.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A logger stub that records warnings. */
function makeLogger() {
  const warns = []
  return { logger: { info: () => {}, warn: (m) => warns.push(m) }, warns }
}

function makeCtx() {
  const listeners = {}
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    shell: { resolve: (req) => req, run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) },
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
    session: { header: { id: sessionId, cwd }, events: [], append: () => {} },
    options: { provider: 'p', model: 'm' },
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

function makeProject(hooksMap) {
  const project = mkdtempSync(join(tmpdir(), 'cc-hooks-be-'))
  mkdirSync(join(project, '.git'), { recursive: true })
  if (hooksMap !== undefined) {
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(project, '.claude', 'hooks', 'hooks.json'), JSON.stringify({ hooks: hooksMap }))
  }
  return project
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// ─── parse: typed IR + support matrix ────────────────────────────────────────

test('parse: all five types become typed IR; unsupported event×type combos skip', () => {
  const raw = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: 'echo c' },
        { type: 'http', url: 'http://x/h', timeout: 5, headers: { Authorization: 'Bearer $TOK' }, allowedEnvVars: ['TOK'], if: 'Bash(git *)' },
        { type: 'mcp_tool', server: 'srv', tool: 'scan', input: { path: '${tool_input.file_path}' } },
        { type: 'prompt', prompt: 'check $ARGUMENTS', model: 'fast/deep' },
        { type: 'agent', prompt: 'verify $ARGUMENTS' },
      ] }],
      SessionStart: [{ hooks: [
        { type: 'command', command: 'echo s' },
        { type: 'mcp_tool', server: 'srv', tool: 't' },
        { type: 'http', url: 'http://x/s' },
        { type: 'prompt', prompt: 'nope' },
        { type: 'agent', prompt: 'nope' },
      ] }],
      PreCompact: [{ hooks: [{ type: 'prompt', prompt: 'nope' }] }],
      Notification: [{ hooks: [{ type: 'http', url: 'http://x/n' }] }],
    },
  }
  const { config, skipped } = parseHooksConfig(raw)

  const pre = config.PreToolUse[0].hooks
  assert.deepEqual(pre.map((h) => h.type), ['command', 'http', 'mcp_tool', 'prompt', 'agent'])
  assert.equal(pre[0].command, 'echo c')
  assert.equal(pre[1].url, 'http://x/h')
  assert.equal(pre[1].timeoutSec, 5)
  assert.deepEqual(pre[1].headers, { Authorization: 'Bearer $TOK' })
  assert.deepEqual(pre[1].allowedEnvVars, ['TOK'])
  assert.equal(pre[1].if, 'Bash(git *)')
  assert.equal(pre[2].server, 'srv')
  assert.deepEqual(pre[2].input, { path: '${tool_input.file_path}' })
  assert.equal(pre[3].prompt, 'check $ARGUMENTS')
  assert.equal(pre[3].model, 'fast/deep')
  assert.equal(pre[4].prompt, 'verify $ARGUMENTS')

  // SessionStart supports command + mcp_tool only → http/prompt/agent skipped.
  assert.deepEqual(config.SessionStart[0].hooks.map((h) => h.type), ['command', 'mcp_tool'])
  // PreCompact has no prompt support → the whole group is dropped.
  assert.equal(config.PreCompact, undefined)
  // Notification DOES support http → parsed, not skipped.
  assert.equal(config.Notification[0].hooks[0].type, 'http')

  assert.deepEqual(skipped.sort((a, b) => `${a.event}${a.type}`.localeCompare(`${b.event}${b.type}`)), [
    { event: 'PreCompact', type: 'prompt' },
    { event: 'SessionStart', type: 'agent' },
    { event: 'SessionStart', type: 'http' },
    { event: 'SessionStart', type: 'prompt' },
  ])
})

test('parse: EVENT_TYPE_SUPPORT covers all 31 events with the official matrix', () => {
  assert.equal(EVENT_TYPE_SUPPORT.size, CC_EVENTS.length)
  for (const event of CC_EVENTS) {
    assert.ok(EVENT_TYPE_SUPPORT.has(event), `matrix entry for ${event}`)
  }
  // SessionStart / Setup: command + mcp_tool only.
  for (const event of ['SessionStart', 'Setup']) {
    assert.deepEqual([...EVENT_TYPE_SUPPORT.get(event)].sort(), ['command', 'mcp_tool'])
  }
  // Five-type events.
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop']) {
    assert.deepEqual([...EVENT_TYPE_SUPPORT.get(event)].sort(), ['agent', 'command', 'http', 'mcp_tool', 'prompt'])
  }
  // Events without prompt/agent support.
  for (const event of ['SessionEnd', 'PreCompact', 'PostCompact', 'SubagentStart', 'Notification']) {
    assert.ok(!EVENT_TYPE_SUPPORT.get(event).has('prompt'), `${event} has no prompt support`)
    assert.ok(!EVENT_TYPE_SUPPORT.get(event).has('agent'), `${event} has no agent support`)
  }
})

// ─── substitution helpers ────────────────────────────────────────────────────

test('substitution: $ARGUMENTS with \\$ escape; ${path} input refs; header env allowlist', () => {
  const payload = { tool_name: 'Bash', cost: 5 }
  assert.equal(substituteArguments('x $ARGUMENTS y', payload), `x ${JSON.stringify(payload)} y`)
  assert.equal(substituteArguments('\\$1.00 and $ARGUMENTS', payload), `$1.00 and ${JSON.stringify(payload)}`)
  assert.deepEqual(
    substituteInputPaths({ a: '${tool_name}', b: '${missing.x}', c: { d: '${cost}' } }, payload),
    { a: 'Bash', b: '${missing.x}', c: { d: '5' } },
  )
  const env = { TOK: 'abc', OTHER: 'zzz' }
  assert.equal(interpolateHeaderValue('Bearer $TOK', ['TOK'], env), 'Bearer abc')
  assert.equal(interpolateHeaderValue('Bearer ${TOK}', ['TOK'], env), 'Bearer abc')
  assert.equal(interpolateHeaderValue('Bearer $OTHER', ['TOK'], env), 'Bearer ') // unlisted → empty string
  assert.equal(interpolateHeaderValue('Bearer $TOK', undefined, env), 'Bearer $TOK') // no allowlist → verbatim
})

test('timeout defaults follow the official per-type/per-event table', () => {
  assert.equal(defaultTimeoutMsFor('PreToolUse', 'command', 600_000), 600_000)
  assert.equal(defaultTimeoutMsFor('UserPromptSubmit', 'command', 600_000), 30_000)
  assert.equal(defaultTimeoutMsFor('UserPromptSubmit', 'http'), 30_000)
  assert.equal(defaultTimeoutMsFor('UserPromptSubmit', 'mcp_tool'), 30_000)
  assert.equal(defaultTimeoutMsFor('PreToolUse', 'prompt'), 30_000)
  assert.equal(defaultTimeoutMsFor('PreToolUse', 'agent'), 60_000)
  assert.equal(defaultTimeoutMsFor('Stop', 'command', 123_000), 123_000) // configured knob still applies
})

// ─── http executor ───────────────────────────────────────────────────────────

test('http: 2xx JSON decisions decode; non-2xx and bad bodies never block', async () => {
  const requests = []
  const { server, url } = await startServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, contentType: req.headers['content-type'], body })
      if (req.url === '/deny') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' } }))
      } else if (req.url === '/context') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'ctx!' } }))
      } else if (req.url === '/empty') {
        res.writeHead(204)
        res.end()
      } else if (req.url === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('plain text')
      } else if (req.url === '/error') {
        res.writeHead(500)
        res.end('boom')
      }
    })
  })
  try {
    const { logger, warns } = makeLogger()
    const ctx = { logger, get: () => undefined }
    const payload = { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }
    const opts = { event: 'PreToolUse', expectedEventName: 'PreToolUse', signal: new AbortController().signal }

    const deny = await runHttpHook(ctx, { url: `${url}/deny` }, payload, opts)
    assert.equal(deny.output.decision, 'deny')
    assert.equal(deny.output.reason, 'nope')
    assert.equal(requests[0].method, 'POST')
    assert.match(requests[0].contentType, /application\/json/)
    assert.equal(requests[0].body, JSON.stringify(payload))

    const note = await runHttpHook(ctx, { url: `${url}/context` }, payload, { ...opts, event: 'PostToolUse', expectedEventName: 'PostToolUse' })
    assert.equal(note.output.additionalContext, 'ctx!')

    const empty = await runHttpHook(ctx, { url: `${url}/empty` }, payload, opts)
    assert.equal(empty.output.decision, undefined)

    const before = warns.length
    const text = await runHttpHook(ctx, { url: `${url}/text` }, payload, opts)
    assert.equal(text.output.decision, undefined)
    assert.ok(warns.length > before, 'plain-text body warns')

    const before2 = warns.length
    const err = await runHttpHook(ctx, { url: `${url}/error` }, payload, opts)
    assert.equal(err.output.decision, undefined)
    assert.ok(warns.length > before2, 'non-2xx warns')
  } finally {
    server.close()
  }
})

test('http: connection failure and timeout are non-blocking', async () => {
  const { logger, warns } = makeLogger()
  const ctx = { logger, get: () => undefined }
  const opts = { event: 'PreToolUse', expectedEventName: 'PreToolUse', signal: new AbortController().signal }

  // Connection refused: close the listener, then fetch its port.
  const { server, url } = await startServer(() => {})
  server.close()
  await sleep(50)
  const refused = await runHttpHook(ctx, { url }, { x: 1 }, opts)
  assert.equal(refused.output.decision, undefined)
  assert.ok(warns.some((m) => m.includes('failed')), 'connection failure warns')

  // Timeout: server never responds; the hook deadline aborts it.
  const { server: s2, url: url2 } = await startServer(() => {})
  try {
    const timedOut = await runHttpHook(ctx, { url: url2, timeoutSec: 0.1 }, { x: 1 }, opts)
    assert.equal(timedOut.output.decision, undefined)
    assert.ok(timedOut.durationMs >= 80, `hook canceled by its deadline (${timedOut.durationMs}ms)`)
  } finally {
    s2.close()
  }
})

// ─── mcp_tool executor ───────────────────────────────────────────────────────

test('mcp_tool: calls the registered tool directly, parses text as exit-0 stdout', async () => {
  const calls = []
  const definition = {
    execute: async (input, exec) => {
      calls.push({ input, name: exec.name, hasSignal: exec.signal instanceof AbortSignal })
      return { content: [{ type: 'text', text: '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"scanned"}}' }] }
    },
  }
  const { logger } = makeLogger()
  const tools = { get: (name) => (name === 'mcp__srv__scan' ? definition : undefined) }
  const ctx = { logger, get: (n) => (n === 'tools' ? tools : undefined) }
  const hook = { server: 'srv', tool: 'scan', input: { path: '${tool_input.file_path}', nested: { depth: '${tool_input.deep.value}' } } }
  const payload = { tool_name: 'Write', tool_input: { file_path: '/x/y.txt', deep: { value: 'deepval' } } }
  const { output } = await runMcpToolHook(ctx, hook, payload, {
    event: 'PostToolUse', expectedEventName: 'PostToolUse', signal: new AbortController().signal,
  })
  assert.equal(output.additionalContext, 'scanned')
  assert.deepEqual(calls[0].input, { path: '/x/y.txt', nested: { depth: 'deepval' } })
  assert.equal(calls[0].name, 'mcp__srv__scan')
  assert.equal(calls[0].hasSignal, true)
})

test('mcp_tool: missing service/tool, isError throws, plugin-scoped names — all non-blocking', async () => {
  const { logger, warns } = makeLogger()
  const opts = { event: 'PostToolUse', expectedEventName: 'PostToolUse', signal: new AbortController().signal }

  const noService = { logger, get: () => undefined }
  const r1 = await runMcpToolHook(noService, { server: 's', tool: 't' }, {}, opts)
  assert.equal(r1.output.decision, undefined)
  assert.ok(warns.some((m) => m.includes('tools service unavailable')))

  warns.length = 0
  const emptyTools = { get: () => undefined }
  const r2 = await runMcpToolHook({ logger, get: (n) => (n === 'tools' ? emptyTools : undefined) }, { server: 's', tool: 't' }, {}, opts)
  assert.equal(r2.output.decision, undefined)
  assert.ok(warns.some((m) => m.includes('not connected')))

  // The mcp-client executor throws on an isError tool result — the hook must
  // swallow that as a non-blocking error.
  warns.length = 0
  const throwing = { execute: async () => { throw new Error('tool failed') } }
  const r3 = await runMcpToolHook({ logger, get: (n) => (n === 'tools' ? { get: () => throwing } : undefined) }, { server: 's', tool: 't' }, {}, opts)
  assert.equal(r3.output.decision, undefined)
  assert.ok(warns.some((m) => m.includes('failed')))

  assert.equal(mcpToolPublicName('plugin:my-plugin:db', 'query'), 'mcp__plugin_my-plugin_db__query')
  assert.equal(mcpToolPublicName('my_server', 'scan'), 'mcp__my_server__scan')
})

// ─── prompt executor ─────────────────────────────────────────────────────────

function mockLlm(chunks, seen) {
  return {
    stream: async function* (options) {
      seen?.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
}

function textChunks(text, finish = { kind: 'stop' }) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: finish },
  ]
}

test('prompt: {ok} answers decode; $ARGUMENTS substitution; model route fallbacks', async () => {
  const { logger } = makeLogger()
  const payload = { tool_name: 'Bash', tool_input: { command: 'ls' } }
  const opts = {
    event: 'PreToolUse', expectedEventName: 'PreToolUse', signal: new AbortController().signal,
    agent: { options: { provider: 'p1', model: 'm1' } },
  }

  // ok:false + reason → blocking decision; route from agent options.
  const seen = []
  const llm1 = mockLlm(textChunks('{"ok": false, "reason": "blocked by prompt"}'), seen)
  const r1 = await runPromptHook({ logger, get: (n) => (n === 'llm' ? llm1 : undefined) }, { prompt: 'check $ARGUMENTS' }, payload, opts)
  assert.equal(r1.output.decision, 'block')
  assert.equal(r1.output.reason, 'blocked by prompt')
  assert.ok(seen[0].messages[0].content[0].text.includes(JSON.stringify(payload)), '$ARGUMENTS substituted')
  assert.equal(seen[0].provider, 'p1')
  assert.equal(seen[0].model, 'm1')

  // ok:true → neutral.
  const llm2 = mockLlm(textChunks('{"ok": true}'))
  const r2 = await runPromptHook({ logger, get: (n) => (n === 'llm' ? llm2 : undefined) }, { prompt: 'x' }, payload, opts)
  assert.equal(r2.output.decision, undefined)

  // Code-fenced answers parse.
  const llm3 = mockLlm(textChunks('```json\n{"ok": false, "reason": "fenced"}\n```'))
  const r3 = await runPromptHook({ logger, get: (n) => (n === 'llm' ? llm3 : undefined) }, { prompt: 'x' }, payload, { ...opts, event: 'Stop', expectedEventName: 'Stop' })
  assert.equal(r3.output.decision, 'block')
  assert.equal(r3.output.reason, 'fenced')

  // Non-JSON answer → warn + neutral.
  const warns4 = []
  const llm4 = mockLlm(textChunks('I think yes'))
  const r4 = await runPromptHook({ logger: { info: () => {}, warn: (m) => warns4.push(m) }, get: (n) => (n === 'llm' ? llm4 : undefined) }, { prompt: 'x' }, payload, opts)
  assert.equal(r4.output.decision, undefined)
  assert.ok(warns4.some((m) => m.includes('no {"ok": bool} JSON')))

  // llm service missing → warn + neutral.
  const warns5 = []
  const r5 = await runPromptHook({ logger: { info: () => {}, warn: (m) => warns5.push(m) }, get: () => undefined }, { prompt: 'x' }, payload, opts)
  assert.equal(r5.output.decision, undefined)
  assert.ok(warns5.some((m) => m.includes('llm service unavailable')))

  // No model route (no hook.model, no agent options) → warn + neutral.
  const warns6 = []
  const llm6 = mockLlm(textChunks('{"ok": true}'))
  const r6 = await runPromptHook({ logger: { info: () => {}, warn: (m) => warns6.push(m) }, get: (n) => (n === 'llm' ? llm6 : undefined) }, { prompt: 'x' }, payload, { event: 'PreToolUse', expectedEventName: 'PreToolUse', signal: new AbortController().signal })
  assert.equal(r6.output.decision, undefined)
  assert.ok(warns6.some((m) => m.includes('no model route')))

  // hook.model "provider/model" splits; a bare model pairs with the agent provider.
  const seen7 = []
  const llm7 = mockLlm(textChunks('{"ok": true}'), seen7)
  const r7 = await runPromptHook({ logger, get: (n) => (n === 'llm' ? llm7 : undefined) }, { prompt: 'x', model: 'p7/m7' }, payload, { event: 'PreToolUse', expectedEventName: 'PreToolUse', signal: new AbortController().signal })
  assert.equal(seen7[0].provider, 'p7')
  assert.equal(seen7[0].model, 'm7')

  // LLM error finish → warn + neutral.
  const warns8 = []
  const llm8 = mockLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'boom' } } }])
  const r8 = await runPromptHook({ logger: { info: () => {}, warn: (m) => warns8.push(m) }, get: (n) => (n === 'llm' ? llm8 : undefined) }, { prompt: 'x' }, payload, opts)
  assert.equal(r8.output.decision, undefined)
  assert.ok(warns8.some((m) => m.includes('LLM call error')))
})

// ─── agent executor ──────────────────────────────────────────────────────────

test('agent: subagent {ok} answers decode; background/isError/missing degrade', async () => {
  const { logger, warns } = makeLogger()
  const payload = { tool_name: 'Bash', tool_input: { command: 'ls' } }
  const opts = {
    event: 'Stop', expectedEventName: 'Stop', signal: new AbortController().signal,
    agent: { options: { provider: 'p', model: 'm' } },
  }

  // ok:false → blocking decision; run_in_background pinned off; $ARGUMENTS substituted.
  const seen = []
  const tools = {
    get: (name) => (name === 'subagent' ? { parameters: { properties: { run_in_background: { type: 'boolean' } } } } : undefined),
    execute: async (exec) => {
      seen.push(exec)
      return { isError: false, value: { kind: 'foreground', runId: 'r1', output: [{ type: 'text', text: '{"ok": false, "reason": "stop check failed"}' }] }, content: [] }
    },
  }
  const ctx = { logger, get: (n) => (n === 'tools' ? tools : undefined) }
  const r1 = await runAgentHook(ctx, { prompt: 'verify $ARGUMENTS' }, payload, opts)
  assert.equal(r1.output.decision, 'block')
  assert.equal(r1.output.reason, 'stop check failed')
  assert.equal(seen[0].name, 'subagent')
  assert.equal(seen[0].arguments.run_in_background, false)
  assert.equal(seen[0].agent, opts.agent)
  assert.ok(seen[0].arguments.prompt.includes('"tool_name":"Bash"'))

  // ok:true → neutral.
  const tools2 = {
    get: () => ({}),
    execute: async () => ({ isError: false, value: { kind: 'foreground', runId: 'r2', output: [{ type: 'text', text: '{"ok": true}' }] }, content: [] }),
  }
  const r2 = await runAgentHook({ logger, get: (n) => (n === 'tools' ? tools2 : undefined) }, { prompt: 'x' }, payload, opts)
  assert.equal(r2.output.decision, undefined)

  // isError result → warn + neutral.
  const warns3 = []
  const tools3 = { get: () => ({}), execute: async () => ({ isError: true, error: { message: 'boom' }, content: [] }) }
  const r3 = await runAgentHook({ logger: { info: () => {}, warn: (m) => warns3.push(m) }, get: (n) => (n === 'tools' ? tools3 : undefined) }, { prompt: 'x' }, payload, opts)
  assert.equal(r3.output.decision, undefined)
  assert.ok(warns3.some((m) => m.includes('returned an error')))

  // Background result (no settled answer) → warn + neutral.
  const warns4 = []
  const tools4 = { get: () => ({}), execute: async () => ({ isError: false, value: { kind: 'background', jobId: 'j1' }, content: [] }) }
  const r4 = await runAgentHook({ logger: { info: () => {}, warn: (m) => warns4.push(m) }, get: (n) => (n === 'tools' ? tools4 : undefined) }, { prompt: 'x' }, payload, opts)
  assert.equal(r4.output.decision, undefined)
  assert.ok(warns4.some((m) => m.includes('expected foreground')))

  // Subagent tool not registered → warn + neutral.
  const warns5 = []
  const emptyTools = { get: () => undefined, execute: async () => ({}) }
  const r5 = await runAgentHook({ logger: { info: () => {}, warn: (m) => warns5.push(m) }, get: (n) => (n === 'tools' ? emptyTools : undefined) }, { prompt: 'x' }, payload, opts)
  assert.equal(r5.output.decision, undefined)
  assert.ok(warns5.some((m) => m.includes('subagent tool not registered')))

  // No tools service → warn + neutral.
  const warns6 = []
  const r6 = await runAgentHook({ logger: { info: () => {}, warn: (m) => warns6.push(m) }, get: () => undefined }, { prompt: 'x' }, payload, opts)
  assert.equal(r6.output.decision, undefined)
  assert.ok(warns6.some((m) => m.includes('tools service unavailable')))

  // No calling agent → warn + neutral.
  const warns7 = []
  const tools7 = { get: () => ({}), execute: async () => ({}) }
  const r7 = await runAgentHook({ logger: { info: () => {}, warn: (m) => warns7.push(m) }, get: (n) => (n === 'tools' ? tools7 : undefined) }, { prompt: 'x' }, payload, { event: 'Stop', expectedEventName: 'Stop', signal: new AbortController().signal })
  assert.equal(r7.output.decision, undefined)
  assert.ok(warns7.some((m) => m.includes('no calling agent')))
})

// ─── apply() dispatch integration ────────────────────────────────────────────

test('apply(): http/mcp_tool/prompt/agent hooks fire through runPoint dispatch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-hooks-be-home-'))
  let webhook
  const webhookBodies = []
  try {
    webhook = await startServer((req, res) => {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        webhookBodies.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'http says no' } }))
      })
    })
    const project = makeProject({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'http', url: `${webhook.url}/pre` }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'srv', tool: 'note', input: { text: '${tool_name}' } }] }],
      Stop: [{ hooks: [
        { type: 'prompt', prompt: 'stop? $ARGUMENTS' },
        { type: 'agent', prompt: 'verify $ARGUMENTS' },
      ] }],
    })
    const seen = { mcp: [], prompts: [], agents: [] }
    const tools = {
      get: (name) => {
        if (name === 'mcp__srv__note') {
          return { execute: async (input) => { seen.mcp.push(input); return { content: [{ type: 'text', text: '' }] } } }
        }
        if (name === 'subagent') return { parameters: {} }
        return undefined
      },
      execute: async (exec) => {
        seen.agents.push(exec)
        return { isError: false, value: { kind: 'foreground', runId: 'r', output: [{ type: 'text', text: '{"ok": true}' }] }, content: [] }
      },
    }
    const llm = {
      stream: async function* (options) {
        seen.prompts.push(options)
        yield { type: 'text-delta', index: 0, text: '{"ok": true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const ctx = makeCtx()
    ctx.get = (n) => (n === 'tools' ? tools : n === 'llm' ? llm : undefined)
    apply(ctx, { enableGlobal: false, homeDir: home, projectRootMarkers: ['.git'] })

    const agent = makeAgent(project)
    await ctx._listeners['agent/session-start']({ agent, source: 'startup' })
    await sleep(300)

    // PreToolUse bash → http hook denies (merged deny).
    const exec = execFor(agent, 'bash', { command: 'ls' })
    const decision = await ctx._listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /http says no/)
    assert.equal(webhookBodies.length, 1)
    assert.equal(JSON.parse(webhookBodies[0]).tool_name, 'bash')

    // PostToolUse bash → mcp_tool hook fires (neutral text).
    const result = { content: [{ type: 'text', text: 'ok' }] }
    const post = await ctx._listeners['tools/post-execute'](exec, result, async () => ({ kind: 'accept', content: [] }))
    assert.equal(post.kind, 'accept')
    assert.deepEqual(seen.mcp, [{ text: 'bash' }])

    // Stop → prompt + agent hooks both run (ok:true → no steer).
    await ctx._listeners['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(seen.prompts.length, 1)
    assert.ok(seen.prompts[0].messages[0].content[0].text.startsWith('stop? '), 'prompt hook prompt with $ARGUMENTS')
    assert.equal(seen.agents.length, 1)
    assert.ok(seen.agents[0].arguments.prompt.includes('verify'))

    rmSync(project, { recursive: true, force: true })
  } finally {
    webhook?.server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
