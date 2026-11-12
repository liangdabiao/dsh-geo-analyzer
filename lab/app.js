// GEO 品牌雷达 · 面板逻辑：概览 / 新建分析 / 运行详情（问题→搜索进度→报告摘要）/ 设置。
// 情绪与排名分析走 agent 对话：嵌入 dsh → postMessage（client.js startSession，有 start-ok 握手）；
// 独立浏览器预览 → 复制草稿。面板直连 API 做建运行/改问题/启动搜索/看进度与摘要。
(() => {
  const $app = document.getElementById('app')
  const $toast = document.getElementById('toast')
  const EMBEDDED = (() => { try { return window.parent !== window } catch { return false } })()

  const state = { catalog: null, pollTimer: null }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  async function api(path) {
    const res = await fetch(`/geo-analyzer${path}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return body
  }
  async function apiPost(path, payload) {
    const res = await fetch(`/geo-analyzer${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }
  async function apiDelete(path) {
    const res = await fetch(`/geo-analyzer${path}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }

  let toastTimer = null
  function toast(msg, isErr) {
    $toast.textContent = msg
    $toast.className = `toast show${isErr ? ' err' : ''}`
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { $toast.className = 'toast' }, 2600)
  }
  function copyFallback(prompt, reason) {
    navigator.clipboard?.writeText(prompt).then(
      () => toast(`${reason}，草稿已复制到剪贴板——请粘贴到 dsh 对话`, true),
      () => toast(`${reason}，复制也失败了`, true))
  }

  const ICONS = {
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    go: '<path d="M9 6l6 6-6 6"/>',
    trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    ext: '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v5H5V6h5"/>',
    back: '<path d="M14 6l-6 6 6 6"/>',
    play: '<path d="M8 5l11 7-11 7V5z"/>',
  }
  const ic = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`

  const STATUS_LABEL = { created: '待出问题', searching: '搜索中', searched: '待分析', analyzed: '待出报告', done: '已完成' }
  const CELL_LABEL = { completed: 'OK', invalid: 'INVALID', pending: '…', failed: 'FAIL', timeout: 'FAIL', submit_failed: 'FAIL', missing: '—', searching: '…' }
  const CELL_CLASS = { completed: 'done', invalid: 'inv', pending: 'run', failed: 'fail', timeout: 'fail', submit_failed: 'fail', missing: 'wait' }
  const PLAT_COLOR = { doubao: '#2563eb', kimi: '#7c3aed', deepseek: '#0891b2', yuanbao: '#e11d48', qianwen: '#ea580c', baidu: '#16a34a' }

  async function loadCatalog() {
    state.catalog = await api('/api/catalog')
    renderNavCounts()
    renderRailFoot()
    return state.catalog
  }
  function renderNavCounts() {
    const c = state.catalog
    if (!c) return
    document.querySelectorAll('[data-count]').forEach((n) => {
      if (n.dataset.count === 'runs') n.textContent = (c.runs || []).length
    })
  }
  function renderRailFoot() {
    const c = state.catalog
    if (!c) return
    const latest = (c.runs || [])[0]
    document.getElementById('rail-foot').innerHTML =
      `<div class="v-head">GEO RADAR v${esc(c.version)}</div>` +
      `<div class="v-row"><span>API Key</span><span>${c.has_key ? '已配置' : '未配置'}</span></div>` +
      `<div class="v-row"><span>运行数</span><span>${(c.runs || []).length}</span></div>` +
      `<div class="v-row"><span>最新品牌</span><span>${esc(latest?.brand || '—')}</span></div>`
  }

  // ---------- 送 prompt 到 agent 对话 ----------
  function sendAgentPrompt(prompt, okMsg = '已在宿主开新对话——agent 处理中') {
    if (!EMBEDDED) {
      navigator.clipboard?.writeText(prompt).then(
        () => toast('草稿已复制——粘贴到 dsh 对话即可开始'),
        () => copyFallback(prompt, '复制失败'))
      return
    }
    let done = false
    const cleanup = () => { done = true; clearTimeout(timer); removeEventListener('message', onMsg) }
    const onMsg = (e) => {
      if (e.origin !== location.origin) return
      if (e.data?.type === 'geo-analyzer:start-ok') { if (!done) { cleanup(); toast(okMsg) } }
      else if (e.data?.type === 'geo-analyzer:start-failed') { if (!done) { cleanup(); toast(`没能开新对话：${e.data.message || ''}`, true) } }
    }
    const timer = setTimeout(() => { if (!done) { cleanup(); copyFallback(prompt, '未收到宿主确认') } }, 1500)
    addEventListener('message', onMsg)
    parent.postMessage({ type: 'geo-analyzer:refresh', prompt }, location.origin)
  }

  function fullFlowPrompt(run) {
    const alias = (run.aliases || []).join('、')
    const comps = (run.competitors || []).join('、')
    return [
      `请继续 GEO 品牌分析（运行 ${run.run_id}，品牌「${run.brand}」，品类「${run.category || '—'}」${alias ? `，别名 ${alias}` : ''}${comps ? `，竞品 ${comps}` : ''}）：`,
      run.queries?.length
        ? `1. 问题列表已有 ${run.queries.length} 个（如需调整先跟我确认）→ geo_analyzer(action="search", runId="${run.run_id}") 启动六平台搜索`
        : '1. 生成 5 个问题（推荐类≥1，多场景+功能类合计≥4，一律不带品牌名）给我确认，确认后 queries_save 保存并 search 启动搜索',
      '2. 搜索 3-5 分钟：等 30-60 秒再 status 查进度，不要空转',
      '3. 完成后 read_answers 读回答，按 geo-analyzer 技能逐条分析情绪/排名/竞品（同一回答内排名不得重复），ai_save 分批存档',
      '4. 全部覆盖后 report 生成 HTML 报告，把关键发现 5 条结论完整输出给我。',
    ].join('\n')
  }

  function newFlowPrompt(fill) {
    const line = (v) => v || '（请先问我）'
    return [
      '请帮我做一次品牌 GEO 分析（六大 AI 搜索引擎可见度）：',
      `品牌：${line(fill.brand)}｜品类：${line(fill.category)}${fill.aliases ? `｜别名：${fill.aliases}` : ''}${fill.competitors ? `｜竞品：${fill.competitors}` : ''}`,
      '1. geo_analyzer(action="create", brand=…, category=…) 创建运行（缺品类先问我）',
      '2. 生成 5 个问题（推荐类≥1，多场景+功能类合计≥4，不带品牌名）给我确认',
      '3. 确认后 queries_save → search（后台 3-5 分钟）→ read_answers → 按 geo-analyzer 技能分析 → ai_save → report',
      '4. 最后把关键发现 5 条结论完整输出给我。',
    ].join('\n')
  }

  // ---------- 视图：概览 ----------
  function viewHome() {
    const c = state.catalog
    const runs = c.runs || []
    const searching = c.searching
    const doneRuns = runs.filter((r) => r.has_report)
    const latestDone = doneRuns[0]
    return `
      <header class="head">
        <span class="eyebrow">GEO BRAND RADAR</span>
        <div class="head-row">
          <h1>GEO 品牌<strong>雷达</strong></h1>
          <div class="actions"><button class="btn accent" data-newflow>${ic('spark')}开始一次分析</button></div>
        </div>
        <p>向豆包 / Kimi / DeepSeek / 元宝 / 千问 / 百度 六大 AI 搜索提出相同问题，分析品牌提及率、排名、情绪、信源与竞品。需要 RedFox API Key（${c.has_key ? '已配置' : '未配置——去「设置」页填写'}）。</p>
      </header>
      ${!c.has_key ? `<div class="empty" style="margin-bottom:var(--sp-6);padding:var(--sp-4) var(--sp-5);text-align:left"><div class="e-title">🔑 还没有配置 RedFox API Key</div><p>到<a href="#/settings">「设置」</a>页填写（ak_ 开头，<a href="https://redfox.hk/settings/api-keys?source=github" target="_blank" rel="noreferrer">红狐 hub 获取 ↗</a>），或在插件配置 / 环境变量 REDFOX_API_KEY 里配置。搜索前必须配置。</p></div>` : ''}
      <div class="stats">
        <div class="stat"><div class="mono">RUNS</div><div class="val">${runs.length}</div><div class="sub">分析运行</div></div>
        <div class="stat"><div class="mono">SEARCHING</div><div class="val" style="color:${searching ? 'var(--warn)' : 'inherit'}">${searching ? 'YES' : 'NO'}</div><div class="sub">${searching ? esc((runs.find((r) => r.run_id === searching) || {}).brand || '') : '当前无进行中搜索'}</div></div>
        <div class="stat"><div class="mono">REPORTS</div><div class="val">${doneRuns.length}</div><div class="sub">已生成 HTML 报告</div></div>
        <div class="stat"><div class="mono">KEY</div><div class="val" style="color:${c.has_key ? 'var(--ok)' : 'var(--miss)'}">${c.has_key ? 'OK' : 'MISSING'}</div><div class="sub">${esc(c.key_source === 'settings' ? '面板设置' : c.key_source === 'env' ? '环境变量' : '未配置')}</div></div>
      </div>
      <section class="sec">
        <div class="sec-head"><span class="num">01</span><h2>分析运行</h2><a class="more" href="#/new">+ 新建分析</a></div>
        ${runs.length ? `<div class="cards">${runs.map((r) => `
          <a class="card" href="#/run/${encodeURIComponent(r.run_id)}">
            <div class="c-top">
              <div class="c-title">${esc(r.brand)}<span class="c-sub"> · ${esc(r.category || '—')}</span></div>
              <span class="chip ${esc(r.status)}">${STATUS_LABEL[r.status] || esc(r.status)}</span>
            </div>
            <div class="c-sub">问题 ${r.queries.length} × 平台 ${(r.platforms || []).length} = ${(r.queries.length || 0) * (r.platforms || []).length} 任务${r.counts ? ` · 完成 ${r.counts.completed}/无效 ${r.counts.invalid}/失败 ${r.counts.failed}` : ''}</div>
            <div class="c-foot"><span>${esc(String(r.created_at).slice(0, 16).replace('T', ' '))}</span>${r.has_report ? `<span style="margin-left:auto;color:var(--accent)">有报告 ↗</span>` : ''}</div>
          </a>`).join('')}</div>`
        : `<div class="empty"><div class="e-title">还没有分析运行</div><p>点「新建分析」填品牌和品类，或点右上「开始一次分析」让 agent 带你走完全流程（追问品类 → 生成问题 → 确认 → 六平台搜索 → 情绪分析 → 报告）。</p></div>`}
      </section>
      <section class="sec">
        <div class="sec-head"><span class="num">02</span><h2>怎么用</h2></div>
        <div class="cards">
          <div class="card step"><div class="num">1</div><div class="c-title">建运行</div><p>填品牌名 + 品类（别名/竞品可选）。agent 按品类生成 5 个不带品牌名的测试问题，你确认后才开跑。</p></div>
          <div class="card step"><div class="num">2</div><div class="c-title">六平台搜索</div><p>5 问题 × 6 平台 = 30 个任务后台并行，3-5 分钟。这里能看实时进度矩阵，部分平台超时属正常。</p></div>
          <div class="card step"><div class="num">3</div><div class="c-title">AI 分析 + 报告</div><p>agent 逐条分析情绪/排名/竞品，生成 GEO 综合得分与交互式 HTML 报告；关键发现直接在对话里给你。</p></div>
        </div>
      </section>`
  }

  // ---------- 视图：新建分析 ----------
  function viewNew() {
    const c = state.catalog
    const platChecks = (c.platforms || []).map((p) =>
      `<label><input type="checkbox" name="plat" value="${esc(p.key)}" checked>${esc(p.label)}</label>`).join('')
    return `
      <a class="back" href="#/">${ic('back')} 概览</a>
      <header class="head">
        <span class="eyebrow">NEW RUN</span>
        <h1>新建<strong>分析</strong></h1>
        <p>创建后到运行页补问题列表（可直接在文本框编辑，或「去对话生成」让 agent 按品类出题）。搜索前确认 RedFox API Key 已配置。</p>
      </header>
      <div class="form">
        <div class="form-row">
          <div class="field"><label>BRAND · 品牌名 *</label><input id="f-brand" placeholder="如：元气森林"></div>
          <div class="field"><label>CATEGORY · 品类/行业 *</label><input id="f-category" placeholder="如：无糖气泡水"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>ALIASES · 品牌别名（逗号分隔）</label><input id="f-aliases" placeholder="如：RED（小红书的别名）"></div>
          <div class="field"><label>COMPETITORS · 已知竞品（逗号分隔）</label><input id="f-comps" placeholder="如：可口可乐,百事可乐"></div>
        </div>
        <div class="field"><label>PLATFORMS · 搜索平台</label><div class="checks">${platChecks}</div>
          <div class="hint">平台越多耗时越长：6 平台 × 5 问题 = 30 任务约 3-5 分钟。Kimi/DeepSeek 偶尔排队慢，失败不影响其余平台。</div></div>
        <div style="display:flex;gap:var(--sp-3);flex-wrap:wrap">
          <button class="btn accent" id="f-create">创建运行</button>
          <button class="btn ghost" data-newflow>${ic('spark')}在对话里引导我填</button>
        </div>
      </div>`
  }

  function bindNew() {
    const btn = document.getElementById('f-create')
    if (!btn) return
    btn.onclick = async () => {
      const brand = document.getElementById('f-brand').value.trim()
      const category = document.getElementById('f-category').value.trim()
      if (!brand || !category) { toast('品牌名与品类必填', true); return }
      const aliases = document.getElementById('f-aliases').value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
      const competitors = document.getElementById('f-comps').value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
      const platforms = [...document.querySelectorAll('input[name="plat"]:checked')].map((n) => n.value)
      try {
        const r = await apiPost('/api/runs', { brand, category, aliases, competitors, platforms })
        toast(`运行已创建：${r.run.run_id}`)
        location.hash = `#/run/${r.run.run_id}`
      } catch (e) { toast(e.message, true) }
    }
  }

  // ---------- 视图：运行详情 ----------
  function statusChip(status) {
    return `<span class="chip ${esc(status)}">${STATUS_LABEL[status] || esc(status)}</span>`
  }

  function matrixHtml(run, progress, analysis) {
    const platforms = run.platforms || []
    const queries = run.queries || []
    let rows = ''
    // 优先用实时进度（搜索中），否则用 mention_matrix（搜索完）
    if (progress?.tasks?.length) {
      const byQ = new Map()
      for (const t of progress.tasks) {
        if (!byQ.has(t.query_index)) byQ.set(t.query_index, {})
        byQ.get(t.query_index)[t.platform] = t.status
      }
      for (const [qi, byP] of [...byQ.entries()].sort((a, b) => a[0] - b[0])) {
        const q = queries[qi] || `Q${qi + 1}`
        rows += `<div class="h-cell q" title="${esc(q)}">${esc(q)}</div>` + platforms.map((p) => {
          const st = byP[p] || 'pending'
          return `<div class="h-cell ${CELL_CLASS[st] || 'wait'}" title="${esc(p)} ${esc(st)}">${CELL_LABEL[st] || esc(st)}</div>`
        }).join('')
      }
      return `<div class="heat" style="grid-template-columns:minmax(160px,2.2fr) repeat(${platforms.length},minmax(64px,1fr))">
        <div class="h-cell q" style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">问题 / 平台</div>
        ${platforms.map((p) => `<div class="h-cell" style="color:${PLAT_COLOR[p] || 'inherit'}">${esc(p)}</div>`).join('')}
        ${rows}</div>`
    }
    const matrix = analysis?.mention_matrix || []
    if (!matrix.length) return '<div class="empty" style="border:0">还没有任务数据。</div>'
    for (const row of matrix) {
      const q = row[0]?.question || ''
      rows += `<div class="h-cell q" title="${esc(q)}">${esc(q)}</div>` + row.map((cell) => {
        const st = cell.mentioned ? 'completed' : (cell.status && cell.status !== 'completed' ? cell.status : 'missing')
        const label = cell.mentioned ? String(cell.mention_count) : (CELL_LABEL[st] || '—')
        const cls = cell.mentioned ? 'hit' : (CELL_CLASS[st] || 'nah')
        return `<div class="h-cell ${cls}" title="${esc(cell.platform)}：${cell.mentioned ? `提及 ${cell.mention_count} 次` : esc(st)}">${esc(label)}</div>`
      }).join('')
    }
    return `<div class="heat" style="grid-template-columns:minmax(160px,2.2fr) repeat(${platforms.length},minmax(64px,1fr))">
      <div class="h-cell q" style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">问题 / 平台（提及次数）</div>
      ${platforms.map((p) => `<div class="h-cell" style="color:${PLAT_COLOR[p] || 'inherit'}">${esc(p)}</div>`).join('')}
      ${rows}</div>`
  }

  function analysisSummaryHtml(run, analysis) {
    if (!analysis) return ''
    const geo = analysis.geo_score || {}
    const mr = analysis.metrics?.brand_mention_rate || {}
    const rank = analysis.brand_avg_rank || {}
    const sd = analysis.sentiment_distribution?.overall || {}
    const sentTotal = Object.values(sd).reduce((a, b) => a + b, 0)
    const negPct = sentTotal ? Math.round(((sd.negative || 0) / sentTotal) * 100) : 0
    const posPct = sentTotal ? 100 - negPct : 0
    const comps = (analysis.competitor_comparison || []).filter((c) => c.name !== run.brand && c.mention_rate_overall > 0).slice(0, 6)
    const barMax = Math.max(...(run.platforms || []).map((p) => mr[p] || 0), 0.01)
    const platBars = (run.platforms || []).map((p) => `
      <div class="pb"><span class="pb-name" style="color:${PLAT_COLOR[p] || 'inherit'}">${esc(p)}</span>
        <div class="pb-track"><div class="pb-fill" style="width:${Math.round(((mr[p] || 0) / barMax) * 100)}%"></div></div>
        <span class="pb-val">${Math.round((mr[p] || 0) * 100)}%</span></div>`).join('')
    return `
      <div class="stats" style="margin-bottom:var(--sp-6)">
        <div class="stat"><div class="mono">GEO SCORE</div><div class="val" style="color:var(--accent)">${geo.overall ?? '—'}<span class="unit">/100</span></div><div class="sub">提及40%+排名30%+情绪30%</div></div>
        <div class="stat"><div class="mono">MENTION</div><div class="val">${Math.round((mr.overall || 0) * 100)}<span class="unit">%</span></div><div class="sub">${analysis.metrics?.total_mentioned ?? 0}/${analysis.metrics?.total_completed ?? 0} 条有效回答</div></div>
        <div class="stat"><div class="mono">AVG RANK</div><div class="val">${rank.overall ? Number(rank.overall).toFixed(1) : '—'}</div><div class="sub">有排名数据的回答均值</div></div>
        <div class="stat"><div class="mono">POSITIVE</div><div class="val" style="color:${negPct > 30 ? 'var(--miss)' : 'var(--ok)'}">${sentTotal ? posPct + '<span class="unit">%</span>' : '—'}</div><div class="sub">${sd.positive || 0}正 ${sd.neutral || 0}中 ${sd.negative || 0}负</div></div>
      </div>
      <div class="block">
        <div class="block-head"><h3>分平台提及率</h3></div>
        <div class="block-body"><div class="plat-bars">${platBars}</div></div>
      </div>
      ${matrixHtml(run, null, analysis)}
      ${comps.length ? `<div class="block" style="margin-top:var(--sp-6)">
        <div class="block-head"><h3>竞品对比（提及率 TOP${comps.length}）</h3></div>
        <div class="block-body"><div class="sum-list">${comps.map((c) => `
          <div class="sum-item"><span class="d-no">${Math.round(c.mention_rate_overall * 100)}%</span>
            <span><strong>${esc(c.name)}</strong>${c.avg_rank ? ` · 平均排名 ${Number(c.avg_rank).toFixed(1)}` : ''} · 正面率 ${Math.round((c.positive_pct || 0) * 100)}%</span></div>`).join('')}</div></div>
      </div>` : ''}`
  }

  async function viewRun(id) {
    let data
    try {
      data = await api(`/api/runs/${encodeURIComponent(id)}`)
    } catch (e) {
      // 区分「服务连不上」和「run 真不存在」，别把断网误报成数据丢失
      const netDown = !e.status
      return `<a class="back" href="#/">${ic('back')} 概览</a><div class="empty"><div class="e-title">${netDown ? '面板服务连接失败' : '运行不存在'}</div><p>${netDown ? '面板的独立预览服务没在运行（嵌入 dsh 时请直接用侧栏面板）。开发预览：DSH_HOME=<数据目录> node scripts/devserver.mjs 5179' : esc(e.message)}</p></div>`
    }
    const run = data.run
    const progress = data.progress
    let analysis = null
    try { analysis = (await api(`/api/runs/${encodeURIComponent(id)}/analysis`)).analysis } catch { /* 还没报告 */ }

    const running = progress.running || run.status === 'searching'
    const queriesText = (run.queries || []).join('\n')
    const canEditQueries = !running
    const searchHint = !state.catalog?.has_key
      ? `<div class="hint" style="color:var(--miss)">未配置 RedFox API Key——先到<a href="#/settings">设置页</a>填写再搜索。</div>`
      : `<div class="hint">${(run.queries || []).length} 问题 × ${run.platforms.length} 平台 = ${(run.queries || []).length * run.platforms.length} 个任务，预计 3-5 分钟。部分平台超时属常见现象。</div>`

    const reportBtns = run.has_report
      ? `<a class="btn accent" href="/geo-analyzer/api/runs/${encodeURIComponent(id)}/report" target="_blank" rel="noreferrer">${ic('ext')}打开完整报告</a>`
      : (run.status === 'searched' || run.status === 'analyzed')
        ? `<button class="btn accent" data-agent>${ic('spark')}去对话：AI 分析 + 生成报告</button>`
        : ''
    const summary = analysis ? analysisSummaryHtml(run, analysis) : ''

    return `
      <a class="back" href="#/">${ic('back')} 概览</a>
      <div class="detail-head">
        <div>
          <h1>${esc(run.brand)}</h1>
          <div class="c-sub" style="margin-top:4px">${esc(run.category || '—')}${(run.aliases || []).length ? ` · 别名 ${esc(run.aliases.join('、'))}` : ''}${(run.competitors || []).length ? ` · 竞品 ${esc(run.competitors.join('、'))}` : ''}</div>
        </div>
        <div class="actions">
          ${statusChip(run.status)}
          ${reportBtns}
          <button class="btn ghost" data-del-run="${esc(id)}" title="删除运行">${ic('trash')}</button>
        </div>
      </div>

      <div class="block">
        <div class="block-head"><h3>问题列表</h3><span class="mono">${(run.queries || []).length} 个 · 每个问题会发给全部 ${run.platforms.length} 个平台</span>
          ${canEditQueries ? `<div class="actions"><button class="btn ghost" data-agent-gen>${ic('spark')}去对话生成问题</button></div>` : ''}
        </div>
        <div class="block-body">
          <div class="field">
            <textarea id="q-list" rows="5" placeholder="每行一个问题（推荐类≥1，多场景+功能类合计≥4，一律不带品牌名「${esc(run.brand)}」）" ${canEditQueries ? '' : 'disabled'}>${esc(queriesText)}</textarea>
            <div class="hint">问题不带品牌词结果才客观；评价类问题（如「XX怎么样」）除外。${canEditQueries ? '修改后点「保存问题」生效。' : '搜索进行中，问题列表已锁定。'}</div>
          </div>
          ${canEditQueries ? `<div style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4);flex-wrap:wrap">
            <button class="btn ghost" id="q-save">保存问题</button>
            <button class="btn accent" id="q-search" ${!(run.queries || []).length ? 'disabled' : ''}>${ic('play')}保存并开始搜索</button>
          </div>
          ${searchHint}` : ''}
        </div>
      </div>

      <div class="block">
        <div class="block-head"><h3>${running ? '搜索进度（每 4 秒自动刷新）' : '提及矩阵'}</h3>
          <span class="mono">${progress.total ? `${progress.completed + progress.invalid}/${progress.total} 已结束` : ''}</span></div>
        <div class="block-body">${matrixHtml(run, progress, analysis)}</div>
      </div>
      ${summary}
      ${!analysis && (run.status === 'created') ? '<div class="empty"><div class="e-title">下一步</div><p>确认问题列表后点「保存并开始搜索」；或者点「去对话生成问题」让 agent 按品类出题给你确认。</p></div>' : ''}
      ${!analysis && run.status === 'searched' ? '<div class="empty"><div class="e-title">搜索完成</div><p>点上方「去对话：AI 分析 + 生成报告」——agent 会逐条分析情绪/排名/竞品并生成 GEO 报告与关键发现。</p></div>' : ''}`
  }

  function bindRun(id) {
    const saveBtn = document.getElementById('q-save')
    const searchBtn = document.getElementById('q-search')
    const ta = document.getElementById('q-list')
    const readQueries = () => ta.value.split('\n').map((s) => s.trim()).filter(Boolean)

    if (saveBtn) saveBtn.onclick = async () => {
      try {
        await apiPost(`/api/runs/${encodeURIComponent(id)}/queries`, { queries: readQueries() })
        toast('问题已保存')
        render()
      } catch (e) { toast(e.message, true) }
    }
    if (searchBtn) searchBtn.onclick = async () => {
      searchBtn.disabled = true
      try {
        const queries = readQueries()
        if (!queries.length) { toast('问题列表为空', true); searchBtn.disabled = false; return }
        await apiPost(`/api/runs/${encodeURIComponent(id)}/queries`, { queries })
        const r = await apiPost(`/api/runs/${encodeURIComponent(id)}/search`)
        toast(`已提交 ${r.total} 个搜索任务，预计 3-5 分钟`)
        render()
      } catch (e) { toast(e.message, true); searchBtn.disabled = false }
    }
    const delBtn = document.querySelector('[data-del-run]')
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm('删除这次分析运行？（问题、回答、报告全部删除，不可恢复）')) return
      try {
        await apiDelete(`/api/runs/${encodeURIComponent(id)}`)
        toast('已删除')
        location.hash = '#/'
      } catch (e) { toast(e.message, true) }
    }
    const genBtn = document.querySelector('[data-agent-gen]')
    if (genBtn) genBtn.onclick = async () => {
      const run = (await api(`/api/runs/${encodeURIComponent(id)}`)).run
      sendAgentPrompt(fullFlowPrompt(run), '已在宿主开新对话——agent 会出问题给你确认')
    }
    const agentBtn = document.querySelector('[data-agent]')
    if (agentBtn) agentBtn.onclick = async () => {
      const run = (await api(`/api/runs/${encodeURIComponent(id)}`)).run
      sendAgentPrompt([
        `请继续 GEO 品牌分析（运行 ${run.run_id}，品牌「${run.brand}」）：`,
        '1. geo_analyzer(action="read_answers", runId="' + run.run_id + '") 读全部已完成回答（多时分批）',
        '2. 按 geo-analyzer 技能逐条分析：brand_rank / brand_context / sentiment / sentiment_reason / competitors_mentioned / competitor_details / key_claims（同一回答内排名不得重复，发现新竞品也要列）',
        '3. geo_analyzer(action="ai_save", runId="' + run.run_id + '", analysisJson=…) 分批存档，直到覆盖全部已完成回答',
        '4. geo_analyzer(action="report", runId="' + run.run_id + '") 生成 HTML 报告，把关键发现 5 条结论完整输出给我。',
      ].join('\n'), '已在宿主开新对话——agent 分析完成后回来看报告')
    }
  }

  function schedulePoll(id) {
    clearTimeout(state.pollTimer)
    api(`/api/runs/${encodeURIComponent(id)}`).then((d) => {
      if (location.hash !== `#/run/${id}`) return
      if (d.progress.running || d.run.status === 'searching') {
        state.pollTimer = setTimeout(() => { if (location.hash === `#/run/${id}`) render() }, 4000)
      } else if (d.run.status === 'searched' && !d.run.has_report) {
        // 搜索刚结束：刷新一次拿最终矩阵
        render()
      }
    }).catch(() => {})
  }

  // ---------- 视图：设置 ----------
  function viewSettings() {
    return `
      <a class="back" href="#/">${ic('back')} 概览</a>
      <header class="head">
        <span class="eyebrow">SETTINGS</span>
        <h1>设<strong>置</strong></h1>
        <p>RedFox API Key 是六平台 AI 搜索的唯一凭证。这里保存的 Key 优先于环境变量，低于插件配置。</p>
      </header>
      <div class="form">
        <div class="field"><label>API KEY · RedFox API Key（ak_ 开头）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="s-key" placeholder="ak_…" style="flex:1;min-width:220px;font-family:var(--font-mono);font-size:12px">
            <button class="btn" id="s-key-save">保存 Key</button>
          </div>
          <div class="hint" id="s-key-hint">…</div>
          <div class="hint">获取：<a href="https://redfox.hk/settings/api-keys?source=github" target="_blank" rel="noreferrer">redfox.hk/settings/api-keys ↗</a>。保存在本机 dsh 数据目录，不上传。</div>
        </div>
        <div class="field"><label>PROXY · HTTP(S) 代理（访问 redfox.hk 走代理时填；清空 = 直连）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="s-proxy" placeholder="http://127.0.0.1:7890" style="flex:1;min-width:220px;font-family:var(--font-mono);font-size:12px">
            <button class="btn" id="s-proxy-save">保存代理</button>
          </div>
        </div>
        <div class="field"><label>API BASE · 接口地址（测试/自建网关用，默认 https://redfox.hk）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="s-base" placeholder="https://redfox.hk" style="flex:1;min-width:220px;font-family:var(--font-mono);font-size:12px">
            <button class="btn" id="s-base-save">保存地址</button>
          </div>
          <div class="hint">日常使用留空即可。离线冒烟测试用本地假服务器地址。</div>
        </div>
      </div>`
  }

  async function bindSettings() {
    try {
      const { settings } = await api('/api/settings')
      const keyHint = document.getElementById('s-key-hint')
      if (keyHint) keyHint.textContent = settings.has_key
        ? `已配置（…${settings.key_tail || '******'}${settings.from_env ? '，其中环境变量可用' : ''}）。重新输入会覆盖。`
        : '未配置。'
      const inp = document.getElementById('s-key')
      if (inp && document.activeElement !== inp) inp.placeholder = settings.has_key ? `已配置（…${settings.key_tail}），输入新值覆盖` : 'ak_…'
      const proxy = document.getElementById('s-proxy')
      if (proxy && document.activeElement !== proxy) proxy.value = settings.proxy_url || ''
      const base = document.getElementById('s-base')
      if (base && document.activeElement !== base) base.value = settings.api_base || ''
    } catch { /* 宿主未就绪 */ }

    const bind = (id, payload) => {
      const btn = document.getElementById(id)
      if (!btn) return
      btn.onclick = async () => {
        try {
          const input = btn.parentElement.querySelector('input')
          await apiPost('/api/settings', payload(input.value.trim()))
          toast('设置已保存')
          loadCatalog().catch(() => {})
        } catch (e) { toast(e.message, true) }
      }
    }
    bind('s-key-save', (v) => ({ api_key: v }))
    bind('s-proxy-save', (v) => ({ proxy_url: v }))
    bind('s-base-save', (v) => ({ api_base: v }))
  }

  // ---------- 渲染辅助 ----------
  function page(loader) {
    $app.innerHTML = '<div class="loading">LOADING…</div>'
    loader().then((result) => {
      const [html, after] = Array.isArray(result) ? result : [result, null]
      $app.innerHTML = html
      bindCommon()
      if (after) after()
    }).catch((e) => { $app.innerHTML = `<div class="empty"><div class="e-title">加载失败</div><p>${esc(e.message)}</p></div>` })
  }

  function bindCommon() {
    document.querySelectorAll('[data-newflow]').forEach((b) => {
      b.onclick = () => sendAgentPrompt(newFlowPrompt({}), '已在宿主开新对话——agent 会先问你品牌和品类')
    })
  }

  // ---------- 路由 ----------
  async function render() {
    clearTimeout(state.pollTimer)
    try { await loadCatalog() } catch {}
    const hash = location.hash || '#/'
    // hash 里的 runId 会被浏览器百分号编码（中文品牌名），统一 decode 再匹配
    const mr = hash.match(/^#\/run\/(.+)$/)
    const runId = mr ? decodeURIComponent(mr[1]) : null
    document.querySelectorAll('.nav a').forEach((a) => {
      const cur = runId ? '' : hash === '#/' ? 'home' : hash.startsWith('#/new') ? 'new' : hash.startsWith('#/settings') ? 'settings' : 'home'
      a.classList.toggle('on', a.dataset.view === cur)
    })
    if (runId && /^[\p{L}\p{N}_-]+$/u.test(runId)) {
      $app.innerHTML = await viewRun(runId)
      bindCommon(); bindRun(runId); schedulePoll(runId)
      return
    }
    if (hash.startsWith('#/new')) { $app.innerHTML = viewNew(); bindCommon(); bindNew(); return }
    if (hash.startsWith('#/settings')) { $app.innerHTML = viewSettings(); bindCommon(); bindSettings(); return }
    $app.innerHTML = viewHome()
    bindCommon()
  }

  async function boot() {
    try { await loadCatalog() } catch {
      state.catalog = { version: '-', has_key: false, key_source: 'none', platforms: [], runs: [], searching: null, settings: {} }
      renderNavCounts()
    }
    render().catch(() => {})
  }
  addEventListener('hashchange', render)
  boot()
  setTimeout(() => { if (!state.catalog?.version || state.catalog.version === '-') boot() }, 2500)
})()
