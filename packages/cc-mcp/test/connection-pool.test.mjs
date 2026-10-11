// Pooled MCP connections (src/register.js).
//
// The pool is what makes a second visit to a server cheap: an unchanged config
// reuses the live client and the tool list it already fetched, the way Claude
// Code retains MCP clients across `reconcileMcpServers` runs
// (module-1115.js — only `areMcpConfigsEqual` being false causes a re-dial).
//
// Each test proves its claim with the server's OWN pid log rather than by
// inspecting the pool, so "it was not re-spawned" is observed, not assumed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquire, armIdle, release, invalidate, drainPool, poolKeyOf, poolStats } from '../src/register.js'

const ECHO_SERVER = fileURLToPath(new URL('./mcp-echo-server.mjs', import.meta.url))
const IDLE_MS = 60000

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-pool-'))
  const pidFile = join(dir, 'pids.txt')
  return {
    dir,
    pidFile,
    /**
     * One user-scope stdio entry. `args` overrides are how a test changes the
     * config without changing the identity.
     */
    entry: (overrides = {}) => ({
      serverName: 'echo',
      scope: 'user',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER],
      env: { MCP_ECHO_PID_FILE: pidFile },
      idleTimeoutMs: IDLE_MS,
      ...overrides,
    }),
    /** Every pid the echo server has recorded — one line per process spawn. */
    spawns: () => {
      try {
        return readFileSync(pidFile, 'utf8').trim().split('\n').filter((line) => line !== '')
      } catch {
        return []
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

test('an unchanged config is dialed ONCE and every later acquire reuses it', async () => {
  const f = fixture()
  try {
    const first = await acquire(f.entry(), { idleTimeoutMs: IDLE_MS })
    assert.equal(first.tools.length, 1)
    assert.equal(first.tools[0].name, 'echo')
    assert.equal(f.spawns().length, 1)

    // What a second session does: ask for the same server. It must get the same
    // client — and the server must not have been started a second time.
    const second = await acquire(f.entry(), { idleTimeoutMs: IDLE_MS })
    assert.equal(second, first, 'the same pool entry comes back')
    assert.equal(second.client, first.client)
    assert.equal(f.spawns().length, 1, 'the server was not spawned again')
    assert.equal(poolStats().length, 1)

    // Releasing (a session ending) must NOT close it: the pool keeps it warm.
    await release(first)
    const third = await acquire(f.entry(), { idleTimeoutMs: IDLE_MS })
    assert.equal(third.client, first.client)
    assert.equal(f.spawns().length, 1)
  } finally {
    await drainPool()
    f.cleanup()
  }
})

test('a changed config is a different identity and gets its own process', async () => {
  const f = fixture()
  const changed = f.entry({ args: [ECHO_SERVER, '--extra'] })
  try {
    const a = await acquire(f.entry(), { idleTimeoutMs: IDLE_MS })
    const b = await acquire(changed, { idleTimeoutMs: IDLE_MS })
    assert.notEqual(poolKeyOf(f.entry()), poolKeyOf(changed), 'the fingerprint differs')
    assert.notEqual(b, a, 'a changed config must not reuse the old client')
    assert.equal(poolStats().length, 2)
    assert.equal(f.spawns().length, 2)
  } finally {
    await drainPool()
    f.cleanup()
  }
})

test('scope is part of the identity: a user and a project server never share', async () => {
  const f = fixture()
  try {
    assert.notEqual(
      poolKeyOf(f.entry({ scope: 'user' })),
      poolKeyOf(f.entry({ scope: 'project' })),
    )
  } finally {
    f.cleanup()
  }
})

test('the spawn cwd is NOT part of the identity (a warm server survives a new workspace)', async () => {
  const f = fixture()
  try {
    const otherCwd = join(f.dir, 'elsewhere')
    const a = await acquire(f.entry(), { baseCwd: f.dir, idleTimeoutMs: IDLE_MS })
    // A second session in a different workspace: same server, same client.
    const b = await acquire(f.entry(), { baseCwd: otherCwd, idleTimeoutMs: IDLE_MS })
    assert.equal(b.client, a.client)
    assert.equal(f.spawns().length, 1)
  } finally {
    await drainPool()
    f.cleanup()
  }
})

test('invalidate() closes the client, so the next acquire really re-dials', async () => {
  const f = fixture()
  try {
    const first = await acquire(f.entry(), { idleTimeoutMs: IDLE_MS })
    await invalidate(poolKeyOf(f.entry()))
    assert.equal(poolStats().length, 0)

    const second = await acquire(f.entry(), { idleTimeoutMs: IDLE_MS })
    assert.notEqual(second, first)
    assert.equal(f.spawns().length, 2, 'the manual-reconnect path starts a fresh process')
  } finally {
    await drainPool()
    f.cleanup()
  }
})

test('an idle connection closes itself, and the next acquire dials again', async () => {
  const f = fixture()
  try {
    const conn = await acquire(f.entry(), { idleTimeoutMs: 150 })
    await release(conn)
    assert.equal(await waitFor(() => poolStats().length === 0), true, 'idle close fires')

    await acquire(f.entry(), { idleTimeoutMs: 150 })
    assert.equal(f.spawns().length, 2)
  } finally {
    await drainPool()
    f.cleanup()
  }
})

test('a call in flight is never closed by the idle timer', async () => {
  const f = fixture()
  try {
    const conn = await acquire(f.entry(), { idleTimeoutMs: 100 })
    conn.busy = 1
    armIdle(conn)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(poolStats().length, 1, 'still open while busy')

    conn.busy = 0
    armIdle(conn)
    assert.equal(await waitFor(() => poolStats().length === 0), true, 'closes once the call ends')
  } finally {
    await drainPool()
    f.cleanup()
  }
})

test('drainPool() closes everything (plugin unload must not leak child processes)', async () => {
  const f = fixture()
  try {
    await acquire(f.entry(), { idleTimeoutMs: IDLE_MS })
    await acquire(f.entry({ args: [ECHO_SERVER, '--two'] }), { idleTimeoutMs: IDLE_MS })
    assert.equal(poolStats().length, 2)

    await drainPool()
    assert.deepEqual(poolStats(), [])
    assert.equal(f.spawns().length, 2)
  } finally {
    await drainPool()
    f.cleanup()
  }
})
