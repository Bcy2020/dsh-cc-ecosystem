// Runtime switch controller.
//
// `apply()` hands the two Config values to this class as first-run defaults.
// From then on the persisted state file is authoritative, and every change
// re-registers exactly the pieces the current state needs:
//
//   enabled:false             → nothing registered (no section, no tools)
//   enabled:true, read-only   → section + cc_memory_list / cc_memory_read
//   enabled:true, read-write  → also cc_memory_write / cc_memory_edit
//
// Disposing a section/tool registration takes effect immediately: the next
// assembly re-reads the prompt sections, and a tool-list change starts a new
// request series in the loop. No restart is needed for a toggle.

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { MAX_INDEX_CHARS, MAX_INDEX_LINES, MAX_MEMORY_BYTES, MAX_MEMORY_FILES, readMemoryIndex, readPinnedMemories, resolveMemoryDir } from './discovery.js'
import { buildMemorySection } from './prompt.js'
import { registerReadTools, registerWriteTools } from './tools.js'
import { MODES, saveState, loadState, defaultStatePath } from './state.js'

/** Process-lifetime cwd → memory directory cache (CC memoizes it too). */
class MemoryResolver {
  constructor(opts) {
    this.opts = opts
    this.cache = new Map()
  }

  /** @param {string} cwd @returns {string} */
  for(cwd) {
    const key = resolve(cwd)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const directory = resolveMemoryDir(key, this.opts)
    this.cache.set(key, directory)
    return directory
  }
}

export class MemoryRuntime {
  /**
   * @param {object} ctx - host context (`systemPrompt`, `tools`, `logger`).
   * @param {object} config - validated plugin Config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.homeDir = config.homeDir ?? homedir()
    this.opts = {
      homeDir: this.homeDir,
      globalClaudeDir: config.globalClaudeDir,
      memoryDirectory: config.memoryDirectory,
      maxFiles: config.maxFiles,
      maxBytes: config.maxFileBytes,
      maxPinned: config.maxPinned,
      includeArchive: config.includeArchive === true,
    }
    this.limits = { maxLines: config.maxIndexLines, maxChars: config.maxIndexChars }
    this.defaults = {
      enabled: config.enabled !== false,
      mode: config.mode === 'read-write' ? 'read-write' : 'read-only',
    }
    this.statePath = typeof config.statePath === 'string' && config.statePath.trim() !== ''
      ? resolve(config.statePath.trim())
      : defaultStatePath()
    const loaded = loadState(this.statePath, this.defaults)
    this.enabled = loaded.enabled
    this.mode = loaded.mode
    this.stateSource = loaded.source
    this.stateError = loaded.error
    this.resolver = new MemoryResolver(this.opts)
    this.sectionDisposer = null
    this.readDisposers = []
    this.writeDisposers = []
    this.routeRegistered = false
    this.routeError = null
    this.warned = new Set()
  }

  /** Mount the pieces the loaded state requires. */
  start() {
    if (this.stateError !== undefined) {
      this.log('warn', `state file ${this.statePath} ignored: ${this.stateError} (using Config defaults)`)
    }
    this.reconcile()
  }

  /** Unregister everything (plugin unload, or enabled flipped off). */
  dispose() {
    this.teardown()
  }

  /**
   * Flip one or both switches, persist, and reconcile.
   * @param {{ enabled?: boolean, mode?: string }} patch
   * @returns {object} the new snapshot
   */
  set(patch) {
    const input = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    if (Object.hasOwn(input, 'enabled') && typeof input.enabled !== 'boolean') {
      throw new Error('enabled must be a boolean')
    }
    if (Object.hasOwn(input, 'mode') && !MODES.includes(input.mode)) {
      throw new Error(`mode must be one of ${MODES.join(', ')}`)
    }
    if (Object.hasOwn(input, 'enabled')) this.enabled = input.enabled
    if (Object.hasOwn(input, 'mode')) this.mode = input.mode
    try {
      saveState(this.statePath, { enabled: this.enabled, mode: this.mode })
      this.stateSource = 'file'
      this.stateError = undefined
    } catch (error) {
      this.stateError = `could not write state file: ${String(error?.message ?? error)}`
      this.log('warn', this.stateError)
    }
    this.reconcile()
    return this.snapshot()
  }

