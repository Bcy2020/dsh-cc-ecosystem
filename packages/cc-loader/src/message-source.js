// message-source.js — the single place that knows what `source` a message this
// ecosystem injects must carry for the host to admit it.
//
// WHY THIS EXISTS
// ---------------
// DSH's session format v4 has an admission gate that validates the `source` of
// EVERY durable message slot before the event is adopted. Its whole rule
// (`lib/types/message-sources.js`) is:
//
//   function source(message) {
//     const value = message["source"]
//     if (!isSessionFormatJsonObject(value)
//         || typeof value["kind"] !== "string"
//         || value["kind"].length === 0
//         || value["kind"] === "plugin")
//       throw new SessionFormatError("format v4 message requires a producer-owned source kind")
//   }
//
// The line of policy above it settles what that means: "Native source admission
// PRESERVES UNKNOWN ATTRIBUTION and REFUSES RETIRED PLUGIN WRAPPERS." So any
// non-empty `kind` other than `plugin` is admitted and kept verbatim — you do
// not have to register your name with the host. The single refused form is the
// V3 plugin wrapper `{ kind: 'plugin', plugin: '<name>' }`, and refusing it
// fails the whole TURN, not just that message.
//
// `kind` doubles as the context-row label, so it should name the producer.
//
// WHAT WENT WRONG
// ---------------
// cc-hooks and cc-agents shipped the V3 wrapper, so the first time either one
// injected anything — SessionStart context, hook-injected context, the catalog
// reminder, a prompt/agent hook result — the turn died with
// "format v4 message requires a producer-owned source kind". The constant was
// duplicated across three files, which is why the shape can drift again; this
// module is the one place it is written down.

/**
 * Build the `source` for a message this ecosystem injects.
 *
 * @param {string} kind - the producing plugin; also the context-row label.
 *   Must be non-empty and must not be `'plugin'`.
 * @returns {{ kind: string }} an admitted source.
 */
export function injectedSource(kind) {
  return { kind }
}
