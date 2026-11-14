// Behavioural coverage for the 20 hook events that are not wired yet.
//
// The fixture set under packages/cc-hooks/testdata/hooks/remaining20/ is a real
// mountable `.claude/hooks` configuration: every event points at record.mjs,
// which reads the CC stdin payload and emits the documented decision shape.
// These tests:
//   1. parse the fixture and check every event/matcher lands in the IR;
//   2. guard the current "parsed-but-inert" status (flip this as events wire);
//   3. execute record.mjs for every event and verify it records a real payload;
//   4. execute the decision modes that the CC reference documents.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseHooksConfig, WIRED_EVENTS } from '../packages/cc-hooks/src/parse.js'

const ROOT = join(import.meta.dirname, '..')
const FIXTURE_DIR = join(ROOT, 'packages', 'cc-hooks', 'testdata', 'hooks', 'remaining20')
const RECORD = join(FIXTURE_DIR, 'record.mjs')
const FIXTURE = JSON.parse(readFileSync(join(FIXTURE_DIR, 'hooks.json'), 'utf8'))

const REMAINING_20 = {
  Setup: 'init|maintenance',
  UserPromptExpansion: 'commit',
  PermissionRequest: 'Bash',
  PermissionDenied: 'Bash',
  PostToolBatch: undefined,
  Notification: 'permission_prompt|idle_prompt',
  MessageDisplay: undefined,
  TaskCreated: undefined,
  TaskCompleted: undefined,
  StopFailure: 'rate_limit|overloaded|server_error',
  TeammateIdle: undefined,
  InstructionsLoaded: 'session_start|nested_traversal',
  ConfigChange: 'project_settings|user_settings',
  CwdChanged: undefined,
  DirectoryAdded: 'slash_command|register_repo_root',
  FileChanged: '.envrc|.env',
  WorktreeCreate: undefined,
  WorktreeRemove: undefined,
  Elicitation: 'memory',
  ElicitationResult: 'memory',
}

const SAMPLE = {
  Setup: { hook_event_name: 'Setup', trigger: 'init', cwd: '/repo' },
  UserPromptExpansion: {
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    command_name: 'commit',
    command_args: '-m fix',
    command_source: 'project',
    prompt: 'Commit the current changes',
  },
  PermissionRequest: {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    permission_suggestions: [],
  },
  PermissionDenied: {
    hook_event_name: 'PermissionDenied',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
    tool_use_id: 'toolu_01',
    reason: 'auto mode denied',
  },
  PostToolBatch: {
    hook_event_name: 'PostToolBatch',
    tool_calls: [
      { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_02', tool_response: { stdout: 'src' } },
    ],
  },
  Notification: {
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
    title: 'Claude Code',
    notification_type: 'permission_prompt',
  },
  MessageDisplay: {
    hook_event_name: 'MessageDisplay',
    turn_id: 'turn-1',
    message_id: 'msg-1',
    index: 0,
    final: true,
    delta: 'Hello, world',
  },
  TaskCreated: {
    hook_event_name: 'TaskCreated',
    task_id: 'task-1',
    task_subject: 'Write the remaining hook tests',
    task_description: 'Add fixtures for all 20 events',
  },
  TaskCompleted: {
    hook_event_name: 'TaskCompleted',
    task_id: 'task-1',
    task_subject: 'Write the remaining hook tests',
  },
  StopFailure: {
    hook_event_name: 'StopFailure',
    error: 'rate_limit',
    error_details: { status: 429 },
    last_assistant_message: 'I was about to finish',
  },
  TeammateIdle: { hook_event_name: 'TeammateIdle', teammate_name: 'reviewer', team_name: 'core' },
  InstructionsLoaded: {
    hook_event_name: 'InstructionsLoaded',
    file_path: '/repo/CLAUDE.md',
    memory_type: 'Project',
    load_reason: 'session_start',
  },
  ConfigChange: {
    hook_event_name: 'ConfigChange',
    source: 'project_settings',
    file_path: '/repo/.claude/settings.json',
  },
  CwdChanged: { hook_event_name: 'CwdChanged', old_cwd: '/repo', new_cwd: '/repo/packages' },
  DirectoryAdded: {
    hook_event_name: 'DirectoryAdded',
    directory: '/repo/packages',
    source: 'slash_command',
  },
  FileChanged: { hook_event_name: 'FileChanged', file_path: '/repo/.env', event: 'change' },
  WorktreeCreate: { hook_event_name: 'WorktreeCreate', name: 'feature-x' },
  WorktreeRemove: { hook_event_name: 'WorktreeRemove', worktree_path: '/repo/.worktrees/feature-x' },
  Elicitation: {
    hook_event_name: 'Elicitation',
    mcp_server_name: 'memory',
    message: 'Which namespace?',
    mode: 'form',
    requested_schema: { type: 'object', properties: { namespace: { type: 'string' } } },
  },
  ElicitationResult: {
    hook_event_name: 'ElicitationResult',
    mcp_server_name: 'memory',
    action: 'accept',
    content: { namespace: 'project' },
  },
}

function runRecord(event, mode = 'record', payload = SAMPLE[event]) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-remaining20-'))
  const log = join(dir, 'hooks.jsonl')
  const args = [RECORD, '--event', event, '--mode', mode]
  const child = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload ?? {}),
    env: { ...process.env, CC_HOOK_LOG: log },
    encoding: 'utf8',
  })
  let lines = []
  try {
    lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    lines = []
  }
  rmSync(dir, { recursive: true, force: true })
  return { ...child, lines }
}

