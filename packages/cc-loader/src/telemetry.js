// Anonymous install reporting + update-notice data for every dsh-cc package.
//
// Every adapter calls `announce(ctx, describeSelf(import.meta.url))` at the top
// of `apply()`. The first call in a process starts a short debounce, so one
// installation sends ONE request carrying the whole mounted package set (that
// set is also how a bundle install — all six adapters — is told apart from
// someone installing a single package).
//
// What is sent, and nothing else:
//   schema, install (SHA-256 of a random per-install UUID), os family,
//   and the {name, version} pairs of the mounted packages.
// No path, user name, host name, profile name, locale, time zone, user agent,
// conversation, or .claude content leaves the machine. The receiver is not in
// this repository; its URL lives in DEFAULT_ENDPOINT. An empty endpoint means
// nothing is ever sent (the update notice still works from cached state).
//
// The same request returns the newest release the receiver is willing to
// advertise. Releases younger than 24 h are withheld server-side because
// pnpm 11's minimumReleaseAge would otherwise resolve them back to the older
// version — silently, with exit code 0.
//
// Wire contract (the receiver is deployed separately, outside this repository):
//   POST {endpoint}/hello
//     { schema, install, os, packages: [{ name, version }] }
//   -> { bundle, notes?, updates: [{ name, latest }] }
//   `updates` must list only packages whose latest version is newer than the
//   submitted one; `notes` must be a URL under the project's releases path.
//   The client re-validates all of it and ignores anything else.
//
// Every entry point is wrapped: telemetry must never break plugin loading.

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Wire format version of the hello request. */
export const SCHEMA_VERSION = 1
/** Shape version of the persisted state file. */
export const STATE_VERSION = 1

/**
 * Receiver base URL. Empty disables sending entirely; while it is empty the
 * client only reads cached state. Deployed at Cloudflare Pages because
 * *.workers.dev is unreachable from some networks.
 */
export const DEFAULT_ENDPOINT = 'https://dsh-cc-telemetry.pages.dev/v1'

/** The six adapters the umbrella mounts; also the bundle-install signature. */
export const ECOSYSTEM_PACKAGES = [
  'dsh-cc-skills',
  'dsh-cc-permissions',
  'dsh-cc-agents',
  'dsh-cc-hooks',
  'dsh-cc-mcp',
  'dsh-cc-memory',
]

/** Where the release notes are allowed to point. */
const NOTES_ORIGIN = 'https://github.com/Bcy2020/dsh-cc-ecosystem/releases/'

/** How long to collect mounts before sending the one hello. */
const DEBOUNCE_MS = 250
/** Hard cap on the hello request. Generous: the request is fire-and-forget,
 *  and some networks need several seconds just to establish the connection. */
const REQUEST_TIMEOUT_MS = 5000
/** A cached notice is shown once per version, not on every start. */
const CLI_NOTICE_MARKER = 'notifiedVersion'
/** Route the browser half polls for the banner. */
export const NOTICE_CHANNEL = '/cc-update'
/** Header the browser half sets; a cross-site fetch cannot set it without a
 *  CORS preflight this server never grants. */
export const CALLER_HEADER = 'x-cc-update'

/** Strict semver: the only shape ever substituted into a copyable command. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const HUB_REGISTRY = Symbol.for('dsh-cc-telemetry')
const SELF_CACHE = new Map()

/* ────────────────────────────── self description ───────────────────────── */

/**
 * Read a package's own name and version. Call with the adapter's
 * `import.meta.url`; `../package.json` is the package root.
 * @param {string} importMetaUrl
 * @returns {{ name: string, version: string } | undefined}
 */
export function describeSelf(importMetaUrl) {
  try {
    const cached = SELF_CACHE.get(importMetaUrl)
    if (cached !== undefined) return cached
    const require = createRequire(importMetaUrl)
    const pkg = require('../package.json')
    const name = typeof pkg?.name === 'string' ? pkg.name : ''
    const version = typeof pkg?.version === 'string' ? pkg.version : ''
    if (name === '' || !SEMVER.test(version)) return undefined
    const self = { name, version }
    SELF_CACHE.set(importMetaUrl, self)
    return self
  } catch {
    return undefined
  }
}

/* ─────────────────────────────── state file ────────────────────────────── */

/**
 * Default state-file location: `$DSH_HOME/cc-ecosystem-state.json`, falling
 * back to `~/.dsh/cc-ecosystem-state.json` (same convention as cc-memory).
 * @returns {string}
 */
