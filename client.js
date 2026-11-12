// ============================================================================
// GEO 品牌雷达 · 浏览器半边
//   - 侧栏加「GEO 品牌雷达」入口，主区域是插件页面（/geo-analyzer/，iframe）
//   - 页面发 geo-analyzer:refresh：postMessage 一段草稿，这里开新对话并填进输入框（不自动发送）
//   - 明暗跟随 dsh 主题
//
// 注意：这里**不要**自己写 window.__ModuleLoader__.load(...)——scripts/build.mjs 的
// banner 已包了一层注册，再包一次会 duplicate factory registration 让 web boot 失败。
// ============================================================================
const React = require('react')
const h = React.createElement

const PANEL = 'geo-analyzer'
const SRC = '/geo-analyzer/'

// 侧栏图标：品牌（气泡）+ 六平台环绕
function PanelIcon(props) {
  const s = (props && props.size) || 18
  return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('circle', { cx: 12, cy: 12, r: 9, strokeDasharray: '2 3' }),
    h('circle', { cx: 12, cy: 12, r: 2 }),
    h('circle', { cx: 12, cy: 4.5, r: 1.4, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 18.8, cy: 8.2, r: 1.4, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 18.8, cy: 15.8, r: 1.4, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 12, cy: 19.5, r: 1.4, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 5.2, cy: 15.8, r: 1.4, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 5.2, cy: 8.2, r: 1.4, fill: 'currentColor', stroke: 'none' }))
}

function apply(ctx) {
  const frames = new Set()
  let scheme = null
  const post = (frame) => {
    try { if (scheme && frame.contentWindow) frame.contentWindow.postMessage({ type: 'geo-analyzer:scheme', scheme }, location.origin) } catch {}
  }
  ctx.inject(['theme'], (c) => {
    const push = (snap) => { scheme = snap.active.colorScheme; frames.forEach(post) }
    try { push(c.theme.getTheme()) } catch {}
    c.on('theme/change', push)
  })

  function GeoPanel() {
    const ref = React.useRef(null)
    React.useEffect(() => {
      const self = ref.current
      if (self) frames.add(self)
      function onMessage(e) {
        const frame = ref.current
        if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return
        const m = e.data
        if (!m || m.type !== 'geo-analyzer:refresh' || typeof m.prompt !== 'string') return
        try {
          ctx.uiWorkspace.startSession(undefined, { prompt: m.prompt, whenDraftExists: 'replace' })
          try { frame.contentWindow.postMessage({ type: 'geo-analyzer:start-ok' }, location.origin) } catch {}
        } catch (err) {
          console.error('[geo-analyzer] 开新对话失败', err)
          try { frame.contentWindow.postMessage({ type: 'geo-analyzer:start-failed', message: String((err && err.message) || err) }, location.origin) } catch {}
        }
      }
      addEventListener('message', onMessage)
      return () => { removeEventListener('message', onMessage); frames.delete(self) }
    }, [])
    return h('iframe', {
      ref,
      src: SRC,
      title: 'GEO 品牌雷达',
      allow: 'fullscreen',
      onLoad: (e) => post(e.currentTarget),
      style: { width: '100%', height: '100%', border: 0, display: 'block' },
    })
  }

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 15, label: () => 'GEO 品牌雷达' }, PanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, GeoPanel))
}

exports.isPlugin = true
exports.inject = ['slots', 'uiWorkspace']
exports.apply = apply
