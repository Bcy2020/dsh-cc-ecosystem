// Contract of dsh-cc-loader's telemetry module: what leaves the machine, when
// it leaves, how versions compare, and that the browser route only ever hands
// out allow-listed values. No network: every request goes through an injected
// fetch implementation.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  announce,
  compareVersions,
  createNoticeHandler,
  describeSelf,
  hashInstallId,
  isVersion,
  loadState,
  normaliseUpdate,
  noticeSnapshot,
  osFamily,
  saveState,
} from '../packages/cc-loader/src/telemetry.js'

const NOTES = 'https://github.com/Bcy2020/dsh-cc-ecosystem/releases/tag/v0.6.0'

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-telemetry-'))
  return { dir, path: join(dir, 'state.json') }
}

function quietContext() {
  const lines = []
  return {
    lines,
    logger: {
      info: (message) => lines.push(['info', message]),
      warn: (message) => lines.push(['warn', message]),
      error: (message) => lines.push(['error', message]),
      debug: () => {},
    },
  }
}

function reply(body) {
  return { ok: true, json: async () => body }
}

const UPDATE = {
  bundle: '0.6.0',
  notes: NOTES,
  updates: [{ name: 'dsh-cc-skills', latest: '0.6.0' }],
}

test('describeSelf reads the caller package manifest', () => {
  const self = describeSelf(new URL('../packages/cc-loader/src/index.js', import.meta.url).href)
  assert.equal(self.name, 'dsh-cc-loader')
  const manifest = JSON.parse(readFileSync(new URL('../packages/cc-loader/package.json', import.meta.url), 'utf8'))
  assert.equal(self.version, manifest.version)
  assert.equal(describeSelf('not a url'), undefined)
})

