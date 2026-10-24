// Host half of the `/cc-memory` panel.
//
// The browser half talks to a plugin-owned route on DSH's `webServer` service
// (the same pattern cc-mcp uses; the generic `connection` RPC service is not
// visible to a profile-level plugin). There is no host→browser push, so the
// panel pulls `state` when it opens and after every mutation.
//
// Endpoints:
//   state  → the current switches plus resolved memory directory / tool list
//   set    → { enabled?: boolean, mode?: 'read-only'|'read-write' }
//
// The route only accepts this plugin's own browser half: POSTs must carry
// `x-cc-memory: 1` (a cross-site fetch cannot set it without a CORS preflight
// this server never grants), and an Origin, when present, must match Host.

/** Route prefix; keep in step with `client/index.js`. */
export const RPC_CHANNEL = '/cc-memory'
/** Header the browser half sets on every call. */
export const CALLER_HEADER = 'x-cc-memory'
const ENDPOINTS = new Set(['state', 'set'])
const MAX_BODY_BYTES = 64 * 1024

/**
 * Register the panel route on the host's web server.
 * @param {object} ctx - plugin context.
 * @param {import('./runtime.js').MemoryRuntime} runtime
 */
export function registerPanelRoute(ctx, runtime) {
  try {
    ctx.inject(['webServer'], (scope) => {
      try {
        scope.effect(() => scope.webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: createRouteHandler({
            runtime,
            resolveCwd: (sessionId) => sessionCwd(scope, sessionId),
            log: (level, message) => runtime.log(level, message),
          }),
        }), 'cc-memory: panel route')
        runtime.routeRegistered = true
        runtime.routeError = null
      } catch (error) {
        runtime.routeRegistered = false
        runtime.routeError = error instanceof Error ? error.message : String(error)
        runtime.log('warn', `could not register ${RPC_CHANNEL}: ${runtime.routeError}`)
      }
    })
  } catch (error) {
    runtime.routeRegistered = false
    runtime.routeError = error instanceof Error ? error.message : String(error)
    runtime.log('warn', `panel unavailable: ${runtime.routeError}`)
  }
}

/**
 * Resolve the invoking session's cwd so the panel can show which memory
 * directory this conversation maps to. Best-effort: an unknown service or a
 * plain session id yields `undefined`, and the panel simply omits the path.
 * @returns {string | undefined}
 */
function sessionCwd(scope, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  try {
    const agents = typeof scope.get === 'function' ? scope.get('agents', false) : undefined
    if (agents === null || typeof agents !== 'object') return undefined
    let entry
    if (typeof agents.get === 'function') entry = agents.get(sessionId)
    else if (agents.store instanceof Map) entry = agents.store.get(sessionId)
    const agent = entry?.agent ?? entry
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

function ok(value) {
  return { ok: true, value }
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Build the `webServer` handler.
 * @param {{ runtime: object, resolveCwd: (sessionId: string) => string | undefined, log?: Function }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRouteHandler(options) {
  const { runtime, resolveCwd } = options
  const log = options.log ?? (() => {})
  return async function handle(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const endpoint = url.pathname.startsWith(`${RPC_CHANNEL}/`)
        ? url.pathname.slice(RPC_CHANNEL.length + 1)
        : ''
      if (!ENDPOINTS.has(endpoint)) {
        sendJson(response, 404, fail('cc-memory/unknown-endpoint', `unknown endpoint ${JSON.stringify(url.pathname)}`))
        return
      }
      const method = request.method ?? 'GET'
      if (method !== 'GET' && method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }
      if (method === 'POST' && !trustedCaller(request)) {
        sendJson(response, 403, fail('cc-memory/untrusted-origin', "the request did not come from this plugin's own panel"))
        return
      }
      let payload = {}
      if (method === 'POST') {
        try {
          payload = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, fail('cc-memory/bad-request', error instanceof Error ? error.message : String(error)))
          return
        }
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) payload = {}
      sendJson(response, 200, dispatch(runtime, endpoint, payload, resolveCwd))
    } catch (error) {
      log('error', `panel request failed: ${String(error?.stack ?? error)}`)
      try {
        sendJson(response, 500, fail('cc-memory/internal', error instanceof Error ? error.message : String(error)))
      } catch {
        /* the response is already gone */
      }
    }
  }
}

function dispatch(runtime, endpoint, payload, resolveCwd) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const cwd = resolveCwd(sessionId)
  const withCwd = cwd === undefined ? {} : { cwd }
  if (endpoint === 'state') return ok(runtime.snapshot(withCwd))
  const patch = {}
  if (Object.hasOwn(payload, 'enabled')) patch.enabled = payload.enabled
  if (Object.hasOwn(payload, 'mode')) patch.mode = payload.mode
  if (Object.keys(patch).length === 0) {
    return fail('cc-memory/bad-request', 'set requires enabled and/or mode')
  }
  try {
    runtime.set(patch)
  } catch (error) {
    return fail('cc-memory/bad-request', error instanceof Error ? error.message : String(error))
  }
  return ok(runtime.snapshot(withCwd))
}

/** One JSON response with no caching. */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** True for this plugin's own browser half (see the header comment). */
export function trustedCaller(request) {
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

/** Read and parse a JSON request body, rejecting anything over the cap. */
export async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
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
