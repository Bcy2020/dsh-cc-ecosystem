window.__ModuleLoader__.load({ id: "dsh-cc-memory", factory: (require) => {
  'use strict'
  var module = { exports: {} }; var exports = module.exports;

  // dsh-cc-memory — browser half (the `/cc-memory` switch panel).
  //
  // Plain DOM, no imports, no require, no build step, no top-level await: this
  // file is a CLASSIC script that several bundles get concatenated into, so the
  // single top-level statement above is this whole file and every declaration
  // lives inside the factory.
  //
  // Transport: same-origin POSTs to the plugin's own host route (`/cc-memory/*`,
  // registered by the host half on the `webServer` service). There is no
  // host→browser push, so the panel pulls `state` when it opens and after every
  // mutation.
  //
  // Two switches:
  //   启用 Memory      off → DSH sees no auto-memory at all (no prompt, no tools)
  //   允许写入          off = read-only (list/read only); on = read-write
  // The second switch is disabled while the first is off.

  var PLUGIN_ID = 'dsh-cc-memory'
  var CHANNEL = '/cc-memory'
  var STYLE_TAG_ID = 'dsh-cc-memory/panel.css'

  // ─── module state (cleared by the matching disposer) ──────────────────────

  var styleEl = null
  var overlayRoot = null
  var panel = null

  // ─── helpers ──────────────────────────────────────────────────────────────

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

  function failure(code, message) {
    return { ok: false, error: { code: code, message: message, details: {} } }
  }

  /**
   * One panel call to the host route. Never throws and never rejects: a missing
   * transport, a failed request, or a malformed envelope all become the same
   * `{ ok:false, error }` shape the panel renders inline.
   */
  function api(endpoint, payload) {
    try {
      if (typeof fetch !== 'function') {
        return Promise.resolve(failure('cc-memory/no-transport', 'fetch is unavailable in this shell'))
      }
      return fetch(CHANNEL + '/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cc-memory': '1' },
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
                  code: str(result.error.code, 'cc-memory/internal'),
                  message: str(result.error.message, 'cc-memory request failed'),
                  details: isRecord(result.error.details) ? result.error.details : {},
                },
              }
            }
            return failure('cc-memory/envelope', 'malformed result envelope from ' + endpoint)
          })
        },
        function (error) {
          return failure('cc-memory/transport', String((error && error.message) || error))
        },
      )
    } catch (error) {
      return Promise.resolve(failure('cc-memory/transport', String((error && error.message) || error)))
    }
  }

  function messageOf(response, fallback) {
    var message = response && response.error && response.error.message
    return str(message, fallback || 'request failed')
  }

  // ─── styles ───────────────────────────────────────────────────────────────

  var STYLES = [
    '.ccmem-overlay{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:none}',
    '.ccmem-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgb(0 0 0 / 24%));pointer-events:auto}',
    '.ccmem-panel{position:relative;pointer-events:auto;width:520px;max-width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 10%));box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgb(0 0 0 / 18%));font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;line-height:20px}',
    '.ccmem-head{display:flex;align-items:flex-start;gap:12px;padding:16px 16px 12px;flex:0 0 auto}',
    '.ccmem-head-main{flex:1 1 auto;min-width:0}',
    '.ccmem-title{margin:0;font-size:15px;line-height:22px;font-weight:600}',
    '.ccmem-subtitle{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmem-iconbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1;flex:0 0 auto}',
    '.ccmem-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72 / 6%));color:var(--dsw-alias-label-primary,#0f1115)}',
    '.ccmem-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 16px 16px}',
    '.ccmem-row{display:flex;align-items:flex-start;gap:14px;padding:14px 0;border-top:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 8%))}',
    '.ccmem-row:first-child{border-top:0}',
    '.ccmem-row-main{flex:1 1 auto;min-width:0}',
    '.ccmem-row-title{font-weight:600}',
    '.ccmem-row-desc{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmem-row-disabled{opacity:.45}',
    '.ccmem-switch{appearance:none;flex:0 0 auto;position:relative;width:44px;height:24px;margin:0;border:0;border-radius:999px;cursor:pointer;background:var(--dsw-alias-bg-module-platform,rgb(0 0 0 / 16%));transition:background .15s ease}',
    '.ccmem-switch[aria-checked="true"]{background:var(--dsw-alias-state-success-primary,#12b76a)}',
    '.ccmem-switch:disabled{cursor:default;opacity:.55}',
    '.ccmem-switch:focus-visible{outline:2px solid var(--dsw-alias-border-accent,#4c7dff);outline-offset:2px}',
    '.ccmem-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / 25%);transition:transform .15s ease}',
    '.ccmem-switch[aria-checked="true"] .ccmem-knob{transform:translateX(20px)}',
    '.ccmem-status{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgb(0 0 0 / 8%));font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.ccmem-status-row{display:flex;gap:8px;padding:1px 0}',
    '.ccmem-status-key{flex:0 0 72px;color:var(--dsw-alias-label-tertiary,#8a9097)}',
    '.ccmem-status-val{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.ccmem-tools{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px}',
    '.ccmem-error{margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 10%, transparent);color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.ccmem-warn{margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;background:color-mix(in srgb, var(--dsw-alias-state-warning-primary,#d97706) 12%, transparent);color:var(--dsw-alias-state-warning-primary,#d97706)}',
    '.ccmem-loading{display:flex;align-items:center;gap:8px;padding:18px 0;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px}',
    '.ccmem-spinner{display:inline-block;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2,rgb(0 0 0 / 10%));border-top-color:var(--dsw-alias-label-secondary,#61666b);animation:ccmem-spin .7s linear infinite}',
    '@keyframes ccmem-spin{to{transform:rotate(360deg)}}',
    '.ccmem-foot{margin-top:12px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a9097)}',
  ]

  function installStyles() {
    if (!isDom()) return null
    if (document.getElementById(STYLE_TAG_ID)) return document.getElementById(STYLE_TAG_ID)
    var tag = document.createElement('style')
    tag.id = STYLE_TAG_ID
    tag.textContent = STYLES.join('\n')
    document.head.appendChild(tag)
    return tag
  }

  // ─── panel state ──────────────────────────────────────────────────────────

  function closePanel() {
    try {
      if (panel && panel.escape) {
        document.removeEventListener('keydown', panel.escape, true)
        panel.escape = null
      }
      if (overlayRoot && overlayRoot.parentNode) overlayRoot.parentNode.removeChild(overlayRoot)
    } catch (error) {
      warn('panel close failed', error)
    }
    overlayRoot = null
    panel = null
  }

  function openPanel(sessionId) {
    if (!isDom()) return
    try {
      closePanel()
      panel = {
        sessionId: str(sessionId),
        snapshot: null,
        error: '',
        busy: false,
        escape: null,
        body: null,
      }
      var current = panel

      var overlay = el('div', 'ccmem-overlay')
      overlay.setAttribute('data-plugin', PLUGIN_ID)
      var backdrop = el('div', 'ccmem-backdrop')
      backdrop.setAttribute('data-role', 'backdrop')
      backdrop.addEventListener('click', function () { if (panel === current) closePanel() })
      overlay.appendChild(backdrop)

      var card = el('div', 'ccmem-panel')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-label', 'Claude Code Memory')

      var head = el('div', 'ccmem-head')
      var headMain = el('div', 'ccmem-head-main')
      headMain.appendChild(el('h2', 'ccmem-title', 'Claude Code Memory'))
      headMain.appendChild(el('p', 'ccmem-subtitle', 'DSH 里的 auto-memory 开关'))
      head.appendChild(headMain)
      var close = el('button', 'ccmem-iconbtn', '✕')
      close.type = 'button'
      close.setAttribute('data-role', 'close')
      close.setAttribute('aria-label', '关闭')
      close.addEventListener('click', function () { if (panel === current) closePanel() })
      head.appendChild(close)

      var body = el('div', 'ccmem-body')
      card.appendChild(head)
      card.appendChild(body)
      overlay.appendChild(card)
      document.body.appendChild(overlay)

      overlayRoot = overlay
      current.body = body

      current.escape = function (event) {
        if (event && event.key === 'Escape' && panel === current) {
          event.stopPropagation()
          closePanel()
        }
      }
      document.addEventListener('keydown', current.escape, true)

      render()
      refresh()
    } catch (error) {
      warn('panel open failed', error)
      closePanel()
    }
  }

  function refresh() {
    var current = panel
    if (!current) return
    api('state', { sessionId: current.sessionId }).then(function (response) {
      if (panel !== current) return
      if (response.ok) {
        current.snapshot = isRecord(response.value) ? response.value : null
        current.error = ''
      } else {
        current.error = messageOf(response, '无法读取开关状态')
      }
      render()
    })
  }

  function setSwitch(patch) {
    var current = panel
    if (!current || current.busy || !isRecord(current.snapshot)) return
    current.busy = true
    current.error = ''
    render()
    var payload = { sessionId: current.sessionId }
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) payload.enabled = patch.enabled
    if (Object.prototype.hasOwnProperty.call(patch, 'mode')) payload.mode = patch.mode
    api('set', payload).then(function (response) {
      if (panel !== current) return
      current.busy = false
      if (response.ok && isRecord(response.value)) {
        current.snapshot = response.value
        current.error = ''
      } else {
        current.error = messageOf(response, '切换失败')
      }
      render()
    })
  }

  function render() {
    var current = panel
    if (!current || !current.body) return
    var body = current.body
    clear(body)

    if (current.error) body.appendChild(el('p', 'ccmem-error', current.error))

    var snapshot = current.snapshot
    if (!isRecord(snapshot)) {
      var loading = el('div', 'ccmem-loading')
      loading.appendChild(el('span', 'ccmem-spinner'))
      loading.appendChild(el('span', '', current.error ? '' : '正在读取状态…'))
      body.appendChild(loading)
      return
    }

    var enabled = snapshot.enabled === true
    var writable = snapshot.mode === 'read-write'

    body.appendChild(switchRow({
      title: '启用 Memory',
      description: '关闭后 DSH 完全看不到 auto-memory:没有系统提示段,也没有任何记忆工具。',
      checked: enabled,
      disabled: current.busy,
      onToggle: function () { setSwitch({ enabled: !enabled }) },
    }))

    body.appendChild(switchRow({
      title: '允许写入',
      description: writable
        ? '可写:DSH 能新增记忆,也能修改已有记忆与 MEMORY.md 索引。'
        : '只读:DSH 只能列出与读取记忆,不会写入。',
      checked: writable,
      disabled: current.busy || !enabled,
      onToggle: function () { setSwitch({ mode: writable ? 'read-only' : 'read-write' }) },
    }))

    var status = el('div', 'ccmem-status')
    if (snapshot.stateError) body.appendChild(el('p', 'ccmem-warn', '状态文件: ' + str(snapshot.stateError)))
    if (snapshot.routeError) body.appendChild(el('p', 'ccmem-warn', '面板路由不可用: ' + str(snapshot.routeError)))

    statusRow(status, '状态', enabled ? (writable ? '已启用 · 可写' : '已启用 · 只读') : '已关闭')
    statusRow(status, '来源', snapshot.stateSource === 'file' ? '状态文件' : 'Config 默认值')
    statusRow(status, '文件', str(snapshot.statePath, '—'))
    statusRow(status, '记忆目录', str(snapshot.memoryDirectory, '当前会话没有 cwd,无法解析'))
    statusRow(status, '工具', Array.isArray(snapshot.tools) && snapshot.tools.length > 0
      ? snapshot.tools.join(', ')
      : '（无）', 'ccmem-tools')
    body.appendChild(status)

    body.appendChild(el('p', 'ccmem-foot', '改动立即生效,无需重启 DSH。开关会写入状态文件,下次启动继续生效。'))
  }

  function switchRow(options) {
    var row = el('div', 'ccmem-row' + (options.disabled ? ' ccmem-row-disabled' : ''))
    var main = el('div', 'ccmem-row-main')
    main.appendChild(el('div', 'ccmem-row-title', options.title))
    main.appendChild(el('p', 'ccmem-row-desc', options.description))
    row.appendChild(main)

    var button = el('button', 'ccmem-switch')
    button.type = 'button'
    button.setAttribute('role', 'switch')
    button.setAttribute('aria-checked', options.checked ? 'true' : 'false')
    button.setAttribute('aria-label', options.title)
    button.disabled = options.disabled === true
    button.appendChild(el('span', 'ccmem-knob'))
    button.addEventListener('click', function () {
      if (!button.disabled) options.onToggle()
    })
    row.appendChild(button)
    return row
  }

  function statusRow(parent, key, value, valueClass) {
    var row = el('div', 'ccmem-status-row')
    row.appendChild(el('span', 'ccmem-status-key', key))
    row.appendChild(el('span', 'ccmem-status-val' + (valueClass ? ' ' + valueClass : ''), value))
    parent.appendChild(row)
  }

  // ─── command registration ─────────────────────────────────────────────────

  function injectCommand(ctx) {
    if (!ctx || typeof ctx.inject !== 'function') return
    ctx.inject(['commandUi'], function (scope) {
      try {
        var commandUi = scope.commandUi
        if (!commandUi || typeof commandUi.register !== 'function') return
        scope.effect(function () {
          return commandUi.register({
            name: 'cc-memory',
            description: function () { return '打开 Claude Code Memory 的开关面板' },
            available: function () { return true },
            ui: {
              kind: 'action',
              run: function (session) {
                try {
                  openPanel(session && session.sessionId)
                } catch (error) {
                  warn('/cc-memory panel failed', error)
                }
              },
            },
          })
        }, 'cc-memory: /cc-memory')
      } catch (error) {
        warn('/cc-memory registration failed', error)
      }
    })
  }

  // ─── plugin ───────────────────────────────────────────────────────────────

  function apply(ctx) {
    try {
      styleEl = installStyles()
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            try { closePanel() } catch (error) { warn('panel teardown failed', error) }
            if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
            styleEl = null
          }
        }, 'cc-memory: panel lifecycle')
      }
      injectCommand(ctx)
    } catch (error) {
      /* apply() must never throw: a throw fails the fibre and the whole GUI
       * page boot. */
      warn('apply failed', error)
    }
  }

  module.exports = {
    name: 'dsh-cc-memory-client',
    inject: [],
    apply: apply,
    /* Programmatic face of the same transport the panel uses; every call
     * resolves to a result envelope and never throws. */
    api: api,
  }
  return module.exports
} });