test('remaining20 fixture parses all 20 events with their matcher subjects', () => {
  const parsed = parseHooksConfig(FIXTURE)

  assert.deepEqual(parsed.skipped, [], 'every fixture hook is a supported command hook')
  assert.deepEqual(Object.keys(parsed.config).sort(), Object.keys(REMAINING_20).sort())

  for (const [event, matcher] of Object.entries(REMAINING_20)) {
    const groups = parsed.config[event]
    assert.equal(groups.length, 1, `${event}: exactly one matcher group`)
    const group = groups[0]
    if (matcher === undefined) {
      assert.equal('matcher' in group, false, `${event}: no matcher subject, matcher must be dropped`)
    } else {
      assert.equal(group.matcher, matcher, `${event}: matcher preserved`)
    }
    const hook = group.hooks[0]
    assert.equal(hook.type, 'command', `${event}: command hook`)
    assert.ok(hook.command.includes(`--event ${event}`), `${event}: command targets record.mjs for this event`)
  }
})

test('guard: the W1 events are wired; the other 15 stay parsed-but-inert', () => {
  // Keep this list in lockstep with the weekly batches: an event moves here
  // when its wiring lands, out of the inert half of the assertion.
  const WIRED_IN_W1 = ['CwdChanged', 'StopFailure', 'InstructionsLoaded', 'PermissionRequest', 'PermissionDenied']
  for (const event of Object.keys(REMAINING_20)) {
    if (WIRED_IN_W1.includes(event)) {
      assert.ok(WIRED_EVENTS.includes(event), `${event} should be wired`)
    } else {
      assert.ok(!WIRED_EVENTS.includes(event), `${event} unexpectedly wired; move it out of this guard`)
    }
  }
})

test('record.mjs receives and records a realistic payload for every event', () => {
  for (const event of Object.keys(REMAINING_20)) {
    const result = runRecord(event)
    assert.equal(result.status, 0, `${event}: hook exits 0 in record mode`)
    assert.equal(result.lines.length, 1, `${event}: one JSON line appended`)
    assert.equal(result.lines[0].event, event)
    assert.equal(result.lines[0].mode, 'record')
    assert.deepEqual(result.lines[0].payload, SAMPLE[event], `${event}: stdin payload round-trips intact`)
  }
})

test('record.mjs emits the documented decision shapes', () => {
  {
    const result = runRecord('PermissionRequest', 'deny')
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest')
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny')
    assert.equal(result.status, 0)
  }
  {
    const result = runRecord('PermissionDenied', 'retry')
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionDenied')
    assert.equal(out.hookSpecificOutput.retry, true)
  }
  {
    const result = runRecord('PostToolBatch', 'block')
    assert.equal(JSON.parse(result.stdout).decision, 'block')
    assert.equal(result.status, 0)
  }
  {
    const result = runRecord('TaskCreated', 'block')
    assert.equal(result.status, 2, 'TaskCreated blocks through exit code 2')
    assert.match(result.stderr, /blocked by remaining-20 test hook/)
  }
  {
    const result = runRecord('WorktreeCreate', 'path')
    assert.equal(result.status, 0)
    assert.ok(result.stdout.trim().length > 0, 'WorktreeCreate prints a worktree path')
  }
  {
    const result = runRecord('MessageDisplay', 'display')
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.hookEventName, 'MessageDisplay')
    assert.equal(typeof out.hookSpecificOutput.displayContent, 'string')
  }
  {
    const result = runRecord('Elicitation', 'elicit')
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.action, 'accept')
    assert.deepEqual(out.hookSpecificOutput.content, { answer: 'accepted by remaining-20 test hook' })
  }
  {
    const result = runRecord('Setup', 'context')
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.hookEventName, 'Setup')
    assert.match(out.hookSpecificOutput.additionalContext, /Setup context/)
  }
})
