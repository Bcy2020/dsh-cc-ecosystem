window.__ModuleLoader__.load({ id: "dsh-cc-hooks", factory: (require) => {
  'use strict'
  var module = { exports: {} }; var exports = module.exports;

  // dsh-cc-hooks — browser half (agent-stop notices).
  //
  // The host half has no plugin-only notice channel: the client-side `notice`
  // effect is driven by command results, and the experimental `ui.toast` host
  // op only logs. So this half polls the plugin's own route and draws the
  // notice itself, at the end of the chat column, in a smaller muted style that
  // reads as a system row rather than as the assistant's words.
  //
  // Transport: same-origin GETs to `/cc-hooks/notices?sessionId=…`. There is no
  // host→browser push, so the poll is the delivery path.
  //
  // Plain DOM, no imports, no require, no build step, no top-level await: this
  // file is a CLASSIC script that several bundles get concatenated into, so the
  // single top-level statement above is this whole file.

  var CHANNEL = '/cc-hooks'
  var STYLE_ID = 'dsh-cc-hooks/notice.css'
  // The main-view selection the Workspace Controller persists; its snapshot is
  // `{ sessionId }`. This is the only place the browser half can learn which
  // session the chat column is showing — the sessions service's list snapshot
  // carries ids/byId/phase, never a "current" pointer.
  var CURRENT_SESSION_KEY = 'dsh.sessions.current'
  // One document, one owner. The bundle can be instantiated more than once in the
  // same page (each instance would poll and draw its own duplicate container).
  var INSTANCE_KEY = '__dshCcHooksClient'
  var POLL_MS = 1000

  var styleEl = null
  var timer = null
  var sessionId = ''
  var container = null
  var containerColumn = null

  function warn(message, error) {
    try {
      var text = error === undefined ? message : message + ': ' + String((error && error.message) || error)
      if (typeof console !== 'undefined' && console !== null && typeof console.warn === 'function') console.warn(text)
    } catch (ignored) { /* logging must never break the caller */ }
  }

  function isDom() {
    return typeof document !== 'undefined' && document !== null && typeof document.createElement === 'function'
  }

  function str(value, fallback) {
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number' && isFinite(value)) return String(value)
    return fallback === undefined ? '' : fallback
  }

  // ─── styles ───────────────────────────────────────────────────────────────

  var STYLES = [
    '.cch-notices{display:flex;flex-direction:column;gap:6px;padding:2px 0 10px}',
    '.cch-notice{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 22%,transparent);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.cch-notice-label{flex:0 0 auto;padding-top:1px;font-size:10.5px;line-height:16px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-state-warning-primary,#d97706)}',
    '.cch-notice-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}',
  ]

  function installStyles() {
    if (!isDom()) return null
    var existing = document.getElementById(STYLE_ID)
    if (existing) return existing
    var tag = document.createElement('style')
    tag.id = STYLE_ID
    tag.textContent = STYLES.join('\n')
    document.head.appendChild(tag)
    return tag
  }

  // ─── current session ──────────────────────────────────────────────────────

  function currentSessionId() {
    try {
      if (typeof localStorage === 'undefined' || localStorage === null) return ''
      var raw = localStorage.getItem(CURRENT_SESSION_KEY)
      if (typeof raw !== 'string' || raw === '') return ''
      var selection = JSON.parse(raw)
      return selection !== null && typeof selection === 'object' ? str(selection.sessionId) : ''
    } catch (error) {
      return ''
    }
  }

  // ─── rendering ────────────────────────────────────────────────────────────

  function chatColumn() {
    if (!isDom()) return null
    try { return document.querySelector('[data-chat-flow]') } catch (error) { return null }
  }

  function ensureContainer(column) {
    if (column === null) return null
    if (container !== null && containerColumn === column && container.parentNode === column) return container
    if (container !== null && container.parentNode !== null) {
      try { container.parentNode.removeChild(container) } catch (error) { /* already gone */ }
    }
    container = document.createElement('div')
    container.className = 'cch-notices'
    container.setAttribute('data-plugin', 'dsh-cc-hooks')
    column.appendChild(container)
    containerColumn = column
    return container
  }

  function scrollToTail() {
    try {
      if (document.querySelector('[data-chat-following-tail]') === null) return
      var scroll = document.querySelector('[data-conversation-scroll]')
      if (scroll !== null) scroll.scrollTop = scroll.scrollHeight
    } catch (error) { /* scrolling is best-effort */ }
  }

  function renderNotice(notice) {
    if (!isDom()) return
    try {
      var column = chatColumn()
      var host = ensureContainer(column)
      if (host === null) return
      var id = str(notice.id)
      if (id === '' || host.querySelector('[data-notice-id="' + id + '"]') !== null) return
      var row = document.createElement('div')
      row.className = 'cch-notice'
      row.setAttribute('data-notice-id', id)
      row.setAttribute('role', 'status')
      var label = document.createElement('span')
      label.className = 'cch-notice-label'
      label.textContent = 'hook'
      var text = document.createElement('span')
      text.className = 'cch-notice-text'
      text.textContent = str(notice.text)
      row.appendChild(label)
      row.appendChild(text)
      host.appendChild(row)
      scrollToTail()
    } catch (error) {
      warn('failed to render a hook notice', error)
    }
  }

  // ─── polling ──────────────────────────────────────────────────────────────

  function poll() {
    if (typeof fetch !== 'function') return
    var current = currentSessionId()
    if (current === '') return
    if (current !== sessionId) {
      // A different conversation owns a different column; drop the old one.
      sessionId = current
      container = null
      containerColumn = null
    }
    try {
      fetch(CHANNEL + '/notices?sessionId=' + encodeURIComponent(sessionId), {
        method: 'GET',
        headers: { 'x-cc-hooks': '1' },
        credentials: 'same-origin',
      }).then(function (response) {
        return response.json()
      }).then(function (result) {
        if (result === null || typeof result !== 'object' || result.ok !== true) return
        var value = result.value
        if (value === null || typeof value !== 'object' || !Array.isArray(value.notices)) return
        for (var index = 0; index < value.notices.length; index += 1) {
          var notice = value.notices[index]
          if (notice === null || typeof notice !== 'object') continue
          renderNotice(notice)
        }
      }, function () { /* a failed poll retries on the next tick */ })
    } catch (error) {
      warn('notice poll failed', error)
    }
  }

  function cleanup() {
    if (typeof globalThis !== 'undefined') globalThis[INSTANCE_KEY] = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (container !== null && container.parentNode !== null) {
      try { container.parentNode.removeChild(container) } catch (error) { /* already gone */ }
    }
    container = null
    containerColumn = null
    if (styleEl !== null && styleEl.parentNode !== null) {
      try { styleEl.parentNode.removeChild(styleEl) } catch (error) { /* already gone */ }
    }
    styleEl = null
  }

  // ─── plugin ───────────────────────────────────────────────────────────────

  function apply(ctx) {
    try {
      if (globalThis[INSTANCE_KEY] === true) return
      globalThis[INSTANCE_KEY] = true
      styleEl = installStyles()
      timer = setInterval(poll, POLL_MS)
      if (timer !== null && typeof timer.unref === 'function') timer.unref()
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () { return cleanup }, 'cc-hooks: notice lifecycle')
      }
    } catch (error) {
      /* apply() must never throw: a throw fails the fibre and the whole GUI
       * page boot. */
      warn('apply failed', error)
    }
  }

  module.exports = {
    name: 'dsh-cc-hooks-client',
    inject: [],
    apply: apply,
    /* Programmatic face for tests and other client halves. */
    poll: poll,
  }
  return module.exports
} });
