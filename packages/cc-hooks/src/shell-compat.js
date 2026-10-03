// shell-compat.js — the single compatibility boundary for running a command
// hook through the host's shell executor.
//
// WHY THIS EXISTS
// ---------------
// `@deepseek-ai/dsh-hook-protocol`'s own `runHook()` reaches into the host
// shell service, and that service's API changed in DSH 0.2.0:
//
//   0.1.5-rc.2   const result = await bash.run(bash.resolve(request))
//   0.2.0-rc.2   const result = await (await bash.execute(bash.resolve(request))).result()
//
// The two protocol releases are byte-identical apart from that one line, so
// whichever copy we ship can satisfy only one of the two hosts: pinning 0.2.x
// breaks 0.1.x hosts and pinning 0.1.x breaks 0.2.x hosts. A dependency range
// cannot express "match the host", so cc-hooks owns this one call instead and
// feature-detects the executor (`run` vs `execute`) the way `session-compat.js`
// feature-detects the session readers.
//
// `bash.resolve()` is called by BOTH protocol releases, so the request shape
// below is the same on either host; only the invocation differs.
//
// SUPPORT POLICY
// --------------
// The 0.2.0 shape is preferred; `run` is the fallback for older hosts. Both
// branches are total: a shell service exposing neither, or an `execute` that
// resolves to a bare result rather than a handle, yields an error output
// instead of throwing into the hook boundary.
//
// Everything else here — timeout resolution, stdin framing, request shape,
// and the catch that turns a failure into an output — is reproduced unchanged
// from the protocol's `runHook`, so behavior on 0.1.x is identical to before.

import { parseHookOutput } from '@deepseek-ai/dsh-hook-protocol'

/**
 * Invoke the host shell executor for one resolved request, across both
 * host generations.
 *
 * @param {any} shell - the host shell service (`ctx.shell`).
 * @param {any} request - a `{ command, timeoutMs, stdin, signal, workdir?, env? }` request.
 * @returns {Promise<any>} the run result carrying `exitCode` / `stdout` / `stderr`.
 */
async function executeShell(shell, request) {
  const resolved = shell.resolve(request)
  if (typeof shell.execute === 'function') {
    const handle = await shell.execute(resolved)
    // 0.2.0 resolves to a handle whose `result()` is awaited; a host that
    // returns the bare result from `execute` is accepted as-is.
    return typeof handle?.result === 'function' ? handle.result() : handle
  }
  return shell.run(resolved)
}

/**
 * Run one command hook against the host shell, with Claude Code's stdin
 * framing and per-hook/per-event timeout.
 *
 * Mirrors `@deepseek-ai/dsh-hook-protocol`'s `runHook` so callers keep its
 * contract: never throws, and a failed launch becomes an error output.
 *
 * @param {any} shell - the host shell service (`ctx.shell`).
 * @param {{ command: string, timeoutSec?: number }} hook - the parsed hook.
 * @param {{ payload: unknown, defaultTimeoutMs: number, trailingNewline?: boolean,
 *   expectedEventName?: string, signal?: AbortSignal, cwd?: string, env?: Record<string, string> }} options
 * @param {() => number} now - monotonic clock.
 * @returns {Promise<{ output: any, durationMs: number }>}
 */
export async function runShellHook(shell, hook, options, now) {
  const started = now()
  const timeoutMs = hook.timeoutSec !== undefined ? hook.timeoutSec * 1e3 : options.defaultTimeoutMs
  const stdin = JSON.stringify(options.payload) + (options.trailingNewline ? '\n' : '')
  const request = {
    command: hook.command,
    timeoutMs,
    stdin,
    signal: options.signal,
    ...(options.cwd !== undefined ? { workdir: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  }
  try {
    const result = await executeShell(shell, request)
    return {
      output: parseHookOutput(
        result.exitCode ?? undefined,
        result.stdout.text,
        result.stderr.text,
        options.expectedEventName,
      ),
      durationMs: now() - started,
    }
  } catch (error) {
    return {
      output: parseHookOutput(undefined, '', error instanceof Error ? error.message : String(error)),
      durationMs: now() - started,
    }
  }
}
