#!/usr/bin/env node
// Real command hook used by the remaining-20 fixture set.
//
// Reads the Claude Code hook payload from stdin, appends one JSON line to the
// file named by CC_HOOK_LOG (when set), and prints the decision shape selected
// by --mode. Every mode maps to a shape Claude Code documents for the event;
// the fixture tests drive it directly, and a real project can mount the same
// script under .claude/hooks/ to see which events actually fire.
//
// Usage: node record.mjs --event <EventName> [--mode record|context|block|deny|retry|path|display|elicit] [--log <file>]

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const readArg = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

const event = readArg('event') ?? 'Unknown'
const mode = readArg('mode') ?? 'record'
const logPath = readArg('log') ?? process.env.CC_HOOK_LOG

let raw = ''
try {
  raw = await new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
    if (process.stdin.isTTY) resolve('')
  })
} catch {
  raw = ''
}

let payload = null
try {
  payload = raw.trim() === '' ? null : JSON.parse(raw)
} catch {
  payload = { _unparsed: raw.trim() }
}

if (logPath !== undefined && logPath !== '') {
  appendFileSync(logPath, `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    mode,
    payload,
  })}\n`)
}

const emit = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exit(0)
}

const TOP_DECISION_EVENTS = new Set(['UserPromptExpansion', 'PostToolBatch', 'ConfigChange'])
const EXIT_TWO_EVENTS = new Set(['TaskCreated', 'TaskCompleted', 'TeammateIdle'])

const block = () => {
  if (EXIT_TWO_EVENTS.has(event)) {
    process.stderr.write(`${event} blocked by remaining-20 test hook\n`)
    process.exit(2)
  }
  if (event === 'PermissionRequest') {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'PermissionRequest denied by remaining-20 test hook' },
      },
    })
  }
  if (TOP_DECISION_EVENTS.has(event)) {
    emit({ decision: 'block', reason: `${event} blocked by remaining-20 test hook` })
  }
  // Events without decision control record and allow.
  process.exit(0)
}

switch (mode) {
  case 'context':
    emit({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: `${event} context from remaining-20 test hook`,
      },
    })
    break
  case 'block':
  case 'deny':
    block()
    break
  case 'retry':
    emit({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } })
    break
  case 'path': {
    const name = typeof payload?.name === 'string' && payload.name !== '' ? payload.name : 'worktree'
    process.stdout.write(`${join(tmpdir(), `cc-remaining20-${name}`)}\n`)
    process.exit(0)
    break
  }
  case 'display':
    emit({
      hookSpecificOutput: {
        hookEventName: 'MessageDisplay',
        displayContent: '[display text replaced by remaining-20 test hook]',
      },
    })
    break
  case 'elicit':
    emit({
      hookSpecificOutput: {
        hookEventName: event,
        action: 'accept',
        content: { answer: 'accepted by remaining-20 test hook' },
      },
    })
    break
  default:
    // record: no decision, only the log line.
    process.exit(0)
}