test('the install identifier is a stable SHA-256 hex digest', () => {
  const a = hashInstallId('11111111-2222-3333-4444-555555555555')
  const b = hashInstallId('11111111-2222-3333-4444-555555555555')
  const c = hashInstallId('another-id')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('osFamily sends a coarse family, never a version', () => {
  assert.equal(osFamily('win32'), 'win')
  assert.equal(osFamily('darwin'), 'mac')
  assert.equal(osFamily('linux'), 'linux')
  assert.equal(osFamily('freebsd'), 'other')
})

test('version comparison handles prereleases', () => {
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0)
  assert.equal(compareVersions('0.5.0', '0.5.1'), -1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.5.1-rc.1', '0.5.1'), -1)
  assert.equal(compareVersions('0.5.1-rc.10', '0.5.1-rc.2'), 1)
  assert.equal(compareVersions('nonsense', '0.5.0'), 0)
  assert.equal(isVersion('0.5.0'), true)
  assert.equal(isVersion('0.5'), false)
})

test('normaliseUpdate drops anything outside the allow-list', () => {
  assert.deepEqual(normaliseUpdate(UPDATE), UPDATE)
  assert.equal(normaliseUpdate({ ...UPDATE, bundle: 'latest' }), null)
  assert.equal(normaliseUpdate({ ...UPDATE, updates: [{ name: 'evil-package', latest: '9.9.9' }] }), null)
  assert.equal(normaliseUpdate({ ...UPDATE, updates: [{ name: 'dsh-cc-skills', latest: 'x' }] }), null)
  assert.equal(normaliseUpdate({ ...UPDATE, updates: [] }), null)
  assert.equal(normaliseUpdate(null), null)
  // A foreign notes URL is dropped, not the whole update.
  const foreign = normaliseUpdate({ ...UPDATE, notes: 'javascript:alert(1)' })
  assert.equal(foreign.notes, '')
})

test('state round-trips and rejects unknown shapes', () => {
  const { dir, path } = tempState()
  try {
    const empty = loadState(path)
    assert.equal(empty.reported && Object.keys(empty.reported).length, 0)
    empty.installId = 'id-1'
    empty.reported['dsh-cc-skills'] = '0.5.0'
    empty.latest = UPDATE
    saveState(path, empty)
    const loaded = loadState(path)
    assert.equal(loaded.installId, 'id-1')
    assert.equal(loaded.reported['dsh-cc-skills'], '0.5.0')
    assert.deepEqual(loaded.latest, UPDATE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one debounced hello carries every mounted package', async () => {
  const { dir, path } = tempState()
  const ctx = quietContext()
  const calls = []
  const options = {
    statePath: path,
    endpoint: 'https://receiver.test/v1',
    debounceMs: 0,
    allowInTest: true,
    platform: 'win32',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return reply(UPDATE)
    },
  }
  try {
    const first = announce(ctx, { name: 'dsh-cc-skills', version: '0.5.0' }, options)
    const second = announce(ctx, { name: 'dsh-cc-mcp', version: '0.5.0' }, options)
    await Promise.all([first, second])

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://receiver.test/v1/hello')
    assert.equal(calls[0].body.schema, 1)
    assert.match(calls[0].body.install, /^[0-9a-f]{64}$/)
    assert.equal(calls[0].body.os, 'win')
    assert.deepEqual(calls[0].body.packages, [
      { name: 'dsh-cc-skills', version: '0.5.0' },
      { name: 'dsh-cc-mcp', version: '0.5.0' },
    ])
    for (const field of ['cwd', 'user', 'host', 'profile', 'path', 'email']) {
      assert.equal(Object.hasOwn(calls[0].body, field), false, `${field} must not be sent`)
    }

    const state = loadState(path)
    assert.deepEqual(state.reported, { 'dsh-cc-skills': '0.5.0', 'dsh-cc-mcp': '0.5.0' })
    assert.deepEqual(state.latest, UPDATE)
    assert.match(state.installId, /^[0-9a-f-]{36}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second start with unchanged versions sends nothing; a new version sends once', async () => {
  const { dir, path } = tempState()
  const ctx = quietContext()
  const calls = []
  const options = (version) => ({
    statePath: path,
    endpoint: 'https://receiver.test/v1',
    debounceMs: 0,
    allowInTest: true,
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body))
      return reply(UPDATE)
    },
  })
  try {
    await announce(ctx, { name: 'dsh-cc-skills', version: '0.5.0' }, options())
    assert.equal(calls.length, 1)
    await announce(ctx, { name: 'dsh-cc-skills', version: '0.5.0' }, options())
    assert.equal(calls.length, 1, 'same version must not re-report')
    await announce(ctx, { name: 'dsh-cc-skills', version: '0.6.0' }, options())
    assert.equal(calls.length, 2, 'a new version reports once')
    assert.deepEqual(calls[1].packages, [{ name: 'dsh-cc-skills', version: '0.6.0' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed hello is retried on the next start, not marked as reported', async () => {
  const { dir, path } = tempState()
  const ctx = quietContext()
  let attempts = 0
  const options = {
    statePath: path,
    endpoint: 'https://receiver.test/v1',
    debounceMs: 0,
    allowInTest: true,
    fetchImpl: async () => {
      attempts += 1
      throw new Error('offline')
    },
  }
  try {
    await announce(ctx, { name: 'dsh-cc-skills', version: '0.5.0' }, options)
    assert.equal(attempts, 1)
    assert.deepEqual(loadState(path).reported, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an advertised version that is not newer than the install is ignored', async () => {
  const { dir, path } = tempState()
  try {
    await announce(quietContext(), { name: 'dsh-cc-skills', version: '0.5.0' }, {
      statePath: path,
      endpoint: 'https://receiver.test/v1',
      debounceMs: 0,
      allowInTest: true,
      fetchImpl: async () => reply({
        bundle: '0.4.0',
        notes: NOTES,
        updates: [{ name: 'dsh-cc-skills', latest: '0.4.0' }],
      }),
    })
    assert.equal(loadState(path).latest, null, 'a downgrade must never become a notice')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tests never reach the network unless explicitly allowed', async () => {
  const { dir, path } = tempState()
  let calls = 0
  try {
    const result = announce(quietContext(), { name: 'dsh-cc-skills', version: '0.5.0' }, {
      statePath: path,
      endpoint: 'https://receiver.test/v1',
      debounceMs: 0,
      fetchImpl: async () => { calls += 1; return reply(UPDATE) },
    })
    assert.equal(result, undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the notice route reports state, persists dismissal, and refuses strangers', async () => {
  const { dir, path } = tempState()
  const state = loadState(path)
  state.reported = { 'dsh-cc-skills': '0.5.0' }
  state.latest = UPDATE
  saveState(path, state)
  const hub = { statePath: path, state, selfs: new Map([['dsh-cc-skills', '0.5.0']]), inflight: null }
  const handler = createNoticeHandler(hub)

  const stateResponse = await call(handler, { url: '/cc-update/state', headers: { 'x-cc-update': '1' } })
  assert.equal(stateResponse.status, 200)
  assert.equal(stateResponse.body.ok, true)
  assert.equal(stateResponse.body.value.update.bundle, '0.6.0')
  assert.equal(stateResponse.body.value.bundleUser, false)
  assert.deepEqual(stateResponse.body.value.installed, ['dsh-cc-skills'])

  const refused = await call(handler, { url: '/cc-update/state', headers: {} })
  assert.equal(refused.status, 403)

  const dismissed = await call(handler, {
    url: '/cc-update/dismiss',
    method: 'POST',
    headers: { 'x-cc-update': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.6.0' }),
  })
  assert.equal(dismissed.status, 200)
  assert.equal(dismissed.body.value.dismissed, '0.6.0')
  assert.equal(loadState(path).dismissedVersion, '0.6.0')

  const bad = await call(handler, {
    url: '/cc-update/dismiss',
    method: 'POST',
    headers: { 'x-cc-update': '1' },
    body: JSON.stringify({ version: 'latest' }),
  })
  assert.equal(bad.status, 400)

  const snapshot = noticeSnapshot(hub)
  assert.equal(snapshot.bundleUser, false)

  rmSync(dir, { recursive: true, force: true })
})

function call(handler, { url, method = 'GET', headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const request = {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const response = {
    status: 0,
    payload: '',
    writeHead(status) { this.status = status },
    end(text) { this.payload = String(text ?? '') },
  }
  return handler(request, response).then(() => ({
    status: response.status,
    body: response.payload === '' ? null : JSON.parse(response.payload),
  }))
}