  /** Register/unregister to match the current state. Never throws. */
  reconcile() {
    try {
      if (!this.enabled) {
        this.teardown()
        return
      }
      if (this.sectionDisposer === null) {
        this.sectionDisposer = this.ctx.systemPrompt.section({
          name: 'cc-memory:auto-memory',
          order: 850,
          text: (context) => this.render(context),
        })
      }
      if (this.readDisposers.length === 0) {
        const read = registerReadTools(this.ctx, { resolver: this.resolver, opts: this.opts, runtime: this })
        this.readDisposers.push(...read)
      }
      if (this.mode === 'read-write' && this.writeDisposers.length === 0) {
        const write = registerWriteTools(this.ctx, { resolver: this.resolver, opts: this.opts, runtime: this })
        this.writeDisposers.push(...write)
      } else if (this.mode !== 'read-write' && this.writeDisposers.length > 0) {
        disposeAll(this.writeDisposers)
      }
    } catch (error) {
      this.log('warn', `apply state failed: ${String(error?.stack ?? error)}`)
      // A half-applied registration is worse than none: unwind and leave the
      // plugin inert until the next successful set().
      this.teardown()
    }
  }

  /** Model-facing section provider. Runs on every assembly. */
  render(context) {
    if (!this.enabled) return ''
    // 0.2.0 supplies `agent`; 0.1.5's assembly context exposes the same object
    // as `scope`. Accept both so the section is not silently empty on the
    // older host generation.
    const agent = context?.agent ?? context?.scope
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return ''
    try {
      const memoryDir = this.resolver.for(cwd)
      const index = readMemoryIndex(memoryDir, this.limits)
      const pinned = readPinnedMemories(memoryDir, { ...this.opts, ...this.limits })
      return buildMemorySection({ memoryDir, index, mode: this.mode, pinned })
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!this.warned.has(message)) {
        this.warned.add(message)
        this.log('warn', `memory section skipped: ${message}`)
      }
      return ''
    }
  }

  /**
   * Serializable state for the panel.
   * @param {{ cwd?: string }} [options]
   * @returns {object}
   */
  snapshot(options = {}) {
    const memoryDirectory = typeof options.cwd === 'string' && options.cwd.length > 0
      ? safeDirectory(this.resolver, options.cwd)
      : this.config.memoryDirectory ?? null
    return {
      enabled: this.enabled,
      mode: this.mode,
      effectiveMode: this.enabled ? this.mode : null,
      defaults: { ...this.defaults },
      tools: this.enabled
        ? ['cc_memory_list', 'cc_memory_read', ...(this.mode === 'read-write' ? ['cc_memory_write', 'cc_memory_edit'] : [])]
        : [],
      statePath: this.statePath,
      stateSource: this.stateSource,
      ...(this.stateError === undefined ? {} : { stateError: this.stateError }),
      memoryDirectory,
      routeRegistered: this.routeRegistered,
      ...(this.routeError === null ? {} : { routeError: this.routeError }),
    }
  }

  teardown() {
    if (this.sectionDisposer !== null) {
      try { this.sectionDisposer() } catch { /* best effort */ }
      this.sectionDisposer = null
    }
    disposeAll(this.readDisposers)
    disposeAll(this.writeDisposers)
  }

  log(level, message) {
    try { this.ctx?.logger?.[level]?.(`cc-memory: ${message}`) } catch { /* logger absence is not fatal */ }
  }
}

function disposeAll(list) {
  for (const dispose of list) {
    try { dispose() } catch { /* best effort */ }
  }
  list.length = 0
}

function safeDirectory(resolver, cwd) {
  try { return resolver.for(cwd) } catch { return null }
}
