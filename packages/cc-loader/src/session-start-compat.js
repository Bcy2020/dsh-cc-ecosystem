// session-start-compat.js — the single compatibility boundary for the
// "a session has started" extension point.
//
// WHY THIS EXISTS
// ---------------
// DSH 0.2.0 moved this extension point and enriched its payload:
//
//   0.1.5-rc.2   agent/session-start  { agent, source }
//   0.2.0-rc.2   agent/created        { agent, source, signal? }
//
// `agent/session-start` is simply GONE in 0.2.0 — a listener on that name is
// never called, with no error at any point, so a plugin loads, passes the
// install gate, and silently loses the feature. `agent/created` does exist on
// 0.1.5, but there the payload is `{ agent }` alone: no `source`. The two names
// are therefore NOT aliases, and a plain rename trades one silent break for
// another (the SessionStart hook payload would lose its `source`).
//
// The discriminator is `source`: 0.2.0's `agent/created` always carries one (the
// registry announces as `announce(agent, source, signal)`), 0.1.5's never does,
// and 0.1.5's `agent/session-start` always does. Listening on both and acting
// only on a payload that carries `source` fires the handler exactly once on
// either generation, with no bookkeeping: the host calls its publication entry
// once per agent (`publish(source)`), and 0.2.0's registry rejects a second
// announce for the same entry.
//
// The official `@deepseek-ai/dsh-hooks-claude-code@0.2.0-rc.2` bridge makes the
// same move, dropping its `agent/session-start` listener for `agent/created`.
//
// SECOND HAZARD: 0.2.0's `agent/created` is a SERIAL event — its listeners are
// awaited, and a listener rejection vetoes session publication. 0.1.5's was
// synchronous and fire-and-forget. Session-start work here is slow (filesystem
// discovery, spawned hook processes), so this boundary deliberately does NOT
// return the handler's promise and never lets a throw escape: a plugin must not
// be able to stall or veto the host's session publication.

/**
 * Subscribe to "a session has started", on either host generation.
 *
 * The handler runs at most once per agent with `{ agent, source, signal }`.
 * `source` is one of `'startup' | 'resume' | 'clear' | 'compact'` and is
 * present on both generations this boundary supports.
 *
 * The handler runs detached and its result is ignored — neither a throw nor a
 * rejection reaches the host (see the header). A failure is logged instead.
 *
 * @param {{ on: Function, logger?: any }} ctx - the plugin context.
 * @param {(payload: { agent: any, source: string, signal?: AbortSignal }) => unknown} handler
 */
export function onSessionStart(ctx, handler) {
  const invoke = (payload) => {
    try {
      const result = handler(payload)
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.then(undefined, (error) => warn(ctx, error))
      }
    } catch (error) {
      warn(ctx, error)
    }
  }
  ctx.on('agent/session-start', invoke)
  ctx.on('agent/created', (payload) => {
    // 0.1.5's `agent/created` is registration-only and carries no `source`;
    // the session-start event that does carry one follows it immediately.
    // Acting here as well would run the handler twice.
    if (payload === null || typeof payload !== 'object' || payload.source === undefined) return
    invoke(payload)
  })
}

function warn(ctx, error) {
  ctx.logger?.warn?.(`dsh-cc-loader: session-start listener failed: ${String(error)}`)
}
