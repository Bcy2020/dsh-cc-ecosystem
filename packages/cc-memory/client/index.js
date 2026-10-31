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
