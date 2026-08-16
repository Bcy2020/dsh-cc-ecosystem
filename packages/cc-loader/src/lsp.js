// dsh-cc-loader — LSP server config discovery (.lsp.json) — PLACEHOLDER.
//
// Claude Code plugins may ship `.lsp.json` at the plugin root:
//   { "<language>": { "command": "typescript-language-server", "args": ["--stdio"],
//                     "extensionToLanguage": { "tsx": "typescript" } } }
//
// The LSP adapter (dsh-cc-lsp, M3b) is deferred: the ecosystem has ~zero
// .lsp.json plugins today, and the bridge (mcpls) is only Windows-verified.
// This module still PARSES and CLASSIFIES the component so the IR inventory
// is complete and a future adapter has the parse layer ready. Every entry is
// classified UNSUPPORTED with a clear reason — never silently ignored.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathExists } from './skills.js'
import { STATUS } from './classify.js'

/**
 * Parse `.lsp.json` text into classified LSP entries. Every entry is
 * UNSUPPORTED (LSP adapter deferred, M3b) — parsed for IR inventory only.
 * @param {string} text - raw .lsp.json text.
 * @param {string} [sourcePath] - for warning messages.
 * @param {(msg: string) => void} [warn]
 * @returns {object[]} entries, each { language, command?, args, extensionToLanguage?, status, reason? }
 */
export function parseLspText(text, sourcePath = '.lsp.json', warn = () => {}) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    warn(`${sourcePath}: invalid JSON: ${error.message}`)
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`${sourcePath}: config must be a JSON object`)
    return []
  }
  const servers = []
  for (const [language, raw] of Object.entries(parsed)) {
    const entry = {
      language,
      command: typeof raw?.command === 'string' ? raw.command : undefined,
      args: Array.isArray(raw?.args) ? raw.args.map(String) : [],
      extensionToLanguage: (typeof raw?.extensionToLanguage === 'object' && raw.extensionToLanguage !== null && !Array.isArray(raw.extensionToLanguage))
        ? raw.extensionToLanguage : undefined,
      status: STATUS.UNSUPPORTED,
      reason: 'LSP adapter not implemented (M3b deferred; bridge candidate mcpls)',
    }
    if (entry.command === undefined) {
      warn(`${sourcePath}: language "${language}" missing "command" — recorded with reason`)
    }
    servers.push(entry)
  }
  return servers
}

/** @returns {Promise<{ servers: object[], sources: string[], warnings: string[] }>} */
export async function discoverLspConfig(dir, opts = {}) {
  const warn = opts.warn ?? (() => {})
  const warnings = []
  const localWarn = (m) => { warnings.push(m); warn(m) }
  const sources = []
  const servers = []

  const lspPath = join(dir, '.lsp.json')
  if (!(await pathExists(lspPath))) return { servers, sources, warnings }

  let text
  try {
    text = await readFile(lspPath, 'utf8')
  } catch (error) {
    warnings.push(`cannot read ${lspPath}: ${String(error)}`)
    warn(`cannot read ${lspPath}: ${String(error)}`)
    return { servers, sources, warnings }
  }
  sources.push(lspPath)

  const entries = parseLspText(text, lspPath, localWarn)
  for (const entry of entries) {
    servers.push(entry)
    localWarn(`LSP language "${entry.language}" (command ${entry.command ?? '?'}) — ${entry.reason}`)
  }
  return { servers, sources, warnings }
}
