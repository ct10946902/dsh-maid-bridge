/**
 * dsh-maid-bridge — 客户端半边（设置页）
 * ============================================================================
 * 在 DSH 的设置面板里注册一个「车万女仆桥」分区（和「bili 设置」「主动唤醒」
 * 一样的位置），内容是：密钥设置、会话白名单、站点 URL 提示、运行状态。
 *
 * React 只负责渲染一个空容器（座位），面板内容全在纯 DOM 里，拿不到 React
 * 就安静降级。
 * ============================================================================
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-maid-bridge',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      let React = null
      try {
        const seed = require('react')
        React = seed && seed.default ? seed.default : seed
      } catch {
        React = null
      }

      const PLUGIN_ID = 'dsh-maid-bridge'
      const SECTION_SLOT = 'settings.section'
      const SECTION_ID = 'maid-bridge-settings'
      const STYLE_ID = 'dsh-maid-bridge-style'
      const STATE_PATHS = ['api/maid-bridge/state.json', 'maid-bridge/state.json']
      const SAVE_PATHS = ['api/maid-bridge/save', 'maid-bridge/save']
      const POLL_MS = 8000

      const CSS = `
        .dsmb-root{font-size:13px;color:#333;padding:0 0 24px}
        .dsmb-head{margin:0 0 4px;font-size:15px;font-weight:600}
        .dsmb-sub{color:#888;margin:0 0 14px;line-height:1.6}
        .dsmb-card{border:1px solid #e5e5e5;border-radius:12px;padding:14px 16px;margin:0 0 14px;background:#fff}
        .dsmb-card h4{margin:0 0 10px;font-size:13px;font-weight:600;color:#444}
        .dsmb-row{display:flex;gap:8px;align-items:center;margin:8px 0}
        .dsmb-row>span{flex:0 0 72px;color:#888}
        .dsmb-row input[type=text]{flex:1;min-width:0;height:30px;border:1px solid #ddd;border-radius:8px;
          padding:0 10px;font-size:13px;background:#fff;color:#333}
        .dsmb-row button{height:30px;border:1px solid #ddd;background:#fafafa;border-radius:8px;cursor:pointer;
          font-size:13px;padding:0 14px;white-space:nowrap}
        .dsmb-row button:hover{background:#f0f0f0}
        .dsmb-row button.dsmb-primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
        .dsmb-row button.dsmb-primary:hover{background:#1a5fd0}
        .dsmb-list{max-height:180px;overflow:auto;border:1px solid #eee;border-radius:10px;padding:6px 8px;margin:6px 0}
        .dsmb-item{display:flex;gap:8px;align-items:center;padding:3px 0;line-height:1.5}
        .dsmb-item input{flex:0 0 auto;margin:0}
        .dsmb-item label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          cursor:pointer;color:#444}
        .dsmb-status{display:flex;gap:14px;flex-wrap:wrap;color:#666;line-height:1.8}
        .dsmb-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:#bbb}
        .dsmb-dot.on{background:#39b54a}
        .dsmb-dot.busy{background:#e6a23c}
        .dsmb-hint{color:#999;margin-top:10px;line-height:1.7}
        .dsmb-code{background:#f6f8fa;border:1px solid #eee;border-radius:6px;padding:1px 6px;
          font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#333}
      `

      let statePathIndex = 0
      let savePathIndex = 0

      async function fetchState() {
        for (let i = 0; i < STATE_PATHS.length; i += 1) {
          const p = STATE_PATHS[(statePathIndex + i) % STATE_PATHS.length]
          try {
            const res = await fetch(p, { cache: 'no-store' })
            if (!res.ok) continue
            const data = await res.json()
            statePathIndex = (statePathIndex + i) % STATE_PATHS.length
            return data
          } catch {
            /* 试下一条 */
          }
        }
        return null
      }

      async function save(patch) {
        for (let i = 0; i < SAVE_PATHS.length; i += 1) {
          const p = SAVE_PATHS[(savePathIndex + i) % SAVE_PATHS.length]
          try {
            const res = await fetch(p, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            })
            if (res.ok) {
              const data = await res.json()
              if (data && data.ok) {
                savePathIndex = (savePathIndex + i) % SAVE_PATHS.length
                return data.state ?? true
              }
            }
          } catch {
            /* 试下一条 */
          }
        }
        return null
      }

      function ensureStyle() {
        if (typeof document === 'undefined') return
        if (document.getElementById(STYLE_ID)) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      }

      function baseUrl() {
        // 固定端口（插件自己监听），不随 DSH 重启换端口；真实值以 state.endpoint 为准
        return 'http://127.0.0.1:8788/v1'
      }

      function h(tag, props, ...children) {
        const el = document.createElement(tag)
        if (props) {
          for (const [key, value] of Object.entries(props)) {
            if (key === 'text') el.textContent = value
            else if (key === 'onClick') el.onclick = value
            else if (key === 'className') el.className = value
            else if (key === 'type') el.type = value
            else if (key === 'checked') el.checked = value
            else if (key === 'placeholder') el.placeholder = value
            else if (key === 'title') el.title = value
            else el.setAttribute(key, value)
          }
        }
        for (const child of children) {
          if (child === null || child === undefined) continue
          if (typeof child === 'string') el.appendChild(document.createTextNode(child))
          else el.appendChild(child)
        }
        return el
      }

      function mountPanel(container) {
        if (!container || typeof document === 'undefined') return () => {}
        container.innerHTML = ''
        ensureStyle()

        const root = h('div', { className: 'dsmb-root' })
        container.appendChild(root)

        root.appendChild(h('h3', { className: 'dsmb-head', text: '车万女仆桥' }))
        root.appendChild(
          h('p', {
            className: 'dsmb-sub',
            text: 'Minecraft 车万女仆 mod ↔ DSH 会话的本地接口。只走本机 127.0.0.1，必须配置密钥；可选会话白名单。',
          }),
        )

        // 状态卡
        const statusCard = h('div', { className: 'dsmb-card' })
        statusCard.appendChild(h('h4', { text: '运行状态' }))
        const statusLine = h('div', { className: 'dsmb-status' })
        statusCard.appendChild(statusLine)
        root.appendChild(statusCard)

        // 密钥卡
        const keyCard = h('div', { className: 'dsmb-card' })
        keyCard.appendChild(h('h4', { text: '密钥' }))
        const keyRow = h('div', { className: 'dsmb-row' })
        keyRow.appendChild(h('span', { text: 'Secret Key' }))
        const keyInput = h('input', { type: 'text', placeholder: '与游戏站点配置里的一致' })
        keyRow.appendChild(keyInput)
        keyCard.appendChild(keyRow)
        const keyHint = h('div', {
          className: 'dsmb-hint',
          text: '车万女仆站点里的 Secret Key 必须和这里完全一致；没设密钥时接口整体关闭。',
        })
        keyCard.appendChild(keyHint)
        const keyButtons = h('div', { className: 'dsmb-row' })
        const saveKeyBtn = h('button', { className: 'dsmb-primary', text: '保存密钥', onClick: async () => {
          const value = keyInput.value.trim()
          if (value === '') {
            keyHint.textContent = '密钥不能为空'
            return
          }
          const next = await save({ secretKey: value })
          keyHint.textContent = next ? '密钥已保存 ✓' : '保存失败（看宿主日志）'
          keyInput.value = ''
          refresh()
        } })
        keyButtons.appendChild(h('button', { text: '清空输入', onClick: () => { keyInput.value = '' } }))
        keyButtons.appendChild(saveKeyBtn)
        keyCard.appendChild(keyButtons)
        root.appendChild(keyCard)

        // 白名单卡
        const wlCard = h('div', { className: 'dsmb-card' })
        wlCard.appendChild(h('h4', { text: '会话白名单' }))
        wlCard.appendChild(
          h('div', {
            className: 'dsmb-hint',
            text: '不勾选 = 全部非归档会话可用；勾选后只放行勾中的会话。只接最后一条 user 消息，回复会带【车万女仆】前缀进会话。',
          }),
        )
        const list = h('div', { className: 'dsmb-list' })
        wlCard.appendChild(list)
        const wlButtons = h('div', { className: 'dsmb-row' })
        const saveWlBtn = h('button', { className: 'dsmb-primary', text: '保存白名单' })
        const clearWlBtn = h('button', { text: '清空（全部会话）' })
        wlButtons.appendChild(saveWlBtn)
        wlButtons.appendChild(clearWlBtn)
        wlCard.appendChild(wlButtons)
        root.appendChild(wlCard)

        // 站点配置卡
        const siteCard = h('div', { className: 'dsmb-card' })
        siteCard.appendChild(h('h4', { text: '车万女仆站点配置' }))
        const urlRow = h('div', { className: 'dsmb-row' })
        urlRow.appendChild(h('span', { text: 'URL' }))
        const urlCode = h('code', { className: 'dsmb-code', text: baseUrl() })
        urlRow.appendChild(urlCode)
        siteCard.appendChild(urlRow)
        siteCard.appendChild(
          h('div', {
            className: 'dsmb-hint',
            text: '站点类型选 OpenAI，密钥填上面保存的那个，模型下拉框里选一个会话 id。游戏里女仆说的话会进入那个会话，我回复后送回游戏。',
          }),
        )
        root.appendChild(siteCard)

        let checked = new Set()

        function renderStatus(state) {
          statusLine.innerHTML = ''
          const on = state.secretConfigured
          statusLine.appendChild(
            h(
              'span',
              null,
              h('i', { className: 'dsmb-dot' + (on ? ' on' : '') }),
              on ? '密钥已设置' : '密钥未设置（接口关闭）',
            ),
          )
          statusLine.appendChild(
            h(
              'span',
              null,
              h('i', { className: 'dsmb-dot' + (state.running ? ' busy' : '') }),
              state.running ? '正在回话' : '空闲',
            ),
          )
          statusLine.appendChild(h('span', { text: '请求 ' + (state.requestCount ?? 0) + ' 次' }))
          statusLine.appendChild(h('span', { text: '超时 ' + Math.round((state.timeoutMs ?? 0) / 1000) + ' 秒' }))
        }

        function renderList(state) {
          list.innerHTML = ''
          const sessions = Array.isArray(state.sessions) ? state.sessions : []
          checked = new Set(Array.isArray(state.sessionWhitelist) ? state.sessionWhitelist : [])
          for (const session of sessions) {
            const item = h('div', { className: 'dsmb-item' })
            const box = h('input', { type: 'checkbox', checked: checked.has(session.id) })
            box.onchange = () => {
              if (box.checked) checked.add(session.id)
              else checked.delete(session.id)
            }
            const label = h('label', { text: (session.title || '（无标题）') + ' · ' + session.id, title: session.id })
            label.onclick = () => {
              box.checked = !box.checked
              box.onchange()
            }
            item.appendChild(box)
            item.appendChild(label)
            list.appendChild(item)
          }
          if (sessions.length === 0) {
            list.appendChild(h('div', { className: 'dsmb-hint', text: '没有可用会话' }))
          }
        }

        async function refresh() {
          const state = await fetchState()
          if (!state) {
            statusLine.textContent = '接口没响应（插件没挂上？）'
            return
          }
          renderStatus(state)
          renderList(state)
          if (typeof state.endpoint === 'string' && state.endpoint !== '') {
            urlCode.textContent = state.endpoint
          }
        }

        saveWlBtn.onclick = async () => {
          const next = await save({ sessionWhitelist: Array.from(checked) })
          if (next) refresh()
          else statusLine.textContent = '保存失败'
        }
        clearWlBtn.onclick = async () => {
          const next = await save({ sessionWhitelist: [] })
          if (next) {
            checked = new Set()
            refresh()
          } else statusLine.textContent = '保存失败'
        }

        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }

      function Section(props) {
        if (!React || typeof React.createElement !== 'function') return null
        const ref = React.useRef ? React.useRef(null) : null
        const hostRef = ref || { current: null }
        React.useEffect?.(() => {
          if (!hostRef.current) return undefined
          return mountPanel(hostRef.current)
        }, [])
        return React.createElement('div', { ref: (node) => { hostRef.current = node } })
      }

      function apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
        try {
          ctx.slots.inject(SECTION_SLOT, () =>
            ctx.slots.register(
              {
                name: SECTION_SLOT,
                id: SECTION_ID,
                order: 130,
                label: () => '车万女仆桥',
              },
              Section,
            ),
          )
        } catch (error) {
          try {
            console.warn('[dsh-maid-bridge] settings.section 注册失败：' + (error && error.message ? error.message : error))
          } catch {
            /* 忽略 */
          }
        }
      }

      exports.name = PLUGIN_ID
      exports.apply = apply
      exports.inject = ['slots']
      return module.exports
    },
  })
}
