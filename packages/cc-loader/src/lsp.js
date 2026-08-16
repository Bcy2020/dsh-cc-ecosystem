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

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    warnings.push(`${lspPath}: invalid JSON: ${error.message}`)
    warn(`${lspPath}: invalid JSON: ${error.message}`)
    return { servers, sources, warnings }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`${lspPath}: config must be a JSON object`)
    warn(`${lspPath}: config must be a JSON object`)
    return { servers, sources, warnings }
  }

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
      warnings.push(`${lspPath}: language "${language}" missing "command" — recorded with reason`)
      warn(`${lspPath}: language "${language}" missing "command" — recorded with reason`)
    }
    servers.push(entry)
    localWarn(`LSP language "${language}" (command ${entry.command ?? '?'}) — ${entry.reason}`)
  }
  return { servers, sources, warnings }
}
