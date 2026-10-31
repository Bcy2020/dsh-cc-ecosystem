window.__ModuleLoader__.load({ id: "dsh-cc-mcp", factory: (require) => {
  'use strict'
  var module = { exports: {} }; var exports = module.exports;

  // dsh-cc-mcp — browser half (the `/mcp` management panel).
  //
  // Plain DOM, no imports, no require, no build step, no top-level await: this
  // file is a CLASSIC script that several bundles get concatenated into, so the
  // single top-level statement above is this whole file and every declaration
  // lives inside the factory.
  //
  // Transport: same-origin POSTs to the plugin's own host route (`/cc-mcp/*`,
  // registered by the host half on the `webServer` service). There is no
  // host→browser push, so the panel pulls (`state`) and refreshes after every
  // mutation, and the session self-check polls `check` a bounded number of
  // times.

  var PLUGIN_ID = 'dsh-cc-mcp'
  var CHANNEL = '/cc-mcp'
  var STYLE_TAG_ID = 'dsh-cc-mcp/panel.css'
  var CHECK_RETRY_DELAYS = [1000, 3000, 4000]
  var TOAST_TTL_MS = 6000
  var REFETCH_INTERVAL_MS = 700
  var REFETCH_CAP_MS = 20000

  // ─── module state ─────────────────────────────────────────────────────────
  // Every one of these is written only from inside apply()/its deferred
  // injections and cleared by the matching disposer, so an unload leaves no
  // DOM node, timer, or captured caller behind.

  var styleEl = null
  var overlayRoot = null
  var toastItems = null
  var toastRoot = null
  var panel = null
  var sessionsScope = null
  var sessionUnsub = null
  var checkSessionId = null
  var pendingCheck = null
  var checkRetryTimer = null
  var checkRetryIndex = 0
  var bindSeq = 0

  // ─── tiny helpers ─────────────────────────────────────────────────────────

  function warn(message, error) {
    try {
      var text = error === undefined ? message : message + ': ' + String((error && error.message) || error)
      if (typeof console !== 'undefined' && console !== null && typeof console.warn === 'function') console.warn(text)
    } catch (ignored) { /* logging must never break the caller */ }
  }

  function isDom() {
    return typeof document !== 'undefined' && document !== null && typeof document.createElement === 'function'
  }

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** Always a string — snapshot fields come off the wire and are not trusted. */
  function str(value, fallback) {
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number' && isFinite(value)) return String(value)
    return fallback === undefined ? '' : fallback
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null && text !== '') node.textContent = text
    return node
  }

  function clear(node) {
    if (!node) return
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  // ─── transport ────────────────────────────────────────────────────────────

  function transportFailure(code, message) {
    return { ok: false, error: { code: code, message: message, details: {} } }
  }

  function toEnvelope(thrown) {
    var message = (thrown && thrown.message) || thrown
    return transportFailure('cc-mcp/transport', String(message === undefined || message === null ? 'transport failed' : message))
  }

  /**
   * One panel call to the host's plugin-owned route. Never throws and never
   * rejects: a missing transport, a failed request, or a malformed envelope all
   * become the same `{ ok: false, error }` shape the views already render.
   */
  function api(endpoint, payload) {
    try {
      if (typeof fetch !== 'function') {
        return Promise.resolve(transportFailure('cc-mcp/no-transport', 'fetch is unavailable in this shell'))
      }
      return fetch(CHANNEL + '/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cc-mcp': '1' },
        body: JSON.stringify(payload === undefined || payload === null ? {} : payload),
        credentials: 'same-origin',
      }).then(
        function (response) {
          return response.json().then(function (result) {
            if (isRecord(result) && result.ok === true) return { ok: true, value: result.value }
            if (isRecord(result) && result.ok === false && isRecord(result.error)) {
              return {
                ok: false,
                error: {
                  code: str(result.error.code, 'cc-mcp/internal'),
                  message: str(result.error.message, 'cc-mcp request failed'),
                  details: isRecord(result.error.details) ? result.error.details : {},
                },
              }
            }
            return transportFailure('cc-mcp/envelope', 'malformed result envelope from ' + endpoint)
          }, function () {
            return transportFailure('cc-mcp/envelope', 'HTTP ' + response.status + ' without a JSON envelope')
          })
        },
        toEnvelope,
      )
    } catch (error) {
      return Promise.resolve(toEnvelope(error))
    }
  }

  function codeOf(response) {
    return (response && response.error && response.error.code) || 'cc-mcp/internal'
  }

  function errorOf(response, fallback) {
    var message = response && response.error && response.error.message
    return str(message, fallback || 'request failed')
  }

  function entryOf(response) {
    var value = response && response.value
    return isRecord(value) && isRecord(value.entry) ? value.entry : null
  }

  function entryKey(entry) {
    if (!isRecord(entry)) return ''
    return str(entry.key) || (str(entry.scope) + ':' + str(entry.serverName))
  }

  function isDangerCode(code) {
    return String(code || '').indexOf('no-transport') !== -1 || String(code || '').indexOf('transport') !== -1
  }

  // ─── styles ───────────────────────────────────────────────────────────────

  var STYLES = [
    '.ccmcp-overlay{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:none}',
    '.ccmcp-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgb(0 0 0 / 24%));pointer-events:auto}',
    '.ccmcp-panel{position:relative;pointer-events:auto;width:620px;max-width:100%;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 10%));box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgb(0 0 0 / 18%));font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;line-height:20px}',
    '.ccmcp-head{display:flex;align-items:flex-start;gap:12px;padding:16px 16px 12px;flex:0 0 auto}',
    '.ccmcp-head-main{flex:1 1 auto;min-width:0}',
    '.ccmcp-title{margin:0;font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.ccmcp-subtitle{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ccmcp-head-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
    '.ccmcp-iconbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1}',
    '.ccmcp-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72 / 6%));color:var(--dsw-alias-label-primary,#0f1115)}',
    '.ccmcp-backbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:12px;padding:4px 8px;margin:0 0 0 -8px;border-radius:8px;cursor:pointer;align-self:flex-start}',
    '.ccmcp-backbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72 / 6%));color:var(--dsw-alias-label-primary,#0f1115)}',
    '.ccmcp-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 8px 8px}',
    '.ccmcp-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;appearance:none;border:0;background:transparent;font:inherit;color:inherit;padding:8px;border-radius:10px;cursor:pointer}',
    '.ccmcp-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72 / 6%))}',
    '.ccmcp-glyph{flex:0 0 auto;width:28px;height:28px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;line-height:1;background:var(--dsw-alias-bg-module-platform,rgb(235 238 242));color:var(--dsw-alias-label-secondary,#61666b);text-transform:uppercase}',
    '.ccmcp-name{flex:1 1 auto;min-width:0;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ccmcp-type{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);white-space:nowrap}',
    '.ccmcp-type-transport{color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmcp-status{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;min-width:88px}',
    '.ccmcp-status-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmcp-btn{appearance:none;font:inherit;font-size:12px;line-height:16px;padding:4px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0 / 10%));background:var(--dsw-alias-button-elevated-fill,#fff);color:var(--dsw-alias-label-primary,#0f1115)}',
    '.ccmcp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72 / 6%))}',
    '.ccmcp-btn:disabled{cursor:default;opacity:.6}',
    '.ccmcp-spinner{display:inline-block;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2,rgb(0 0 0 / 10%));border-top-color:var(--dsw-alias-label-secondary,#61666b);animation:ccmcp-spin .7s linear infinite}',
    '.ccmcp-spinner-lg{width:18px;height:18px;border-width:2px}',
    '.ccmcp-spin-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);padding:2px 0 10px}',
    '.ccmcp-detail-head{display:flex;align-items:center;gap:10px;width:100%}',
    '.ccmcp-detail-head .ccmcp-name{font-size:14px}',
    '.ccmcp-statusline{display:flex;align-items:center;gap:6px;padding:12px 16px 0;font-size:13px}',
    '.ccmcp-statusline-ready{color:var(--dsw-alias-state-success-primary,#12b76a)}',
    '.ccmcp-statusline-error{color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.ccmcp-statusline-muted{color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmcp-statusline-detail{font-weight:400;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}',
    '.ccmcp-source{margin:4px 0 0;padding:0 16px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}',
    '.ccmcp-tools{margin:12px 16px 16px;border:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 10%));border-radius:10px;overflow:hidden}',
    '.ccmcp-tools-head{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 10%));font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmcp-tools-body{max-height:280px;overflow:auto}',
    '.ccmcp-tool{display:grid;grid-template-columns:minmax(0,1fr);gap:2px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 10%))}',
    '.ccmcp-tool:last-child{border-bottom:0}',
    '.ccmcp-tool-name{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ccmcp-tool-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
    '.ccmcp-tools-muted .ccmcp-tool-name,.ccmcp-tools-muted .ccmcp-tool-desc{opacity:.55}',
    '.ccmcp-empty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmcp-empty-text{margin:0 0 10px}',
    '.ccmcp-toast-root{position:fixed;right:16px;bottom:16px;z-index:1120;display:flex;flex-direction:column;gap:8px;max-width:360px;pointer-events:none}',
    '.ccmcp-toast{pointer-events:auto;cursor:pointer;display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 10%));box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgb(0 0 0 / 18%));font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif)}',
    '.ccmcp-toast-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.ccmcp-toast-danger .ccmcp-toast-title{color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.ccmcp-toast-body{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}',
    '@keyframes ccmcp-spin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.ccmcp-spinner{animation-duration:2s}}',
  ].join('')

  function installStyles() {
    if (!isDom()) return null
    try {
      var existing = document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')
      if (existing) return existing
      var tag = document.createElement('style')
      tag.setAttribute('data-plugin', PLUGIN_ID)
      tag.setAttribute('data-plugin-css', STYLE_TAG_ID)
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return tag
    } catch (error) {
      warn('style install failed', error)
      return null
    }
  }

  // ─── toasts ───────────────────────────────────────────────────────────────

  function closeToast(item) {
    try {
      if (item && item.timer !== null) clearTimeout(item.timer)
      if (item && item.node && item.node.parentNode) item.node.parentNode.removeChild(item.node)
      if (toastItems && item) toastItems.delete(item)
      if (toastItems && toastItems.size === 0 && toastRoot && toastRoot.parentNode) {
        toastRoot.parentNode.removeChild(toastRoot)
      }
    } catch (error) {
      warn('toast dismiss failed', error)
    }
  }

  function ensureToastRoot() {
    if (!isDom()) return null
    if (toastRoot && toastRoot.parentNode) return toastRoot
    toastRoot = el('div', 'ccmcp-toast-root')
    toastRoot.setAttribute('role', 'status')
    document.body.appendChild(toastRoot)
    toastItems = new Set()
    return toastRoot
  }

  /** One bottom-right, auto-dismissing toast; click dismisses it early. */
  function toast(title, body, tone) {
    if (!isDom()) return null
    try {
      var root = ensureToastRoot()
      if (!root || !toastItems) return null
      var node = el('div', 'ccmcp-toast' + (tone === 'danger' ? ' ccmcp-toast-danger' : ''))
      node.setAttribute('role', 'alert')
      node.appendChild(el('div', 'ccmcp-toast-title', str(title, 'MCP')))
      if (body) node.appendChild(el('div', 'ccmcp-toast-body', str(body)))
      var item = { node: node, timer: null }
      node.addEventListener('click', function () { closeToast(item) })
      root.appendChild(node)
      toastItems.add(item)
      item.timer = setTimeout(function () { closeToast(item) }, TOAST_TTL_MS)
      return item
    } catch (error) {
      warn('toast failed', error)
      return null
    }
  }

  function toastFailure(serverName, error) {
    toast('MCP server failed to connect', '\u201C' + str(serverName, 'unknown server') + '\u201D \u2014 ' + str(error, 'connect failed'), 'danger')
  }

  function toastFailures(failures) {
    if (!Array.isArray(failures)) return
    for (var i = 0; i < failures.length; i += 1) {
      var failure = failures[i]
      if (!isRecord(failure)) continue
      toastFailure(failure.serverName, failure.error)
    }
  }

  function clearToasts() {
    try {
      if (toastItems) {
        var items = []
        toastItems.forEach(function (item) { items.push(item) })
        for (var i = 0; i < items.length; i += 1) closeToast(items[i])
      }
      toastItems = null
      if (toastRoot && toastRoot.parentNode) toastRoot.parentNode.removeChild(toastRoot)
      toastRoot = null
    } catch (error) {
      warn('toast cleanup failed', error)
    }
  }

  // ─── panel state ──────────────────────────────────────────────────────────

  function closePanel() {
    try {
      if (panel && panel.refetchTimer !== null) clearTimeout(panel.refetchTimer)
      if (overlayRoot && overlayRoot.parentNode) overlayRoot.parentNode.removeChild(overlayRoot)
      overlayRoot = null
      if (panel && panel.escape) {
        document.removeEventListener('keydown', panel.escape, true)
        panel.escape = null
      }
      panel = null
    } catch (error) {
      warn('panel close failed', error)
      panel = null
      overlayRoot = null
    }
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text
  }

  /** A fresh element for one render pass; render() swaps it into the slot. */
  function toolRow(tool) {
    var row = el('div', 'ccmcp-tool')
    var rawName = isRecord(tool) ? (str(tool.name) || str(tool.rawName)) : ''
    var name = el('div', 'ccmcp-tool-name', rawName)
    if (rawName) name.title = rawName
    row.appendChild(name)
    var description = isRecord(tool) ? str(tool.description) : ''
    if (description) {
      var desc = el('p', 'ccmcp-tool-desc', description)
      desc.title = description
      row.appendChild(desc)
    }
    return row
  }

  function toolList(entry) {
    var tools = Array.isArray(entry.tools) ? entry.tools : []
    var box = el('div', 'ccmcp-tools' + (entry.disabled === true ? ' ccmcp-tools-muted' : ''))
    box.appendChild(el('div', 'ccmcp-tools-head', 'Tools (' + tools.length + ')'))
    var body = el('div', 'ccmcp-tools-body')
    if (tools.length === 0) {
      body.appendChild(el('div', 'ccmcp-empty', 'This server reported no tools'))
    } else {
      for (var i = 0; i < tools.length; i += 1) body.appendChild(toolRow(tools[i]))
    }
    box.appendChild(body)
    return box
  }

  // ─── render ───────────────────────────────────────────────────────────────

  function render() {
    var current = panel
    if (!current || !current.body || !current.subtitle) return
    try {
      var snapshot = current.snapshot
      if (current.view === 'detail') renderDetail(current, snapshot)
      else renderList(current, snapshot)
    } catch (error) {
      warn('panel render failed', error)
    }
  }

  /** A row the host has not settled yet keeps its spinner across re-renders. */
  function pendingEntry(current, entry) {
    return current.checkingKeys[entryKey(entry)] === true
  }

  function renderList(current, snapshot) {
    var servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : []
    var known = snapshot ? snapshot.known !== false : false
    setText(current.subtitle, subtitleFor(current, snapshot))
    clear(current.body)

    if (current.loading) {
      current.body.appendChild(spinRow('Loading servers\u2026'))
      return
    }
    if (!snapshot && current.error) {
      current.body.appendChild(emptyState(current.error, true))
      return
    }
    if (!known || servers.length === 0) {
      current.body.appendChild(emptyState('No MCP servers configured for this session', true))
      return
    }
    for (var i = 0; i < servers.length; i += 1) {
      if (isRecord(servers[i])) current.body.appendChild(serverRow(current, servers[i]))
    }
  }

  function emptyState(text, retry) {
    var box = el('div', 'ccmcp-empty')
    box.appendChild(el('p', 'ccmcp-empty-text', text))
    if (retry) {
      var button = el('button', 'ccmcp-btn', 'Retry')
      button.type = 'button'
      button.setAttribute('data-role', 'retry')
      button.addEventListener('click', function () { void refreshPanel() })
      box.appendChild(button)
    }
    return box
  }

  function spinRow(text) {
    var row = el('div', 'ccmcp-spin-row')
    row.appendChild(el('span', 'ccmcp-spinner'))
    row.appendChild(el('span', null, text))
    return row
  }

  function markBusy(button, busy) {
    clear(button)
    if (busy) {
      button.appendChild(el('span', 'ccmcp-spinner'))
      button.setAttribute('aria-busy', 'true')
    }
    button.disabled = busy === true
  }

  function scopeInfo(entry) {
    var scope = str(entry.scope)
    if (scope === 'plugin' || (!scope && str(entry.pluginName))) {
      return { label: 'Plugin', plugin: str(entry.pluginName) || 'plugin' }
    }
    if (scope === 'project') return { label: 'Project', plugin: '' }
    return { label: scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : 'Server', plugin: '' }
  }

  /* There is no "project root" to show — Claude Code discovers MCP config per
   * scope, so the subtitle counts what each scope contributed instead. */
  var SUBTITLE_SCOPES = ['project', 'user', 'local', 'plugin', 'host']

  function scopeSummary(snapshot) {
    var servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : []
    var parts = []
    for (var i = 0; i < SUBTITLE_SCOPES.length; i += 1) {
      var n = 0
      for (var j = 0; j < servers.length; j += 1) {
        if (str(servers[j].scope) === SUBTITLE_SCOPES[i]) n += 1
      }
      if (n > 0) parts.push(SUBTITLE_SCOPES[i] + ' ' + n)
    }
    return parts.join(' \u00B7 ')
  }

  function subtitleFor(current, snapshot) {
    if (current.loading) return 'Loading\u2026'
    var summary = snapshot ? scopeSummary(snapshot) : ''
    return summary || 'No MCP servers'
  }

  function typeCell(entry) {
    var cell = el('div', 'ccmcp-type')
    var info = scopeInfo(entry)
    cell.appendChild(el('span', null, info.label))
    var transport = str(entry.transport, 'stdio')
    cell.appendChild(el('span', 'ccmcp-type-transport', ' \u00B7 ' + transport))
    return cell
  }

  function serverRow(current, entry) {
    var row = el('button', 'ccmcp-row')
    row.type = 'button'
    row.setAttribute('data-role', 'row')
    row.setAttribute('data-key', entryKey(entry))
    row.appendChild(el('span', 'ccmcp-glyph', firstLetter(entry.serverName)))
    row.appendChild(el('span', 'ccmcp-name', str(entry.serverName, 'unnamed server')))
    row.appendChild(typeCell(entry))
    row.appendChild(statusCell(current, entry))
    row.addEventListener('click', function () { openDetail(entryKey(entry)) })
    return row
  }

  function firstLetter(serverName) {
    var name = str(serverName)
    return name ? name.charAt(0) : '?'
  }

  /** The status cell owns its own buttons, so a click here must not open the row. */
  function statusCell(current, entry) {
    var cell = el('div', 'ccmcp-status')
    cell.setAttribute('data-role', 'status')
    cell.addEventListener('click', function (event) { event.stopPropagation() })

    if (pendingEntry(current, entry)) {
      cell.appendChild(el('span', 'ccmcp-spinner'))
      return cell
    }
    var status = str(entry.status, 'checking')
    if (status === 'ready') {
      var check = el('button', 'ccmcp-iconbtn')
      check.type = 'button'
      check.setAttribute('data-role', 'status-ready')
      check.title = 'Re-check this server'
      check.setAttribute('aria-label', 'Re-check ' + str(entry.serverName, 'server'))
      check.textContent = '\u2713'
      check.addEventListener('click', function (event) {
        event.stopPropagation()
        markBusy(check, true)
        void reconnect(current, entryKey(entry), function () { markBusy(check, false) })
      })
      cell.appendChild(check)
      return cell
    }
    if (status === 'error') {
      var connect = el('button', 'ccmcp-btn', 'Connect')
      connect.type = 'button'
      connect.setAttribute('data-role', 'status-error')
      connect.addEventListener('click', function (event) {
        event.stopPropagation()
        markBusy(connect, true)
        void reconnect(current, entryKey(entry), function () {
          markBusy(connect, false)
          /* The panel re-renders with a fresh button, so only restore the label
           * while this exact node is still the one on screen. */
          if (connect.isConnected !== false) connect.textContent = 'Connect'
        })
      })
      cell.appendChild(connect)
      return cell
    }
    if (status === 'disabled') {
      cell.appendChild(el('span', 'ccmcp-status-muted', 'Disabled'))
      return cell
    }
    if (status === 'skipped') {
      cell.appendChild(el('span', 'ccmcp-status-muted', 'Host'))
      return cell
    }
    cell.appendChild(el('span', 'ccmcp-spinner'))
    return cell
  }

  function renderDetail(current, snapshot) {
    var servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : []
    setText(current.subtitle, subtitleFor(current, snapshot))
    var entry = null
    for (var i = 0; i < servers.length; i += 1) {
      if (entryKey(servers[i]) === current.selectedKey) { entry = servers[i]; break }
    }
    clear(current.body)
    if (!entry) {
      current.view = 'list'
      renderList(current, snapshot)
      return
    }
    current.body.appendChild(detailHead(current, entry))
    current.body.appendChild(statusLine(current, entry))

    if (!current.checking) {
      var info = scopeInfo(entry)
      var source = str(entry.sourcePath) || str(entry.source)
      var sourceLine
      if (str(entry.scope) === 'host') {
        /* A host row is the profile's own dsh-mcp-client instance: this plugin
         * lists it and can hide it here, but the host owns the connection. */
        sourceLine = source || 'Host MCP client row in the profile config'
      } else if (info.plugin) {
        sourceLine = 'Plugin ' + info.plugin + ' \u00b7 ' + (str(entry.pluginPath) || source || 'unknown path')
      } else {
        /* Where the server was read from: the scope it was declared in and the
         * file itself. Claude Code discovers MCP config per scope, so this is
         * the whole provenance \u2014 there is no project root behind it. */
        sourceLine = info.label + ' scope \u00b7 ' + (source || 'unknown source')
      }
      current.body.appendChild(el('p', 'ccmcp-source', sourceLine))
    } else {
      current.body.appendChild(spinRow('Checking\u2026'))
    }
    current.body.appendChild(toolList(entry))
  }

  function detailHead(current, entry) {
    var head = el('div', 'ccmcp-head')
    head.style.flexDirection = 'column'
    head.style.gap = '6px'
    var back = el('button', 'ccmcp-backbtn', '\u2190 All servers')
    back.type = 'button'
    back.setAttribute('data-role', 'back')
    back.addEventListener('click', function () {
      if (panel !== current) return
      current.view = 'list'
      current.selectedKey = ''
      render()
    })
    head.appendChild(back)

    var row = el('div', 'ccmcp-detail-head')
    var main = el('div', 'ccmcp-head-main')
    var titleRow = el('div', 'ccmcp-detail-head')
    titleRow.appendChild(el('span', 'ccmcp-glyph', firstLetter(entry.serverName)))
    titleRow.appendChild(el('span', 'ccmcp-name', str(entry.serverName, 'unnamed server')))
    titleRow.appendChild(el('span', 'ccmcp-type-transport', str(entry.transport, 'stdio')))
    main.appendChild(titleRow)
    row.appendChild(main)
    row.appendChild(toggleButton(current, entry))
    head.appendChild(row)
    return head
  }

  function toggleButton(current, entry) {
    var actions = el('div', 'ccmcp-head-actions')
    if (str(entry.status) === 'skipped') return actions
    var disabled = entry.disabled === true
    var button = el('button', 'ccmcp-btn', disabled ? 'Enable' : 'Disable')
    button.type = 'button'
    button.setAttribute('data-role', 'toggle')
    button.addEventListener('click', function () {
      markBusy(button, true)
      void toggleServer(current, entryKey(entry), !disabled, function () {
        markBusy(button, false)
        if (button.isConnected !== false) button.textContent = disabled ? 'Enable' : 'Disable'
      })
    })
    actions.appendChild(button)
    return actions
  }

  function statusLine(current, entry) {
    var status = pendingEntry(current, entry) ? 'checking' : str(entry.status, 'checking')
    var line = el('div', 'ccmcp-statusline')
    line.setAttribute('data-role', 'statusline')
    if (status === 'ready') {
      line.className += ' ccmcp-statusline-ready'
      var suffix = ''
      if (str(entry.scope) === 'host') {
        /* Say who holds the connection: the host's own row, or this plugin
         * after Connect adopted a row that exposed nothing. */
        suffix = entry.managed === true ? ' \u00B7 adopted for this workspace' : ' \u00B7 connected by the host'
      }
      line.appendChild(el('span', null, 'Connected \u00B7 ' + (Number(entry.toolCount) || 0) + ' tools' + suffix))
      return line
    }
    if (status === 'error') {
      line.className += ' ccmcp-statusline-error'
      line.appendChild(el('span', null, 'Disconnected'))
      var detail = str(entry.error, 'the server did not respond')
      line.appendChild(el('span', 'ccmcp-statusline-detail', '\u2014 ' + detail))
      return line
    }
    if (status === 'disabled') {
      line.className += ' ccmcp-statusline-muted'
      line.appendChild(el('span', null, 'Disabled \u2014 tools are not in the model context'))
      return line
    }
    if (status === 'skipped') {
      line.className += ' ccmcp-statusline-muted'
      line.appendChild(el('span', null, 'Provided by a host MCP client'))
      return line
    }
    line.className += ' ccmcp-statusline-muted'
    line.appendChild(el('span', 'ccmcp-spinner'))
    line.appendChild(el('span', null, 'Checking\u2026'))
    return line
  }

  // ─── data access ──────────────────────────────────────────────────────────

  function entryFor(key) {
    if (!panel || !panel.entries) return null
    return panel.entries[key] || null
  }

  /** Overlay a live entry (post-connect / post-disable) onto the snapshot in place. */
  function reshape(snapshot, overrides) {
    if (!isRecord(snapshot)) return snapshot
    var servers = Array.isArray(snapshot.servers) ? snapshot.servers.slice() : []
    var index = {}
    var i
    for (i = 0; i < servers.length; i += 1) index[entryKey(servers[i])] = i
    var keys = isRecord(overrides) ? Object.keys(overrides) : []
    for (i = 0; i < keys.length; i += 1) {
      var key = keys[i]
      var entry = overrides[key]
      var at = index[key]
      if (at === undefined) {
        servers.push(entry)
        index[key] = servers.length - 1
      } else {
        servers[at] = entry
      }
    }
    var next = {}
    var names = Object.keys(snapshot)
    for (i = 0; i < names.length; i += 1) next[names[i]] = snapshot[names[i]]
    next.servers = servers
    return next
  }

  function fetchSnapshot() {
    var current = panel
    if (!current) return Promise.resolve(null)
    return api('state', { sessionId: current.sessionId }).then(function (response) {
      if (panel !== current) return null
      if (response.ok !== true) {
        current.snapshot = null
        current.error = errorOf(response, 'Could not read MCP state')
        current.loading = false
        syncPending()
        return null
      }
      current.snapshot = reshape(response.value, current.entries)
      current.error = ''
      current.loading = false
      syncPending()
      return current.snapshot
    })
  }

  /**
   * `state` never blocks, so the host's start-up self-check can surface rows as
   * `checking`. While any row is in flight, refetch on a timer until the list
   * settles — bounded, so a check that never finishes cannot poll forever.
   */
  function syncPending() {
    var current = panel
    if (!current) return
    var servers = current.snapshot && Array.isArray(current.snapshot.servers) ? current.snapshot.servers : []
    var live = {}
    for (var i = 0; i < servers.length; i += 1) {
      var entry = servers[i]
      var key = entryKey(entry)
      if (key && str(entry.status) === 'checking') live[key] = true
    }
    var keys = Object.keys(current.checkingKeys)
    for (i = 0; i < keys.length; i += 1) {
      if (!live[keys[i]]) {
        current.checkingKeys[keys[i]] = false
        delete current.checkingKeys[keys[i]]
      }
    }
    var liveKeys = Object.keys(live)
    for (i = 0; i < liveKeys.length; i += 1) current.checkingKeys[liveKeys[i]] = true

    if (liveKeys.length > 0) {
      if (current.refetchUntil === 0) current.refetchUntil = Date.now() + REFETCH_CAP_MS
      if (current.refetchTimer === null) {
        current.refetchTimer = setTimeout(function () {
          if (panel !== current) return
          current.refetchTimer = null
          if (Date.now() > current.refetchUntil) return
          void refreshPanel()
        }, REFETCH_INTERVAL_MS)
      }
      return
    }
    if (current.refetchTimer !== null) {
      clearTimeout(current.refetchTimer)
      current.refetchTimer = null
    }
    current.refetchUntil = 0
  }

  /** Full refresh: re-pull the snapshot, then re-render whatever view is open. */
  function refreshPanel() {
    var current = panel
    if (!current) return Promise.resolve(null)
    return fetchSnapshot().then(function (snapshot) {
      if (panel !== current) return snapshot
      if (snapshot && current.snapshot) current.snapshot = reshape(current.snapshot, current.entries)
      render()
      return snapshot
    })
  }

  function recordEntry(entry) {
    if (!panel || !isRecord(entry)) return
    var key = entryKey(entry)
    if (key) panel.entries[key] = entry
  }

  function reconnect(current, key, done) {
    if (panel !== current || !key) { if (done) done(); return Promise.resolve(null) }
    var previous = entryFor(key)
    current.checking = true
    current.entries[key] = mergeEntry(previous, { status: 'checking', error: null })
    render()
    return api('connect', { sessionId: current.sessionId, key: key }).then(function (response) {
      var entry = entryOf(response)
      if (panel !== current) { if (done) done(); return null }
      if (entry) {
        recordEntry(entry)
        if (str(entry.status) === 'error') toastFailure(entry.serverName, entry.error)
      } else {
        current.entries[key] = mergeEntry(previous, {
          status: 'error',
          error: errorOf(response, 'connect failed'),
        })
        toastFailure(previous && previous.serverName, errorOf(response, 'connect failed'))
      }
      current.checking = false
      return refreshPanel().then(function () { if (done) done(); return entry })
    }, function (error) {
      if (panel === current) {
        current.checking = false
        current.entries[key] = mergeEntry(previous, { status: 'error', error: String((error && error.message) || error) })
      }
      toastFailure(previous && previous.serverName, (error && error.message) || error)
      if (done) done()
      return null
    })
  }

  function mergeEntry(previous, patch) {
    var next = {}
    var names = isRecord(previous) ? Object.keys(previous) : []
    for (var i = 0; i < names.length; i += 1) next[names[i]] = previous[names[i]]
    var keys = Object.keys(patch)
    for (var j = 0; j < keys.length; j += 1) next[keys[j]] = patch[keys[j]]
    return next
  }

  function toggleServer(current, key, disabled, done) {
    if (panel !== current || !key) { if (done) done(); return Promise.resolve(null) }
    var previous = entryFor(key)
    return api('disable', { sessionId: current.sessionId, key: key, disabled: disabled }).then(function (response) {
      var entry = entryOf(response)
      if (panel !== current) { if (done) done(); return null }
      if (entry) {
        recordEntry(entry)
      } else {
        toast('MCP server action failed', str(previous && previous.serverName, key) + ' \u2014 ' + errorOf(response, 'the request failed'), 'danger')
      }
      return refreshPanel().then(function () { if (done) done(); return entry })
    }, function (error) {
      toast('MCP server action failed', str(previous && previous.serverName, key) + ' \u2014 ' + String((error && error.message) || error), 'danger')
      if (done) done()
      return null
    })
  }

  // ─── panel lifecycle ──────────────────────────────────────────────────────

  function openPanel(sessionId) {
    if (!isDom()) return
    try {
      closePanel()
      var session = str(sessionId)
      if (!session) {
        toast('MCP panel unavailable', 'No conversation is open, so there is no project to inspect.', 'danger')
        return
      }
      panel = {
        sessionId: session,
        view: 'list',
        selectedKey: '',
        snapshot: null,
        error: '',
        entries: {},
        checkingKeys: {},
        loading: true,
        checking: false,
        refetchTimer: null,
        refetchUntil: 0,
        escape: null,
        body: null,
        subtitle: null,
      }
      var current = panel

      var overlay = el('div', 'ccmcp-overlay')
      overlay.setAttribute('data-plugin', PLUGIN_ID)
      var backdrop = el('div', 'ccmcp-backdrop')
      backdrop.setAttribute('data-role', 'backdrop')
      backdrop.addEventListener('click', function () { if (panel === current) closePanel() })
      overlay.appendChild(backdrop)

      var card = el('div', 'ccmcp-panel')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-label', 'MCP servers')

      var head = el('div', 'ccmcp-head')
      var headMain = el('div', 'ccmcp-head-main')
      headMain.appendChild(el('h2', 'ccmcp-title', 'MCP servers'))
      var subtitle = el('p', 'ccmcp-subtitle', 'Loading\u2026')
      headMain.appendChild(subtitle)
      head.appendChild(headMain)

      var headActions = el('div', 'ccmcp-head-actions')
      var close = el('button', 'ccmcp-iconbtn', '\u2715')
      close.type = 'button'
      close.setAttribute('data-role', 'close')
      close.setAttribute('aria-label', 'Close MCP servers')
      close.addEventListener('click', function () { if (panel === current) closePanel() })
      headActions.appendChild(close)
      head.appendChild(headActions)

      var body = el('div', 'ccmcp-body')
      card.appendChild(head)
      card.appendChild(body)
      overlay.appendChild(card)
      document.body.appendChild(overlay)

      overlayRoot = overlay
      current.body = body
      current.subtitle = subtitle

      /* Escape closes from anywhere in the page, and survives the conversation
       * re-rendering: it is a document listener, not a component one. */
      current.escape = function (event) {
        if (event && event.key === 'Escape' && panel === current) {
          event.stopPropagation()
          closePanel()
        }
      }
      document.addEventListener('keydown', current.escape, true)

      render()
      void refreshPanel()
    } catch (error) {
      warn('panel open failed', error)
      closePanel()
    }
  }

  function openDetail(key) {
    if (!panel || !key) return
    panel.selectedKey = key
    panel.view = 'detail'
    render()
  }

  // ─── session self-check ───────────────────────────────────────────────────

  function clearCheckRetry() {
    if (checkRetryTimer !== null) {
      clearTimeout(checkRetryTimer)
      checkRetryTimer = null
    }
  }

  function scheduleCheck(sessionId, delay) {
    clearCheckRetry()
    checkRetryTimer = setTimeout(function () {
      checkRetryTimer = null
      runCheck(sessionId, false)
    }, delay)
  }

  /**
   * Fire-and-forget `GET /cc-mcp/check` for the current session. Bounded: at
   * most a couple of retries while the host reports `checked: false`, and one
   * pass per failure so a stuck check can never tight-loop.
   */
  function runCheck(sessionId, isRetry) {
    var id = str(sessionId)
    if (!id) return
    if (!isRetry && checkSessionId === id) return
    if (pendingCheck === id) return
    checkSessionId = id
    pendingCheck = id
    api('check', { sessionId: id }).then(function (response) {
      if (pendingCheck === id) pendingCheck = null
      if (checkSessionId !== id) return
      if (response.ok !== true) {
        if (isRetry) warn('self-check failed: ' + errorOf(response, codeOf(response)))
        return
      }
      var value = isRecord(response.value) ? response.value : {}
      if (value.checked === true) {
        toastFailures(value.failures)
        checkRetryIndex = 0
        return
      }
      if (checkRetryIndex < CHECK_RETRY_DELAYS.length) {
        scheduleCheck(id, CHECK_RETRY_DELAYS[checkRetryIndex])
        checkRetryIndex += 1
      }
    }, function () {
      if (pendingCheck === id) pendingCheck = null
      checkRetryIndex = 0
    })
  }

  function bindSessionsInject() {
    if (sessionUnsub) return
    if (!sessionsScope || !sessionsScope.sessions || !sessionsScope.sessions.list) return
    var list = sessionsScope.sessions.list
    if (typeof list.subscribe !== 'function' || typeof list.getSnapshot !== 'function') return
    var last = null
    var observer = function () {
      var snapshot = null
      try { snapshot = list.getSnapshot() } catch (error) { warn('session snapshot read failed', error); return }
      var current = isRecord(snapshot) ? str(snapshot.current) : ''
      if (current === last) return
      last = current
      checkRetryIndex = 0
      clearCheckRetry()
      if (current) runCheck(current, false)
    }
    sessionUnsub = list.subscribe(observer)
    observer()
  }

  // ─── plugin ───────────────────────────────────────────────────────────────

  function injectCmds(ctx) {
    if (!ctx || typeof ctx.inject !== 'function') return
    ctx.inject(['commandUi'], function (scope) {
      try {
        /* Resolve the service eagerly: if the scope cannot see it, the deferred
         * injection firing is a no-op rather than a half-registered decoration. */
        var commandUi = scope.commandUi
        if (!commandUi || typeof commandUi.decorate !== 'function') return
        scope.effect(function () {
          return commandUi.decorate({
            name: 'mcp',
            available: function () { return true },
            ui: {
              kind: 'action',
              run: function (session) {
                try {
                  openPanel(session && session.sessionId)
                } catch (error) {
                  warn('/mcp decoration failed', error)
                }
              },
            },
          })
        }, 'cc-mcp: /mcp')
      } catch (error) {
        warn('/mcp decoration failed', error)
      }
    })
  }

  function injectSessions(ctx) {
    var seq = ++bindSeq
    if (!ctx || typeof ctx.inject !== 'function') return
    ctx.inject(['sessions'], function (scope) {
      try {
        sessionsScope = scope
        var applied = scope.effect(function () {
          bindSessionsInject()
          return function () {
            sessionsScope = null
            if (sessionUnsub) {
              try { sessionUnsub() } catch (error) { warn('session unsubscribe failed', error) }
              sessionUnsub = null
            }
          }
        }, 'cc-mcp: session self-check')
        /* Belt and braces: if the plugin was disposed while this registration
         * was still in flight, cordis suppresses the effect — release the
         * subscription ourselves rather than leave it dangling. */
        if (seq !== bindSeq && typeof applied === 'function') {
          try { applied() } catch (error) { warn('session self-check teardown failed', error) }
        }
      } catch (error) {
        warn('session self-check unavailable', error)
      }
    })
  }

  // ─── cc-update notice (begin shared block) ───────────────────────────────
  // Byte-identical in every client half that ships it (test/update-notice-
  // client.test.mjs compares the copies). Self-contained on purpose: own
  // styles, own DOM, own transport, so the host file only adds the
  // cuShowNotice() call in apply().
  //
  // The modal only DISPLAYS commands for the user to copy. It never runs
  // anything, and the only server-supplied value that reaches a command is a
  // strict semver; package names come from the allow-list below.
  var CU_CHANNEL = '/cc-update'
  var CU_STYLE_ID = 'dsh-cc-update-notice.css'
  var CU_GLOBAL = '__dshCcUpdateNotice'
  var CU_PACKAGES = ['dsh-cc-skills', 'dsh-cc-permissions', 'dsh-cc-agents', 'dsh-cc-hooks', 'dsh-cc-mcp', 'dsh-cc-memory']
  var CU_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  // Banner self-dismisses after this long without interaction; a later launch
  // shows it again unless the release was explicitly dismissed.
  var CU_BANNER_MS = 5000
  var CU_NOTES = 'https://github.com/Bcy2020/dsh-cc-ecosystem/releases/'

  function cuWarn(message, error) {
    try {
      if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
        console.warn('[cc-update] ' + message + ': ' + String((error && error.message) || error || ''))
      }
    } catch (ignored) { /* logging must never break the caller */ }
  }

  function cuEl(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null && text !== '') node.textContent = text
    return node
  }

  function cuStyles() {
    if (document.getElementById(CU_STYLE_ID)) return
    var tag = document.createElement('style')
    tag.id = CU_STYLE_ID
    tag.textContent = [
      // Liquid glass: a low-opacity tint (the page behind stays visible through
      // it), heavy blur + saturation, a specular sheen, and a gradient hairline
      // rim drawn with a mask so the edge reads as glass thickness.
      '@keyframes ccu-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.ccu-banner,.ccu-modal{animation:none}}',
      '.ccu-banner{position:fixed;right:20px;bottom:20px;z-index:1120;display:flex;align-items:center;gap:12px;padding:12px 14px 12px 20px;border-radius:20px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 68%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 38%,transparent));-webkit-backdrop-filter:blur(32px) saturate(180%) brightness(1.24);backdrop-filter:blur(32px) saturate(180%) brightness(1.24);box-shadow:0 18px 44px -12px rgb(0 0 0 / 30%),0 1px 2px rgb(0 0 0 / 6%),inset 0 1px 0 rgb(255 255 255 / 62%),inset 0 -1px 0 rgb(255 255 255 / 14%);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115);animation:ccu-in .22s cubic-bezier(.2,.8,.2,1);transition:opacity .34s ease,transform .34s ease}',
      '.ccu-banner-out{opacity:0;transform:translateY(8px) scale(.985);pointer-events:none}',
      '.ccu-banner::before{content:"";position:absolute;inset:0;border-radius:inherit;background:radial-gradient(90% 130% at 18% 0%,rgb(255 255 255 / 55%),rgb(255 255 255 / 0%) 62%);pointer-events:none}',
      '.ccu-banner::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(150deg,rgb(255 255 255 / 88%),rgb(255 255 255 / 12%) 36%,rgb(255 255 255 / 0%) 62%,rgb(255 255 255 / 34%));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}',
      '.ccu-banner-text{position:relative;flex:1 1 auto;min-width:0}',
      '.ccu-btn{position:relative;appearance:none;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 12%,transparent);background:linear-gradient(180deg,rgb(255 255 255 / 52%),rgb(255 255 255 / 26%));color:inherit;border-radius:999px;padding:6px 16px;font-size:12px;line-height:18px;cursor:pointer;font-family:inherit;box-shadow:0 1px 3px rgb(0 0 0 / 10%),inset 0 1px 0 rgb(255 255 255 / 65%),inset 0 -1px 0 rgb(0 0 0 / 6%);transition:transform .12s ease,filter .12s ease}',
      '.ccu-btn:hover{filter:brightness(1.1)}',
      '.ccu-btn:active{transform:scale(.97)}',
      '.ccu-btn-primary{background:linear-gradient(180deg,rgb(108 168 255 / 96%),rgb(47 109 246 / 96%));border-color:rgb(255 255 255 / 45%);color:#fff;box-shadow:0 8px 20px -6px rgb(47 109 246 / 55%),inset 0 1px 0 rgb(255 255 255 / 55%),inset 0 -1px 0 rgb(0 0 0 / 10%)}',
      '.ccu-btn-primary:hover{filter:brightness(1.08)}',
      '.ccu-ghost{appearance:none;border:0;background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 62%,transparent);cursor:pointer;font-size:12px;padding:6px 12px;border-radius:999px;font-family:inherit;transition:background-color .12s ease,color .12s ease}',
      '.ccu-ghost:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 8%,transparent);color:var(--dsw-alias-label-primary,#0f1115)}',
      '.ccu-overlay{position:fixed;inset:0;z-index:1130;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.ccu-backdrop{position:absolute;inset:0;background:rgb(6 8 12 / 46%);-webkit-backdrop-filter:blur(7px) saturate(110%);backdrop-filter:blur(7px) saturate(110%)}',
      '.ccu-modal{position:relative;width:580px;max-width:100%;max-height:82vh;overflow:auto;border-radius:30px;padding:26px 26px 22px;counter-reset:ccu-step;background:linear-gradient(145deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 46%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 20%,transparent));-webkit-backdrop-filter:blur(54px) saturate(175%) brightness(1.55);backdrop-filter:blur(54px) saturate(175%) brightness(1.55);box-shadow:0 0 0 1px rgb(255 255 255 / 30%),0 0 90px 14px rgb(255 255 255 / 24%),0 44px 110px -20px rgb(0 0 0 / 55%),inset 0 1px 0 rgb(255 255 255 / 78%),inset 0 -1px 0 rgb(255 255 255 / 18%);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;line-height:20px;animation:ccu-in .22s cubic-bezier(.2,.8,.2,1)}',
      '.ccu-modal::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:radial-gradient(120% 62% at 50% -14%,rgb(255 255 255 / 52%),rgb(255 255 255 / 0%) 64%)}',
      '.ccu-modal::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(155deg,rgb(255 255 255 / 92%),rgb(255 255 255 / 14%) 30%,rgb(255 255 255 / 0%) 58%,rgb(255 255 255 / 30%));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}',
      '.ccu-modal h2{position:relative;margin:0 0 4px;font-size:18px;line-height:26px;font-weight:650;letter-spacing:.1px}',
      '.ccu-sub{position:relative;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.ccu-step{position:relative;counter-increment:ccu-step;display:flex;align-items:center;gap:10px;margin:20px 0 8px;font-weight:600;font-size:13px}',
      '.ccu-step::before{content:counter(ccu-step);display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;font-size:11px;font-weight:600;color:var(--dsw-alias-link-primary,#2f6df6);background:color-mix(in srgb,var(--dsw-alias-link-primary,#2f6df6) 13%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-link-primary,#2f6df6) 26%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 70%),0 1px 2px rgb(0 0 0 / 6%)}',
      '.ccu-cmd{position:relative;display:flex;align-items:center;gap:10px;margin:6px 0;padding:10px 10px 10px 16px;border-radius:18px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 6%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 9%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 45%);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px}',
      '.ccu-cmd code{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
      '.ccu-actions{position:relative;display:flex;justify-content:flex-end;margin-top:22px}',
      '.ccu-foot{position:relative;margin:16px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9097)}',
      '.ccu-link{color:var(--dsw-alias-link-primary,#4c7dff);text-decoration:none}',
      '.ccu-link:hover{text-decoration:underline}',
    ].join('\n')
    document.head.appendChild(tag)
  }

  function cuCall(endpoint, method, payload) {
    try {
      if (typeof fetch !== 'function') return Promise.resolve(null)
      var init = { method: method, headers: { 'x-cc-update': '1' }, credentials: 'same-origin' }
      if (payload !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(payload)
      }
      return fetch(CU_CHANNEL + '/' + endpoint, init).then(function (response) {
        return response.json()
      }).then(function (result) {
        return result && result.ok === true ? result.value : null
      }, function () { return null })
    } catch (error) {
      return Promise.resolve(null)
    }
  }

  function cuValidVersion(value) {
    return typeof value === 'string' && CU_SEMVER.test(value)
  }

  // Exactly what the install box accepts: `name@version`, nothing else.
  function cuTargets(state) {
    var update = state && state.update
    if (!update || !cuValidVersion(update.bundle)) return []
    if (state.bundleUser === true) {
      return ['dsh-cc-ecosystem@' + update.bundle]
    }
    var out = []
    var list = Array.isArray(update.updates) ? update.updates : []
    for (var index = 0; index < list.length; index += 1) {
      var entry = list[index]
      if (!entry || CU_PACKAGES.indexOf(entry.name) < 0 || !cuValidVersion(entry.latest)) continue
      out.push(entry.name + '@' + entry.latest)
    }
    return out
  }

  function cuCopy(text, button) {
    try {
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () {
          button.textContent = '已复制'
        }, function () { cuWarn('clipboard write failed') })
        return
      }
    } catch (error) { cuWarn('clipboard unavailable', error) }
    try {
      var area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', 'readonly')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      document.body.removeChild(area)
      button.textContent = '已复制'
    } catch (error) { cuWarn('copy fallback failed', error) }
  }

  function cuOpenModal(state) {
    var update = state.update
    var overlay = cuEl('div', 'ccu-overlay')
    var backdrop = cuEl('div', 'ccu-backdrop')
    var modal = cuEl('div', 'ccu-modal')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-label', 'dsh-cc-ecosystem 更新')
    overlay.appendChild(backdrop)
    overlay.appendChild(modal)

    var onKey = function (event) {
      if (event && event.key === 'Escape') { event.stopPropagation(); close() }
    }
    var close = function () {
      try { document.removeEventListener('keydown', onKey, true) } catch (ignored) { /* gone */ }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }
    backdrop.addEventListener('click', close)

    modal.appendChild(cuEl('h2', '', 'dsh-cc-ecosystem ' + update.bundle + ' 可用'))
    var sub = cuEl('p', 'ccu-sub', '当前 ' + (state.current || '未知') + '。')
    if (typeof update.notes === 'string' && update.notes.indexOf(CU_NOTES) === 0) {
      var link = cuEl('a', 'ccu-link', '发版说明')
      link.href = update.notes
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
      sub.appendChild(document.createTextNode(' '))
      sub.appendChild(link)
    }
    modal.appendChild(sub)

    modal.appendChild(cuEl('div', 'ccu-step', '先在插件管理里卸载旧版本'))
    modal.appendChild(cuEl('div', 'ccu-step', '把这个填进安装框'))
    var targets = cuTargets(state)
    if (targets.length === 0) modal.appendChild(cuEl('p', 'ccu-sub', '没有可用的升级目标。'))
    for (var index = 0; index < targets.length; index += 1) {
      var row = cuEl('div', 'ccu-cmd')
      row.appendChild(cuEl('code', '', targets[index]))
      var copy = cuEl('button', 'ccu-btn', '复制')
      copy.type = 'button'
      ;(function (target, button) {
        button.addEventListener('click', function () { cuCopy(target, button) })
      })(targets[index], copy)
      row.appendChild(copy)
      modal.appendChild(row)
    }
    var actions = cuEl('div', 'ccu-actions')
    var closeButton = cuEl('button', 'ccu-btn', '关闭')
    closeButton.type = 'button'
    closeButton.addEventListener('click', close)
    actions.appendChild(closeButton)
    modal.appendChild(actions)
    modal.appendChild(cuEl('p', 'ccu-foot', '只显示要填进安装框的内容，不会替你下载或执行任何东西。'))
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
  }

  function cuFadeOut(banner) {
    if (!banner || !banner.parentNode) return
    banner.classList.add('ccu-banner-out')
    setTimeout(function () {
      if (banner.parentNode) banner.parentNode.removeChild(banner)
    }, 360)
  }

  function cuShowBanner(state) {
    var banner = cuEl('div', 'ccu-banner')
    banner.setAttribute('role', 'status')
    banner.appendChild(cuEl('div', 'ccu-banner-text', 'dsh-cc-ecosystem ' + state.update.bundle + ' 可用'))

    var timer = null
    var stop = function () {
      if (timer !== null) { clearTimeout(timer); timer = null }
    }
    var arm = function () {
      stop()
      timer = setTimeout(function () { timer = null; cuFadeOut(banner) }, CU_BANNER_MS)
    }

    var open = cuEl('button', 'ccu-btn ccu-btn-primary', '查看')
    open.type = 'button'
    open.addEventListener('click', function () {
      stop()
      cuFadeOut(banner)
      try { cuOpenModal(state) } catch (error) { cuWarn('modal failed', error) }
    })
    banner.appendChild(open)
    var later = cuEl('button', 'ccu-ghost', '不再提醒')
    later.type = 'button'
    later.addEventListener('click', function () {
      stop()
      cuFadeOut(banner)
      // Stored per release: a newer release has a different bundle version and
      // therefore appears again.
      cuCall('dismiss', 'POST', { version: state.update.bundle })
    })
    banner.appendChild(later)
    // Hovering pauses the countdown so reading it is never cut short.
    banner.addEventListener('mouseenter', stop)
    banner.addEventListener('mouseleave', arm)
    document.body.appendChild(banner)
    arm()
  }

  /** Called from apply(); at most one banner per page load. */
  function cuShowNotice() {
    try {
      if (typeof document === 'undefined' || document === null) return
      var existing = window[CU_GLOBAL]
      if (existing && existing.shown === true) return
      window[CU_GLOBAL] = { shown: true }
      cuStyles()
      cuCall('state', 'GET').then(function (state) {
        if (state === null || typeof state !== 'object') return
        var update = state.update
        if (update === null || typeof update !== 'object' || !cuValidVersion(update.bundle)) return
        if (state.dismissed === update.bundle) return
        cuShowBanner(state)
      })
    } catch (error) {
      cuWarn('notice failed', error)
    }
  }
  // ─── cc-update notice (end shared block) ─────────────────────────────────

  function apply(ctx) {
    try {
      styleEl = installStyles()
      try { cuShowNotice() } catch (error) { warn('update notice failed', error) }
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            try { closePanel() } catch (error) { warn('panel teardown failed', error) }
            try { clearToasts() } catch (error) { warn('toast teardown failed', error) }
            clearCheckRetry()
            bindSeq += 1
            if (sessionUnsub) {
              try { sessionUnsub() } catch (error) { warn('session unsubscribe failed', error) }
            }
            sessionUnsub = null
            sessionsScope = null
            checkSessionId = null
            pendingCheck = null
            checkRetryIndex = 0
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
            styleEl = null
          }
        }, 'cc-mcp: panel lifecycle')
      }
      injectCmds(ctx)
      injectSessions(ctx)
    } catch (error) {
      /* apply() must never throw: a throw fails the fibre and the whole GUI
       * page boot. */
      warn('apply failed', error)
    }
  }

  module.exports = {
    name: 'dsh-cc-mcp-client',
    inject: [],
    apply: apply,
    /* Programmatic face of the same transport the panel uses; every call
     * resolves to a result envelope and never throws. */
    api: api,
  }
  return module.exports
} });