export function defaultStatePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'cc-ecosystem-state.json')
}

/**
 * Load the state file. Anything unreadable or malformed falls back to a fresh
 * state — the file is a cache, never a source of truth worth failing over.
 * @param {string} path
 * @returns {{ version: number, installId: string, reported: Record<string, string>,
 *   latest: null | { bundle: string, notes: string, updates: { name: string, latest: string }[] },
 *   dismissedVersion: string | null, notifiedVersion: string | null }}
 */
export function loadState(path) {
  const empty = {
    version: STATE_VERSION,
    installId: '',
    reported: {},
    latest: null,
    dismissedVersion: null,
    notifiedVersion: null,
  }
  let raw
  try {
    raw = readFileSync(resolve(path), { encoding: 'utf8' })
  } catch {
    return empty
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return empty
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return empty
  if (data.version !== STATE_VERSION) return empty
  const reported = {}
  if (data.reported !== null && typeof data.reported === 'object' && !Array.isArray(data.reported)) {
    for (const [name, version] of Object.entries(data.reported)) {
      if (typeof name === 'string' && typeof version === 'string' && SEMVER.test(version)) reported[name] = version
    }
  }
  return {
    version: STATE_VERSION,
    installId: typeof data.installId === 'string' ? data.installId : '',
    reported,
    latest: pruneUpdate(normaliseUpdate(data.latest), reported),
    dismissedVersion: typeof data.dismissedVersion === 'string' && SEMVER.test(data.dismissedVersion)
      ? data.dismissedVersion : null,
    notifiedVersion: typeof data.notifiedVersion === 'string' && SEMVER.test(data.notifiedVersion)
      ? data.notifiedVersion : null,
  }
}

/**
 * Keep only updates strictly newer than what this install already reports.
 * The receiver is expected to filter too; this is the client-side guard that
 * makes a buggy or compromised receiver unable to advertise a downgrade.
 */
function pruneUpdate(update, reported) {
  if (update === null) return null
  const updates = update.updates.filter((entry) => compareVersions(entry.latest, reported[entry.name] ?? '0.0.0') > 0)
  return updates.length === 0 ? null : { ...update, updates }
}

/**
 * Persist the state atomically (write + rename, same as cc-memory).
 * @param {string} path
 * @param {object} state
 */
export function saveState(path, state) {
  try {
    const target = resolve(path)
    mkdirSync(dirname(target), { recursive: true })
    const text = `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(temporary, text, { encoding: 'utf8' })
      renameSync(temporary, target)
    } finally {
      try { unlinkSync(temporary) } catch { /* renamed or never created */ }
    }
  } catch {
    /* a state write failure must never surface */
  }
}

/* ──────────────────────────────── helpers ──────────────────────────────── */

/** Coarse platform family; the only machine detail ever sent. */
export function osFamily(platform = process.platform) {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') return 'linux'
  return 'other'
}

/** SHA-256 hex of the local random install id. */
export function hashInstallId(installId) {
  return createHash('sha256').update(String(installId)).digest('hex')
}

/** True when `value` is a strict semver string. */
export function isVersion(value) {
  return typeof value === 'string' && SEMVER.test(value)
}

function parseVersion(value) {
  if (!isVersion(value)) return undefined
  const [core, pre = null] = value.split('-', 2)
  const [major, minor, patch] = core.split('.').map((part) => Number(part))
  return { major, minor, patch, pre }
}

/**
 * Semver precedence. Unknown shapes compare equal (callers validate first).
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const l = left.pre.split('.')
  const r = right.pre.split('.')
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const lv = l[index]
    const rv = r[index]
    if (lv === undefined) return -1
    if (rv === undefined) return 1
    const ln = /^\d+$/.test(lv) ? Number(lv) : undefined
    const rn = /^\d+$/.test(rv) ? Number(rv) : undefined
    if (ln !== undefined && rn !== undefined) {
      if (ln !== rn) return ln < rn ? -1 : 1
      continue
    }
    if (ln !== undefined) return -1
    if (rn !== undefined) return 1
    if (lv !== rv) return lv < rv ? -1 : 1
  }
  return 0
}

/**
 * Validate whatever the receiver returned. Only allow-listed package names,
 * strict semvers and release-notes URLs on the project's own releases path
 * survive: the browser half turns these into copyable shell commands, so the
 * server must never be able to influence anything but the version number.
 * @returns {null | { bundle: string, notes: string, updates: { name: string, latest: string }[] }}
 */
export function normaliseUpdate(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    if (!isVersion(value.bundle)) return null
    const notes = typeof value.notes === 'string' && value.notes.startsWith(NOTES_ORIGIN) ? value.notes : ''
    if (!Array.isArray(value.updates)) return null
    const updates = []
    for (const entry of value.updates) {
      if (entry === null || typeof entry !== 'object') continue
      if (!ECOSYSTEM_PACKAGES.includes(entry.name) || !isVersion(entry.latest)) continue
      updates.push({ name: entry.name, latest: entry.latest })
    }
    if (updates.length === 0) return null
    return { bundle: value.bundle, notes, updates }
  } catch {
    return null
  }
}

/* ─────────────────────────────── the hub ───────────────────────────────── */

function hubFor(statePath) {
  let registry = globalThis[HUB_REGISTRY]
  if (!(registry instanceof Map)) {
    registry = new Map()
    globalThis[HUB_REGISTRY] = registry
  }
  let hub = registry.get(statePath)
  if (hub === undefined) {
    hub = {
      statePath,
      state: loadState(statePath),
      selfs: new Map(),
      ctx: undefined,
      timer: null,
      inflight: null,
      routeInstalled: false,
      pending: null,
    }
    registry.set(statePath, hub)
  }
  return hub
}

/**
 * Announce this package's mount. One request per install/upgrade, carrying
 * every package that mounted in this process.
 *
 * @param {object} ctx - plugin context (only `inject`/`logger` are used).
 * @param {{ name: string, version: string }} self
 * @param {{ endpoint?: string, statePath?: string, fetchImpl?: Function, platform?: string }} [options]
 */
export function announce(ctx, self, options = {}) {
  try {
    if (isTestRun() && options.allowInTest !== true) return undefined
    if (self === undefined || self === null) return undefined
    if (typeof self.name !== 'string' || !isVersion(self.version)) return undefined
    const hub = hubFor(resolve(options.statePath ?? defaultStatePath()))
    hub.selfs.set(self.name, self.version)
    if (hub.ctx === undefined && ctx !== undefined) hub.ctx = ctx

    if (!hub.routeInstalled) {
      hub.routeInstalled = true
      registerNoticeRoute(ctx, hub, options)
    }

    logNotice(hub)

    const endpoint = normaliseEndpoint(options.endpoint ?? DEFAULT_ENDPOINT)
    if (endpoint === '') return undefined
    return scheduleHello(hub, endpoint, options)
  } catch {
    /* never throw out of apply() */
    return undefined
  }
}

/** node:test sets this; CI must never hit the real receiver. */
function isTestRun() {
  return typeof process !== 'undefined' && typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT !== ''
}

function normaliseEndpoint(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return value.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function scheduleHello(hub, endpoint, options) {
  if (hub.pending !== null) return hub.pending
  let resolve
  hub.pending = new Promise((done) => { resolve = done })
  const delay = options.debounceMs ?? DEBOUNCE_MS
  hub.timer = setTimeout(() => {
    hub.timer = null
    flush(hub, endpoint, options).catch(() => {}).then(() => {
      hub.pending = null
      resolve()
    })
  }, delay)
  // Unref only the production debounce: a short-lived process may exit before
  // it fires. A zero delay is the "nothing to batch" case, where the timer is
  // the only thing the returned promise is waiting on.
  if (delay > 0 && typeof hub.timer?.unref === 'function') hub.timer.unref()
  return hub.pending
}

async function flush(hub, endpoint, options) {
  const packages = [...hub.selfs.entries()].map(([name, version]) => ({ name, version }))
  const changed = packages.some((entry) => hub.state.reported[entry.name] !== entry.version)
  if (changed) {
    if (hub.state.installId === '') hub.state.installId = randomUUID()
    const body = {
      schema: SCHEMA_VERSION,
      install: hashInstallId(hub.state.installId),
      os: osFamily(options.platform ?? process.platform),
      packages,
    }
    hub.inflight = requestJson(`${endpoint}/hello`, {
      body,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    })
    const answer = await hub.inflight
    hub.inflight = null
    if (answer === undefined) return
    // Only a delivered hello marks the versions as reported: a machine that is
    // offline now is counted on a later start instead of never.
    for (const entry of packages) hub.state.reported[entry.name] = entry.version
    hub.state.latest = pruneUpdate(normaliseUpdate(answer), hub.state.reported)
    saveState(hub.statePath, hub.state)
  }
  logNotice(hub)
}

async function requestJson(url, options) {
  try {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      })
      if (!response || response.ok !== true) return undefined
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}

/* ──────────────────────────── notices ──────────────────────────────────── */

/** CLI half: one line per release, never a prompt injection. */
function logNotice(hub) {
  const latest = hub.state.latest
  if (latest === null) return
  if (latest.bundle === hub.state.dismissedVersion) return
  if (latest.bundle === hub.state.notifiedVersion) return
  hub.state.notifiedVersion = latest.bundle
  saveState(hub.statePath, hub.state)
  const target = describeTarget(hub, latest)
  log(hub.ctx, 'info', `有新版本可用:${target}(当前 ${currentVersionLabel(hub)})`)
}

function currentVersionLabel(hub) {
  const versions = [...hub.selfs.values()]
  if (versions.length === 0) return '未知'
  return versions.slice().sort(compareVersions).at(-1)
}

function describeTarget(hub, latest) {
  if (isBundleUser(hub)) return `dsh-cc-ecosystem@${latest.bundle}`
  const first = latest.updates[0]
  return first === undefined ? `dsh-cc-ecosystem@${latest.bundle}` : `${first.name}@${first.latest}`
}

/** True when every umbrella adapter has reported in this install. */
function isBundleUser(hub) {
  return ECOSYSTEM_PACKAGES.every((name) => typeof hub.state.reported[name] === 'string')
}

function log(ctx, level, message) {
  try { ctx?.logger?.[level]?.(`cc-update: ${message}`) } catch { /* logger absence is not fatal */ }
}

/* ──────────────────────────── browser route ────────────────────────────── */

/**
 * Register `/cc-update/*` on the host's web server once per process. The route
 * exists even when no endpoint is configured: the browser half still reads
 * cached state.
 */
function registerNoticeRoute(ctx, hub, options) {
  try {
    if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (scope) => {
      try {
        scope.effect(() => scope.webServer.register({
          kind: 'prefix',
          path: NOTICE_CHANNEL,
          handler: createNoticeHandler(hub, options),
        }), 'cc-update: notice route')
      } catch {
        /* the host may lack a web server; the banner simply never appears */
      }
    })
  } catch {
    /* same */
  }
}

/** Wait for an in-flight hello so the first GUI load sees fresh state. */
async function settle(hub, timeoutMs = 2000) {
  if (hub.inflight === null) return
  try {
    await Promise.race([
      hub.inflight,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
  } catch {
    /* the hello failure is already absorbed in flush() */
  }
}

/**
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createNoticeHandler(hub, options = {}) {
  return async function handle(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const endpoint = url.pathname.startsWith(`${NOTICE_CHANNEL}/`)
        ? url.pathname.slice(NOTICE_CHANNEL.length + 1)
        : ''
      if (endpoint !== 'state' && endpoint !== 'dismiss') {
        sendJson(response, 404, fail('cc-update/unknown-endpoint', 'unknown endpoint'))
        return
      }
      if (!trustedCaller(request)) {
        sendJson(response, 403, fail('cc-update/untrusted-origin', 'the request did not come from this plugin'))
        return
      }
      if (endpoint === 'state') {
        if ((request.method ?? 'GET') !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        await settle(hub)
        sendJson(response, 200, ok(noticeSnapshot(hub)))
        return
      }
      if ((request.method ?? 'GET') !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const payload = await readJsonBody(request)
      const version = typeof payload?.version === 'string' ? payload.version : ''
      if (!isVersion(version)) {
        sendJson(response, 400, fail('cc-update/bad-request', 'version must be a semver string'))
        return
      }
      hub.state.dismissedVersion = version
      saveState(hub.statePath, hub.state)
      sendJson(response, 200, ok(noticeSnapshot(hub)))
    } catch {
      try { sendJson(response, 500, fail('cc-update/internal', 'request failed')) } catch { /* gone */ }
    }
  }
}

/** What the banner needs, and nothing more. */
export function noticeSnapshot(hub) {
  return {
    installed: Object.keys(hub.state.reported),
    bundleUser: isBundleUser(hub),
    update: hub.state.latest,
    dismissed: hub.state.dismissedVersion,
    current: currentVersionLabel(hub),
  }
}

function ok(value) {
  return { ok: true, value }
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Same-origin + private header check, mirroring cc-memory's route. */
function trustedCaller(request) {
  const headers = request.headers ?? {}
  if (headers[CALLER_HEADER] !== '1') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  try {
    return typeof headers.host === 'string' && new URL(origin).host === headers.host
  } catch {
    return false
  }
}

async function readJsonBody(request, maxBytes = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
