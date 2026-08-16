// dsh-cc-loader — shared parse layer for the dsh-cc ecosystem.
//
// Parses Claude Code `.claude/` (project + global user dir) into a standalone
// in-memory IR. The IR is a plain JSON-serializable object; adapters consume
// it and never touch `.claude` details directly. Nothing is written to disk:
// the source of truth stays the `.claude` files themselves, so DSH stays in
// sync with Claude Code (which also scans `.claude` per session).
//
// Every component is classified DIRECT / ADAPTED / UNSUPPORTED / BLOCKED;
// UNSUPPORTED and BLOCKED components never reach the adapters.

export { loadClaude, loadPermissions } from './load.js'
export {
  discoverSkills, discoverCommands, collectClaudeDir, discoverRules,
  findProjectRoot, parseFrontmatter, isSkillName, pathExists, readTextSafe,
} from './skills.js'
export { discoverSettings, mergeSettings } from './settings.js'
export {
  discoverAgents, mergeAgentCatalog, buildAgentEntry, classifyAgentFields,
  expandCcToolToDsh,
} from './agents.js'
export {
  parseMcpText, serverEntries, discoverMcpConfig, discoverProjectMcp,
  VALID_SERVER_NAME, ENV_PLACEHOLDER,
} from './mcp.js'
export { discoverLspConfig, parseLspText } from './lsp.js'
export {
  parsePluginManifest, parseMarketplace, discoverPluginRoot, discoverMarketplace,
  normalizePluginSource, pluginNameOf, pluginComponentName,
  PLUGIN_NAME_RE, RESERVED_MARKETPLACE_NAMES,
} from './plugin.js'
export { parseRule } from './parse-rule.js'
export { compileCommandPattern, compilePathPattern, compileDomainPattern, winPathToPosix, escapeRegExp } from './patterns.js'
export {
  ccBucket, ruleTargetsTool, extractBashPaths, isBashReadCommand, isBashWriteCommand,
  isReadCoveredTool, isEditCoveredTool,
} from './map-tools.js'
export {
  evaluateCall, parseRulesFor, splitSubcommands, removedToolNames,
  classifyComponents, STATUS, matchesIfRule,
} from './classify.js'
