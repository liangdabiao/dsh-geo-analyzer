// GEO HTML 报告生成器。移植自 geo-analyzer scripts/lib/report_template.py（v6 设计），
// 三处本地化修正：
//   1) 「品牌官网」识别按品牌名/别名动态匹配域名（上游写死了 nio.cn 例子）
//   2) 竞品展开明细读 mention_rate_by_platform（上游引用了不存在的 mention_rate_doubao 键）
//   3) 正/负信号关键词库去掉强品类词（换电/清热等），保留通用营销词，避免跨行业误标
import { rootDomain } from './analyzer.js'

export const PLATFORM_LABELS = {
  doubao: '豆包', kimi: 'Kimi', deepseek: 'DeepSeek',
  yuanbao: '元宝', qianwen: '千问', baidu: '百度',
}
export const PLATFORM_COLORS = {
  doubao: '#2563eb', kimi: '#7c3aed', deepseek: '#0891b2',
  yuanbao: '#e11d48', qianwen: '#ea580c', baidu: '#16a34a',
}
const SENTIMENT_LABELS = { positive: '正面', neutral: '中性', negative: '负面' }

// 域名分类（社媒/垂直站为通用常识库；品牌官网按品牌词动态判定）
const MEDIA_DOMAINS = [
  'weibo.com', 'weibo.cn', 'zhihu.com', 'zhuanlan.zhihu.com', 'bilibili.com', 'b23.tv',
  'douyin.com', 'iesdouyin.com', 'xiaohongshu.com', 'xhslink.com', 'toutiao.com', 'm.toutiao.com',
  '36kr.com', 'sina.com.cn', 'sina.cn', 'sohu.com', 'qq.com', '163.com', 'ifeng.com',
  'smzdm.com', 'baijiahao.baidu.com', 'baijiahao', 'tieba.baidu.com', 'wenku.baidu.com',
  'csdn.net', 'juejin.cn', 'sspai.com', 'ithome.com', 'mydrivers.com', 'cnbeta.com',
]
const AUTO_DOMAINS = ['autohome.com.cn', 'pcauto.com.cn', 'dongchedi.com', 'yiche.com', 'xcar.com.cn', 'cheshi.com']

export function classifyDomain(domain, brandKeywords = []) {
  const d = String(domain || '').toLowerCase().trim()
  if (brandKeywords.some((k) => k && d.includes(String(k).toLowerCase()))) return '品牌官网'
  if (AUTO_DOMAINS.some((k) => d === k || d.endsWith('.' + k) || d.includes(k))) return '汽车垂直'
  if (MEDIA_DOMAINS.some((k) => d === k || d.endsWith('.' + k) || d.includes(k))) return '社媒资讯'
  return '其他网站'
}

const CAT_COLORS = { 品牌官网: '#059669', 汽车垂直: '#2563eb', 社媒资讯: '#0f766e', 其他网站: '#a1a1aa' }
const CAT_CSS = { 品牌官网: 'sa-cat-brand', 汽车垂直: 'sa-cat-auto', 社媒资讯: 'sa-cat-media', 其他网站: 'sa-cat-other' }

// 通用正/负信号词（信号标签用，非得分口径）
const POS_PATTERNS = ['推荐', '首选', '领先', '好评', '值得', '性价比高', '口碑', '品质', '标杆', '经典', '专业', '安全', '可靠', '智能', '体验', '稳定', '创新', '热门', '主流']
const NEG_PATTERNS = ['成本高', '价格高', '偏贵', '缺点', '不足', '局限', '风险', '副作用', '不建议', '慎用', '投诉', '翻车', '落后', '小众', '售后差', '做工差']

// ── 小工具 ──────────────────────────────────────────────────────────────

const clean = (t) => String(t ?? '').replace(/\u2014/g, '-').replace(/\u2013/g, '-')
const esc = (t) => clean(String(t ?? ''))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const pct = (num, den) => (den ? Math.round((num / den) * 100) : 0)

function scoreGrade(score) {
  if (!Number.isFinite(Number(score)) || score === null || score === undefined) return ['无数据', 'var(--muted)', 'var(--surface-2)']
  const s = Number(score)
  if (s >= 80) return ['优秀', 'var(--hit)', 'var(--hit-light)']
  if (s >= 60) return ['良好', 'var(--accent)', 'var(--accent-light)']
  if (s >= 40) return ['一般', 'var(--warn)', 'var(--warn-light)']
  return ['较弱', 'var(--miss)', 'var(--miss-light)']
}

const platformLabel = (p) => PLATFORM_LABELS[p] || p
const platformColor = (p) => PLATFORM_COLORS[p] || 'var(--accent)'

// ── 摘要 ────────────────────────────────────────────────────────────────

function generateSummary(analysis, platforms, totalCompleted, totalMentioned) {
  const brand = analysis.brand || ''
  const geoScore = analysis.geo_score || {}
  const mentionRate = analysis.metrics?.brand_mention_rate || {}
  const sentimentDist = analysis.sentiment_distribution?.overall || {}
  const brandAvgRank = analysis.brand_avg_rank || {}
  const comparison = analysis.competitor_comparison || []

  const geoO = geoScore.overall ?? 0
  const mrPct = Math.round((mentionRate.overall || 0) * 100)
  const totalSent = Object.values(sentimentDist).reduce((a, b) => a + b, 0)
  const negCount = sentimentDist.negative || 0
  const posCount = sentimentDist.positive || 0
  const neuCount = sentimentDist.neutral || 0
  const avgRankO = brandAvgRank.overall

  let gradeText
  if (geoO >= 80) gradeText = '处于领先水平'
  else if (geoO >= 60) gradeText = '处于中上游水平，仍有提升空间'
  else if (geoO >= 40) gradeText = '处于中游水平，需要重点关注'
  else gradeText = '处于较弱水平，亟待改善'

  const platformLines = platforms.map((p) => {
    const s = geoScore[p] ?? 0
    const mrP = Math.round((mentionRate[p] || 0) * 100)
    const pRank = brandAvgRank[p]
    const rankStr = pRank ? Number(pRank).toFixed(1) : '未排名'
    let mrDiag
    if (mrP >= 75) mrDiag = '高提及'
    else if (mrP >= 50) mrDiag = '中等提及'
    else if (mrP >= 25) mrDiag = '较低提及'
    else mrDiag = '极低提及'
    const [gt] = scoreGrade(s)
    return `<strong>${esc(platformLabel(p))}</strong>: GEO得分${s}（${gt}），提及率${mrP}%（${mrDiag}），平均排名${rankStr}`
  })

  const compWithRank = comparison.filter((c) => (c.mention_rate_overall || 0) > 0.2 && c.name !== brand)
  const compNames = compWithRank.slice(0, 5).map((c) => c.name)
  const compText = compNames.length ? compNames.join('、') : '暂无强竞品'

  const directions = []
  const weakestP = platforms.reduce((w, p) => ((geoScore[p] ?? 0) < (geoScore[w] ?? 0) ? p : w), platforms[0])
  if (weakestP) {
    const weakestLabel = platformLabel(weakestP)
    const weakestMr = Math.round((mentionRate[weakestP] || 0) * 100)
    if (weakestMr < 50) directions.push(`重点提升${weakestLabel}平台的提及率（当前仅${weakestMr}%），可通过优化该平台的搜索内容匹配度来增加品牌曝光`)
  }
  if (avgRankO && avgRankO > 2) directions.push(`提升品牌在推荐列表中的排名位置（当前平均#${Math.round(avgRankO)}），强化产品核心卖点的差异化表达`)
  else if (avgRankO && avgRankO <= 2) directions.push(`巩固排名优势（平均#${Math.round(avgRankO)}），持续输出高质量内容维持领先地位`)
  if (negCount > 0) directions.push('关注负面反馈，针对性解决用户痛点')
  else if (neuCount > posCount) directions.push('当前中性评价居多，建议通过更多主动推荐场景和对比评测内容，将中性认知转化为正面推荐')
  if (compWithRank.length >= 3) directions.push(`关注${esc(compText)}等竞品的动态，在回答中强化自身差异化优势`)
  const directionsText = directions.join('；')

  let sentimentText
  if (totalSent > 0) {
    const negPct = pct(negCount, totalSent)
    const posPct = 100 - negPct
    sentimentText = `正面率 ${posPct}%（${posCount}正 / ${neuCount}中 / ${negCount}负，中性计入正面）`
      + (negCount > 0 ? '，存在负面评价' : '，无负面评价')
  } else {
    sentimentText = '暂无情绪数据（无有效 AI 回答）'
  }

  const compN = compWithRank.length
  const competitionText = compN >= 5 ? '竞争环境非常拥挤' : compN >= 3 ? '竞争环境较为拥挤' : compN >= 1 ? '竞争环境存在一定压力' : '暂未观察到明显竞争'

  const failedN = (analysis.per_answer || []).filter((a) => a.status && a.status !== 'completed').length
  const coverageNote = failedN
    ? ` 注：另有 ${failedN} 条回答因平台超时或返回异常已从统计中剔除，不计入提及率与得分。`
    : ''

  return `
    <div class="summary">
      <div class="summary-hd">报告摘要 · ${esc(brand)}</div>
      <div class="summary-bd">
        <p><strong>综合评估:</strong> ${esc(brand)} 跨平台GEO综合得分 <strong>${geoO}</strong> 分（满分 100），${gradeText}。品牌提及率 ${mrPct}%（${totalMentioned}/${totalCompleted} 条有效回答提及），${sentimentText}。整体品牌认知度${mrPct >= 50 ? '较高' : '有待提升'}。${coverageNote}</p>
        <p><strong>各平台表现:</strong><br>${platformLines.join('<br>')}</p>
        <p><strong>竞品格局:</strong> AI回答中高频出现的竞品${compNames.length ? `包括${compText}等，` : '暂不明显，'}${competitionText}。</p>
        <p><strong>发力方向:</strong> ${directionsText}。</p>
      </div>
    </div>`
}

// ── 品牌声音（正/负信号标签）────────────────────────────────────────────

function isNegated(claim, pattern) {
  const idx = claim.indexOf(pattern)
  if (idx <= 0) return false
  const prefix = claim.slice(Math.max(0, idx - 6), idx)
  return ['无', '不', '没', '非'].some((w) => prefix.includes(w))
}

function extractBrandVoice(analysis) {
  const posItems = []
  const negItems = []
  const seenPos = new Set()
  const seenNeg = new Set()

  for (const ans of analysis.per_answer || []) {
    if (ans.status !== 'completed' || !ans.brand_mentioned) continue
    const platform = ans.platform || ''
    const sentiment = ans.sentiment || 'neutral'
    const claims = ans.key_claims || []
    const allText = `${ans.brand_context || ''} ${ans.sentiment_reason || ''} ${claims.join(' ')}`

    if (sentiment === 'positive' || sentiment === 'neutral') {
      for (const claim of claims) {
        let isNeg = NEG_PATTERNS.some((p) => claim.includes(p))
        if (isNeg && NEG_PATTERNS.some((p) => claim.includes(p) && isNegated(claim, p))) isNeg = false
        const isPos = POS_PATTERNS.some((p) => claim.includes(p)) && !isNeg
        if (isPos && !seenPos.has(claim)) {
          seenPos.add(claim)
          posItems.push({ text: claim, platform })
        }
        if (isNeg && !seenNeg.has(claim)) {
          seenNeg.add(claim)
          negItems.push({ text: claim, platform })
        }
      }
      for (const pat of POS_PATTERNS) {
        if (allText.includes(pat) && !seenPos.has(pat)) {
          seenPos.add(pat)
          posItems.push({ text: pat, platform, tag: true })
        }
      }
    }

    if (sentiment === 'negative') {
      for (const claim of claims) {
        let isNeg = NEG_PATTERNS.some((p) => claim.includes(p))
        if (isNeg && NEG_PATTERNS.some((p) => claim.includes(p) && isNegated(claim, p))) isNeg = false
        const isPos = POS_PATTERNS.some((p) => claim.includes(p))
        if (isPos && !isNeg) {
          if (!seenPos.has(claim)) { seenPos.add(claim); posItems.push({ text: claim, platform }) }
        } else if (!seenNeg.has(claim)) {
          seenNeg.add(claim)
          negItems.push({ text: claim, platform })
        }
      }
    }
  }
  return [posItems.slice(0, 20), negItems.slice(0, 10)]
}

// ── 品牌位次 ────────────────────────────────────────────────────────────

function computePosition(analysis) {
  const ranks = []
  const rankTotals = []
  for (const ans of analysis.per_answer || []) {
    if (ans.status !== 'completed' || !ans.brand_mentioned) continue
    const r = Number(ans.brand_rank)
    if (Number.isFinite(r) && r > 0) {
      ranks.push(r)
      const details = ans.competitor_details || []
      const total = details.length ? details.length + 1 : (ans.ai_competitors_mentioned || []).length + 1
      rankTotals.push(Math.max(total, r))
    }
  }
  if (!ranks.length) return null
  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length
  const avgTotal = rankTotals.length ? rankTotals.reduce((a, b) => a + b, 0) / rankTotals.length : Math.max(...ranks) + 2
  const ratio = avgTotal > 0 ? avgRank / avgTotal : 0.5
  let label, cssClass
  if (avgRank <= 2) { label = '领先'; cssClass = 'pos-leading' }
  else if (ratio <= 0.4) { label = '上游'; cssClass = 'pos-upper' }
  else if (ratio <= 0.65) { label = '中游'; cssClass = 'pos-mid' }
  else { label = '落后'; cssClass = 'pos-trailing' }
  return { avg_rank: avgRank, total_brands: Math.round(avgTotal), label, css_class: cssClass, rank_count: ranks.length }
}

// ── 信源收集 ────────────────────────────────────────────────────────────

const domainOf = (url, fallback = '') => {
  if (!url) return fallback
  try { return (new URL(String(url)).hostname || '').replace(/^www\./, '').toLowerCase() || fallback } catch { return fallback }
}

function collectSources(analysis, searchResults, brandKeywords) {
  if (!searchResults) return null
  const results = searchResults.results || []
  const articleFreq = {}
  const articleMeta = {}
  const domainFreq = {}
  const platformSourceCount = {}
  const platformAnswered = {}
  const platformNoSource = {}
  const platformDomainFreq = {}

  for (const r of results) {
    if (r.status !== 'completed') continue
    const p = r.platform || ''
    platformAnswered[p] = (platformAnswered[p] || 0) + 1
    const srcs = r.sources || []
    if (!srcs.length) platformNoSource[p] = (platformNoSource[p] || 0) + 1
    for (const src of srcs) {
      const url = src.url || ''
      let domain = src.domain || domainOf(url)
      if (!url) continue
      let title = src.title || domain
      if (!domain) domain = domainOf(url, url)
      articleFreq[url] = (articleFreq[url] || 0) + 1
      articleMeta[url] = { title, domain, url }
      const key = rootDomain(domain)
      domainFreq[key] = (domainFreq[key] || 0) + 1
      platformSourceCount[p] = (platformSourceCount[p] || 0) + 1
      platformDomainFreq[p] ??= {}
      platformDomainFreq[p][key] = (platformDomainFreq[p][key] || 0) + 1
    }
  }

  if (!Object.keys(articleFreq).length) {
    return {
      top_domains: [], top_articles: [], category_freq: {}, total_citations: 0, domain_freq: {},
      platform_source_count: platformSourceCount, platform_answered: platformAnswered,
      platform_no_source: platformNoSource, platform_domain_freq: platformDomainFreq, monopolies: [],
    }
  }

  const categoryFreq = {}
  for (const [domain, count] of Object.entries(domainFreq)) {
    const cat = classifyDomain(domain, brandKeywords)
    categoryFreq[cat] = (categoryFreq[cat] || 0) + count
  }
  const totalCitations = Object.values(domainFreq).reduce((a, b) => a + b, 0)

  const topDomains = Object.entries(domainFreq).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const topArticles = Object.entries(articleFreq).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([url, freq]) => [articleMeta[url], freq])

  const monopolies = []
  for (const [p, pf] of Object.entries(platformDomainFreq)) {
    const values = Object.values(pf)
    const pTotal = values.reduce((a, b) => a + b, 0)
    if (pTotal < 5) continue
    const [topD, topC] = Object.entries(pf).sort((a, b) => b[1] - a[1])[0]
    if (topC / pTotal >= 0.7) {
      monopolies.push({ platform: platformLabel(p), domain: topD, count: topC, total: pTotal, share: Math.round((topC / pTotal) * 100) })
    }
  }

  return {
    top_domains: topDomains, top_articles: topArticles, category_freq: categoryFreq,
    total_citations: totalCitations, domain_freq: domainFreq,
    platform_source_count: platformSourceCount, platform_answered: platformAnswered,
    platform_no_source: platformNoSource, platform_domain_freq: platformDomainFreq, monopolies,
  }
}

// ── 各板块渲染 ──────────────────────────────────────────────────────────

function renderFingerprint(analysis, platforms, totalCompleted, totalMentioned, position) {
  const geoScore = analysis.geo_score || {}
  const mentionRate = analysis.metrics?.brand_mention_rate || {}
  const sentimentDist = analysis.sentiment_distribution?.overall || {}
  const avgRank = analysis.brand_avg_rank?.overall
  const geoO = geoScore.overall ?? 0
  const mrPct = pct(totalMentioned, totalCompleted)
  const totalSent = Object.values(sentimentDist).reduce((a, b) => a + b, 0)
  const negPct = totalSent ? pct(sentimentDist.negative || 0, totalSent) : 0
  const posPct = 100 - negPct
  const rankStr = avgRank ? Number(avgRank).toFixed(1) : 'N/A'

  let scoreCards = ''
  for (const p of platforms) {
    const s = geoScore[p] ?? 0
    const [gt, gc, gbg] = scoreGrade(s)
    const rate = mentionRate[p] || 0
    const pDone = (analysis.per_answer || []).filter((a) => a.platform === p && a.status === 'completed').length
    const pMent = (analysis.per_answer || []).filter((a) => a.platform === p && a.status === 'completed' && a.brand_mentioned).length
    scoreCards += `
        <div style="padding:var(--sp2) var(--sp3);border:1px solid var(--line);border-radius:var(--r);background:var(--surface)">
          <div style="display:flex;align-items:center;gap:var(--sp2);margin-bottom:var(--sp1)">
            <span class="ptag" style="font-size:11px"><span class="pd" style="background:${platformColor(p)}"></span>${esc(platformLabel(p))}</span>
            <span class="num" style="font-size:var(--s3);color:${gc}">${s}</span>
            <span class="badge" style="font-size:10px;padding:1px 6px;background:${gbg};color:${gc}">${gt}</span>
          </div>
          <div style="font-size:10px;color:var(--muted)">提及 ${Math.round(rate * 100)}% · ${pMent}/${pDone} 条</div>
        </div>`
  }

  let posHtml = ''
  if (position) {
    posHtml = `
        <div class="pos-bar" style="margin-top:0;margin-bottom:var(--sp3)">
          <div class="pos-rank ${position.css_class}">#${Math.round(position.avg_rank)}</div>
          <div>
            <div class="pos-label ${position.css_class}">${position.label}</div>
            <div class="pos-desc">平均排名 ${position.avg_rank.toFixed(1)} · 约 ${position.total_brands} 个品牌参与</div>
          </div>
        </div>`
  }

  return `
    <div class="g2">
      <div class="card">
        ${posHtml}
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:var(--sp4) var(--sp5);margin-bottom:var(--sp3)">
          <div><div style="font-size:11px;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.03em">GEO 综合</div><div class="num" style="font-size:var(--s5);color:var(--accent)">${geoO}<span style="font-size:var(--xs);font-weight:500;color:var(--muted);margin-left:var(--sp1)">（满分 100）</span></div></div>
          <div><div style="font-size:11px;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.03em">提及率</div><div class="num" style="font-size:var(--s4);color:var(--hit)">${mrPct}%</div></div>
          <div><div style="font-size:11px;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.03em">平均排名</div><div class="num" style="font-size:var(--s4);color:var(--warn)">${rankStr}</div></div>
          <div><div style="font-size:11px;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.03em">正面率</div><div class="num" style="font-size:var(--s4);color:var(--hit)">${posPct}%</div></div>
        </div>
        <div class="src">综合得分 = 提及率*40% + 排名得分*30% + 情感得分*30% · 情感得分=正面率*100，正面率=1-负面率（中性计入正面）</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:var(--sp2)">${scoreCards}</div>
    </div>`
}

function renderMentionMatrix(analysis, platforms, queries, totalCompleted) {
  const matrix = analysis.mention_matrix || []
  const perAnswer = analysis.per_answer || []
  const headerCells = platforms.map((p) =>
    `<th><span class="ptag"><span class="pd" style="background:${platformColor(p)}"></span>${esc(platformLabel(p))}</span></th>`).join('')
  let rows = ''
  matrix.forEach((row, i) => {
    const q = queries[i] ?? `Q${i + 1}`
    const qShort = q.length <= 24 ? q : q.slice(0, 24) + '...'
    let cells = ''
    row.forEach((cell, j) => {
      if (cell.mentioned) {
        cells += `<td class="heat-y" title="出现${cell.mention_count}次">${cell.mention_count}</td>`
      } else {
        const p = platforms[j] ?? ''
        const hasFailed = perAnswer.some((a) => a.query_index === i && a.platform === p && a.status !== 'completed')
        cells += `<td class="${hasFailed ? 'heat-f' : 'heat-n'}" title="${hasFailed ? '查询失败' : '未提及'}">${hasFailed ? '✕' : '—'}</td>`
      }
    })
    rows += `<tr><td style="text-align:left;font-size:var(--sm);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(q)}">${esc(qShort)}</td>${cells}</tr>`
  })
  return `
    <div class="card">
      <table class="heat">
        <thead><tr><th style="text-align:left;width:50%">问题</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="display:flex;gap:var(--sp4);margin-top:var(--sp3);flex-wrap:wrap;font-size:var(--xs);color:var(--muted)">
        <span><span style="display:inline-block;width:8px;height:8px;background:var(--accent-light);border-radius:2px;vertical-align:middle;margin-right:var(--sp1)"></span>已提及</span>
        <span><span style="display:inline-block;width:8px;height:8px;background:var(--surface-2);border-radius:2px;vertical-align:middle;margin-right:var(--sp1)"></span>未提及 (—)</span>
        <span><span style="display:inline-block;width:8px;height:8px;background:var(--miss-light);border-radius:2px;vertical-align:middle;margin-right:var(--sp1)"></span>查询失败 (✕)</span>
      </div>
      <div class="src">共 ${totalCompleted} 条回答, 通过关键词匹配(品牌名+别名)检测是否提及</div>
    </div>`
}

function renderSentimentMerged(analysis, platforms, hasAi, posTags, negTags) {
  if (!hasAi) return '<div class="card" style="color:var(--muted)">暂无 AI 情感分析数据（让 agent 按 geo-analyzer 技能执行 read_answers → ai_save 后重新生成报告）</div>'
  const dist = analysis.sentiment_distribution || {}
  const overall = dist.overall || { positive: 0, neutral: 0, negative: 0 }
  const total = Object.values(overall).reduce((a, b) => a + b, 0)
  const negPct = total ? pct(overall.negative || 0, total) : 0
  const posPct = 100 - negPct
  const neuPct = total ? pct(overall.neutral || 0, total) : 0

  let platformRows = ''
  for (const p of platforms) {
    const d = dist[p] || { positive: 0, neutral: 0, negative: 0 }
    const t = Object.values(d).reduce((a, b) => a + b, 0) || 1
    const pp = Math.round((d.positive / t) * 100)
    const np = Math.round((d.neutral / t) * 100)
    const ng = 100 - pp - np
    platformRows += `
        <div style="display:flex;align-items:center;gap:var(--sp3);padding:var(--sp2) 0;border-bottom:1px solid var(--surface-2)">
          <span class="ptag" style="width:70px"><span class="pd" style="background:${platformColor(p)}"></span>${esc(platformLabel(p))}</span>
          <div style="flex:1;display:flex;height:14px;border-radius:var(--rs);overflow:hidden;gap:1px">
            <div style="width:${pp}%;background:var(--hit)"></div>
            <div style="width:${np}%;background:#d4d4d8"></div>
            <div style="width:${ng}%;background:var(--miss)"></div>
          </div>
          <span class="num" style="font-size:var(--xs);color:var(--muted);width:80px;text-align:right">${d.positive}正 ${d.neutral}中 ${d.negative}负</span>
        </div>`
  }

  let posHtml = posTags.map((item) => {
    const p = platformLabel(item.platform)
    return item.tag
      ? `<span class="vtag vtag-pos">${esc(item.text)}</span>`
      : `<span class="vtag vtag-pos">${esc(item.text)} <span class="vp">${esc(p)}</span></span>`
  }).join('')
  if (!posHtml) posHtml = '<span style="color:var(--muted);font-size:var(--sm)">未提取到正面信号</span>'
  let negHtml = negTags.map((item) =>
    `<span class="vtag vtag-neg">${esc(item.text)} <span class="vp">${esc(platformLabel(item.platform))}</span></span>`).join('')
  if (!negHtml) negHtml = '<span style="color:var(--muted);font-size:var(--sm)">未发现负面信号</span>'

  let posInsights = ''
  let negInsights = ''
  for (const ans of analysis.per_answer || []) {
    if (ans.status !== 'completed') continue
    const s = ans.sentiment || 'neutral'
    if (s === 'neutral') continue
    const bc = s === 'positive' ? 'b-h' : 'b-m'
    const card = `<div class="insight ${s === 'positive' ? 'ins-h' : 'ins-m'}"><span class="badge ${bc}">${SENTIMENT_LABELS[s] || s}</span> <strong>${esc(platformLabel(ans.platform))}</strong> / ${esc(ans.question || '')}<br><span style="font-size:var(--xs);color:var(--muted)">${esc(ans.sentiment_reason || '')}</span></div>`
    if (s === 'positive') posInsights += card
    else negInsights += card
  }
  if (!posInsights) posInsights = '<div style="color:var(--muted);font-size:var(--sm);padding:var(--sp4)">无正面回答详情</div>'
  if (!negInsights) negInsights = '<div style="color:var(--muted);font-size:var(--sm);padding:var(--sp4)">无负面回答详情</div>'

  return `
    <div class="g2">
      <div class="card">
        <div class="cl">整体情感分布</div>
        <div class="legend" style="margin-bottom:var(--sp3)">
          <div class="legend-item"><div class="legend-dot" style="background:var(--hit)"></div>正面<span class="legend-val">${overall.positive || 0}</span></div>
          <div class="legend-item"><div class="legend-dot" style="background:#d4d4d8"></div>中性<span class="legend-val">${overall.neutral || 0}</span></div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--miss)"></div>负面<span class="legend-val">${overall.negative || 0}</span></div>
        </div>
        <div class="src">AI 对 ${total} 条回答逐条情感分析(正面=推荐倾向 / 中性=客观描述 / 负面=批评态度)</div>
      </div>
      <div class="card">
        <div class="cl">各平台情感对比</div>
        ${platformRows}
        <div class="src">各平台独立统计, 正面=主动推荐 / 中性=客观提及 / 负面=指出不足</div>
      </div>
    </div>
    <div class="g2" style="margin-top:var(--sp3)">
      <div class="card">
        <div class="cl">正面信号 (${posTags.length} 项)</div>
        <div style="display:flex;flex-wrap:wrap;margin-bottom:var(--sp3)">${posHtml}</div>
        <div class="src">从 AI 回答中提取, 匹配关键词库(${POS_PATTERNS.length}个正面词)</div>
        ${posInsights}
      </div>
      <div class="card">
        <div class="cl">负面信号 (${negTags.length} 项)</div>
        <div style="display:flex;flex-wrap:wrap;margin-bottom:var(--sp3)">${negHtml}</div>
        <div class="src">已排除“无XX”类假阳性(如“无充电等待”不算负面)</div>
        ${negInsights}
      </div>
    </div>`
}

function renderSourcesAnalysis(analysis, searchResults, platforms, totalCompleted, sourcesData, brandKeywords) {
  if (!sourcesData) return '<div class="card" style="color:var(--muted)">暂无信源数据</div>'
  const { top_domains: topDomains, top_articles: topArticles, category_freq: categoryFreq, total_citations: totalCitations } = sourcesData

  let domainRows = ''
  topDomains.forEach(([domain, count], i) => {
    const cat = classifyDomain(domain, brandKeywords)
    const cssCat = CAT_CSS[cat] || 'sa-cat-other'
    const isBrand = brandKeywords.some((k) => k && domain.toLowerCase().includes(String(k).toLowerCase()))
    const nameStyle = isBrand ? 'color:var(--hit);font-weight:600' : ''
    const mark = isBrand ? ' *' : ''
    domainRows += `<div class="sa-row"><span class="sa-rank">${i + 1}</span><a class="sa-name sa-article-link" href="https://${esc(domain)}" target="_blank" rel="noopener" style="${nameStyle}" title="${esc(domain)}">${esc(domain)}${mark}</a><span class="sa-cnt">${count}</span><span class="sa-cat ${cssCat}">${cat}</span></div>`
  })

  let articleRows = ''
  topArticles.forEach(([meta, count], i) => {
    const title = esc(meta.title).slice(0, 30)
    articleRows += `<a class="sa-row sa-article-link" href="${esc(meta.url)}" target="_blank" rel="noopener"><span class="sa-rank">${i + 1}</span><span class="sa-name" title="${esc(meta.title)}">${title}</span><span class="sa-cnt">${count}</span></a>`
  })

  let catBar = ''
  for (const [cat, count] of Object.entries(categoryFreq).sort((a, b) => b[1] - a[1])) {
    const p = totalCitations ? (count / totalCitations) * 100 : 0
    catBar += `<div class="sa-cat-item"><span class="sa-cat-dot" style="background:${CAT_COLORS[cat] || '#a1a1aa'}"></span><span class="sa-cat-pct">${p.toFixed(1)}%</span> ${cat}</div>`
  }

  const brand = analysis.brand || ''
  let brandNote
  if (topDomains.some(([d]) => brandKeywords.some((k) => k && d.toLowerCase().includes(String(k).toLowerCase())))) {
    brandNote = `<span style="color:var(--hit)">* ${esc(brand)} 品牌官网</span>`
  } else if (brand) {
    brandNote = `<span style="color:var(--miss)">"${esc(brand)}" 品牌官网未进入 TOP10</span>`
  } else {
    brandNote = ''
  }

  const coverageNotes = []
  const pSrc = sourcesData.platform_source_count || {}
  const pAns = sourcesData.platform_answered || {}
  for (const p of platforms) {
    const answered = pAns[p] || 0
    if (answered && !pSrc[p]) {
      coverageNotes.push(`${esc(platformLabel(p))} 的 ${answered} 条回答均未返回可解析外链信源${p === 'kimi' ? '（该平台仅提供正文内联引用标记）' : ''}`)
    }
  }
  const firstNote = (searchResults?.results || []).find((r) => r.sources_note)?.sources_note
  if (firstNote && !coverageNotes.includes(firstNote)) coverageNotes.push(esc(firstNote))
  for (const m of sourcesData.monopolies || []) {
    coverageNotes.push(`${esc(m.platform)}的信源高度集中于 ${esc(m.domain)}（${m.count}/${m.total} 次，占 ${m.share}%），该平台域名多样性视角参考价值有限`)
  }

  const noteHtml = coverageNotes.length
    ? `<div style="margin-top:var(--sp3);font-size:var(--xs);color:var(--warn);background:var(--warn-light);border:1px solid #fde68a;border-radius:var(--rs);padding:var(--sp2) var(--sp3);line-height:1.7"><strong>数据完整性提示：</strong> ${coverageNotes.join('；')}</div>`
    : ''

  if (!topDomains.length) {
    return `
    <div class="card" style="color:var(--muted)">暂无信源数据（所有平台本次均未返回可解析外链信源）</div>
    ${noteHtml}`
  }

  return `
    <div class="sa-grid">
      <div class="sa-list">
        <div class="sa-list-hd">信源引用域名聚合排序 (TOP10)</div>
        ${domainRows}
      </div>
      <div class="sa-list">
        <div class="sa-list-hd">信源引用文章频次排名 (TOP10)</div>
        ${articleRows}
      </div>
    </div>
    <div class="sa-cat-bar">${catBar}</div>
    <div style="display:flex;gap:var(--sp4);margin-top:var(--sp1);font-size:var(--xs);color:var(--muted);justify-content:center">${brandNote}</div>
    <div class="src">总引用 ${totalCitations} 次 · 来自 ${totalCompleted} 条有效回答 · 域名按聚合频次降序（已合并同站子域）· 文章按被引用次数降序</div>
    ${noteHtml}`
}

function renderCompetitors(analysis, platforms, totalCompleted) {
  const comparison = analysis.competitor_comparison || []
  const brand = analysis.brand || ''
  const mentionRate = analysis.metrics?.brand_mention_rate || {}
  const brandAvgRank = analysis.brand_avg_rank || {}
  const brandSentiment = analysis.sentiment_distribution?.overall || {}
  if (!comparison.length && !brand) return '<div class="card" style="color:var(--muted)">暂无竞品数据</div>'

  const brandTotalS = Object.values(brandSentiment).reduce((a, b) => a + b, 0)
  const brandNegPct = brandTotalS ? pct(brandSentiment.negative || 0, brandTotalS) : 0
  const brandPosPct = 100 - brandNegPct
  const brandRankStr = brandAvgRank.overall ? Number(brandAvgRank.overall).toFixed(1) : 'N/A'
  const brandRow = `
    <tr class="hl">
      <td><strong>${esc(brand)}</strong> <span class="badge b-a">本品牌</span></td>
      <td class="num">${Math.round((mentionRate.overall || 0) * 100)}%</td>
      <td class="num">${brandRankStr}</td>
      <td class="num" style="color:var(--hit)">${brandPosPct}%</td>
    </tr>`

  const sortedComps = [...comparison].sort((a, b) => (b.mention_rate_overall || 0) - (a.mention_rate_overall || 0))
  let compRows = ''
  let compCount = 0
  let skippedCount = 0
  for (const comp of sortedComps) {
    const name = comp.name || ''
    if (name === brand) continue
    const mr = comp.mention_rate_overall || 0
    if (mr <= 0) continue
    if (compCount >= 10) { skippedCount++; continue }
    compCount++
    const rank = comp.avg_rank
    const rs = rank ? Number(rank).toFixed(1) : 'N/A'
    const sd = comp.sentiment_dist || {}
    const sdTotal = Object.values(sd).reduce((a, b) => a + b, 0)
    const compNegPct = sdTotal ? pct(sd.negative || 0, sdTotal) : 0
    const pp = 100 - compNegPct
    const perPlatform = platforms.map((p) => `${esc(platformLabel(p))} ${Math.round(((comp.mention_rate_by_platform || {})[p] || 0) * 100)}%`).join(' · ')
    const detail = `<div class="fold-body" style="font-size:var(--xs)"><strong>各平台提及:</strong> ${perPlatform}<br><strong>情感分布:</strong> 正面${sd.positive || 0} / 中性${sd.neutral || 0} / 负面${sd.negative || 0}</div>`
    compRows += `<tr><td><span class="fold" style="font-size:var(--sm)">${esc(name)}</span>${detail}</td><td class="num">${Math.round(mr * 100)}%</td><td class="num">${rs}</td><td class="num" style="color:var(--hit)">${pp}%</td></tr>`
  }
  const moreText = skippedCount > 0
    ? `<div style="margin-top:var(--sp2);font-size:var(--xs);color:var(--muted);text-align:center">还有 ${skippedCount} 个竞品未展示（提及率较低）</div>`
    : ''
  return `
    <div class="card">
      <table class="tbl">
        <thead><tr><th style="width:35%">品牌 (点击展开详情)</th><th>提及率</th><th>平均排名</th><th>正面率</th></tr></thead>
        <tbody>${brandRow}${compRows}</tbody>
      </table>
      ${moreText}
      <div class="src">提及率=关键词匹配+AI提及列表推断排名 · 正面率=1-负面率（中性计入正面） · 排名=在推荐列表中的位置</div>
    </div>`
}

function renderArchive(analysis, searchResults, platforms, queries) {
  const brand = analysis.brand || ''
  if (!searchResults) return '<div class="card" style="color:var(--muted)">暂无原始数据</div>'
  const results = searchResults.results || []
  if (!results.length) return '<div class="card" style="color:var(--muted)">暂无原始数据</div>'

  const byQuestion = new Map()
  for (const r of results) {
    const qi = r.query_index ?? 0
    if (!byQuestion.has(qi)) byQuestion.set(qi, [])
    byQuestion.get(qi).push(r)
  }
  const perAnswerMap = new Map()
  for (const a of analysis.per_answer || []) perAnswerMap.set(`${a.query_index}|${a.platform}`, a)

  const brandKw = brand ? [brand, ...(analysis.aliases || [])].filter(Boolean) : []
  let panels = ''
  for (const qi of [...byQuestion.keys()].sort((a, b) => a - b)) {
    const question = queries[qi] ?? `Q${qi + 1}`
    const answers = byQuestion.get(qi)
    let platformItems = ''
    for (const ans of answers) {
      const p = ans.platform || ''
      const status = ans.status || 'unknown'
      const pa = perAnswerMap.get(`${qi}|${p}`) || {}
      const s = pa.sentiment || ''
      let sb = ''
      if (s && status === 'completed') {
        const bc = { positive: 'b-h', neutral: 'b-g', negative: 'b-m' }[s] || 'b-g'
        sb = ` <span class="badge ${bc}">${SENTIMENT_LABELS[s] || s}</span>`
      }
      const cd = status !== 'completed' ? `[${status}]${ans.error ? ' ' + esc(ans.error) : ''}` : (ans.content || '')
      let escaped = esc(cd)
      for (const kw of brandKw) {
        const ekw = esc(kw)
        if (ekw && escaped.includes(ekw)) {
          escaped = escaped.split(ekw).join(`<mark style="background:#fef08a;color:inherit;padding:0 2px;border-radius:2px">${ekw}</mark>`)
        }
      }
      platformItems += `<div style="margin-bottom:var(--sp3)"><div class="fold" style="font-size:var(--sm);font-weight:500"><span class="ptag"><span class="pd" style="background:${platformColor(p)}"></span>${esc(platformLabel(p))}</span>${sb}</div><div class="fold-body">${escaped}</div></div>`
    }
    const nd = '<div style="color:var(--muted)">暂无数据</div>'
    panels += `<div class="card" style="margin-bottom:var(--sp3)"><div class="fold" style="font-size:var(--s1);font-weight:600">Q${qi + 1}. ${esc(clean(question))}</div><div class="fold-body">${platformItems || nd}</div></div>`
  }
  return panels
}

// ── 主入口 ──────────────────────────────────────────────────────────────

export function generateReportHtml(analysis, searchResults = null) {
  const brand = analysis.brand || ''
  const platforms = analysis.platforms?.length ? analysis.platforms : ['doubao', 'kimi', 'deepseek', 'yuanbao', 'qianwen', 'baidu']
  const queries = analysis.queries || []
  const hasAi = 'sentiment_distribution' in analysis
  const totalCompleted = analysis.metrics?.total_completed || 0
  const totalMentioned = analysis.metrics?.total_mentioned || 0
  const geoOverall = analysis.geo_score?.overall ?? 0

  const brandKeywords = [brand, ...(analysis.aliases || [])].filter(Boolean)
  const [posTags, negTags] = extractBrandVoice(analysis)
  const position = computePosition(analysis)
  const sourcesData = collectSources(analysis, searchResults, brandKeywords)
  const summaryHtml = generateSummary(analysis, platforms, totalCompleted, totalMentioned)

  const sections = [
    ['品牌指纹', renderFingerprint(analysis, platforms, totalCompleted, totalMentioned, position)],
    ['提及矩阵', renderMentionMatrix(analysis, platforms, queries, totalCompleted)],
    ['情感分析', renderSentimentMerged(analysis, platforms, hasAi, posTags, negTags)],
    ['信源分析', renderSourcesAnalysis(analysis, searchResults, platforms, totalCompleted, sourcesData, brandKeywords)],
    ['竞品对比', renderCompetitors(analysis, platforms, totalCompleted)],
    ['原始存档', renderArchive(analysis, searchResults, platforms, queries)],
  ]

  const navHtml = sections.map(([label], i) => `<a href="#s${i}" class="nl">${label}</a>`).join('')
  const sectionsHtml = sections.map(([label, content], i) =>
    `<section id="s${i}" class="report-section"><h2 class="sec-title">${label}</h2>${content}</section>`).join('')

  const platformLabels = platforms.map(platformLabel).join(' / ')
  const mrPct = pct(totalMentioned, totalCompleted)
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ')

  return buildHtml({ brand, platformLabels, now, geoStr: String(geoOverall), mrPct, totalCompleted, navHtml, sectionsHtml, summaryHtml })
}

const CSS = String.raw`
:root {
  --bg: #f8fafb; --surface: #ffffff; --surface-2: #f1f5f7;
  --text: #1a1d21; --muted: #64748b; --line: #e2e8f0;
  --accent: #0f766e; --accent-light: #f0fdfa;
  --hit: #059669; --hit-light: #ecfdf5;
  --miss: #dc2626; --miss-light: #fef2f2;
  --warn: #b45309; --warn-light: #fffbeb;
  --font-d: 'Outfit','Noto Sans SC',system-ui,sans-serif;
  --font-b: 'Noto Sans SC',system-ui,'PingFang SC','Microsoft YaHei',sans-serif;
  --font-m: 'JetBrains Mono','Menlo','Consolas',monospace;
  --xs: .7rem; --sm: .8125rem; --s0: .9375rem; --s1: 1.0625rem;
  --s2: 1.1875rem; --s3: 1.375rem; --s4: 1.75rem; --s5: 2.25rem;
  --sp1: .1875rem; --sp2: .4375rem; --sp3: .6875rem; --sp4: .875rem;
  --sp5: 1.125rem; --sp6: 1.375rem; --sp8: 1.75rem; --sp10: 2.25rem;
  --wide: 62rem; --pad: clamp(.875rem,3.5vw,2.5rem);
  --r: 8px; --rs: 5px;
  --sh: 0 1px 2px rgba(15,23,42,.04),0 1px 1px rgba(15,23,42,.02);
  --dur: 180ms; --ease: cubic-bezier(.33,1,.68,1);
}
@media(prefers-reduced-motion:reduce){:root{--dur:0ms}}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font-b);font-size:var(--s0);line-height:1.65;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:var(--wide);margin:0 auto;padding:0 var(--pad)}

nav.top{position:sticky;top:0;z-index:100;background:rgba(248,250,251,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:0 var(--pad)}
nav.top .inner{max-width:var(--wide);margin:0 auto;display:flex;gap:var(--sp1);overflow-x:auto;scrollbar-width:none;padding:var(--sp2) 0}
nav.top .inner::-webkit-scrollbar{display:none}
.nl{font-family:var(--font-d);font-size:var(--xs);font-weight:500;color:var(--muted);text-decoration:none;white-space:nowrap;padding:4px 10px;border-radius:var(--r);transition:all var(--dur) var(--ease)}
.nl:hover{color:var(--text);background:var(--surface-2)}
.nl.active{color:var(--accent);background:var(--accent-light)}

header.hero{padding:var(--sp8) 0 var(--sp6)}
header.hero h1{font-family:var(--font-d);font-weight:700;font-size:clamp(1.5rem,3.5vw,var(--s4));letter-spacing:-.02em;color:var(--text);margin-bottom:var(--sp1);line-height:1.2}
header.hero .sub{font-size:var(--sm);color:var(--muted)}

section.report-section{padding:var(--sp6) 0;border-top:1px solid var(--line)}
.sec-title{font-family:var(--font-d);font-weight:600;font-size:var(--s2);letter-spacing:-.01em;margin-bottom:var(--sp5);color:var(--text);display:flex;align-items:center;gap:var(--sp3)}
.sec-title::before{content:'';width:3px;height:1.1em;background:var(--accent);border-radius:2px;flex-shrink:0}

.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--sp5);box-shadow:var(--sh)}
.card+.card{margin-top:var(--sp3)}
.cl{font-family:var(--font-d);font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:var(--sp3)}
.src{font-size:10px;color:var(--muted);margin-top:var(--sp4);line-height:1.6;font-family:var(--font-m);opacity:.8}
.src::before{content:'说明: ';font-weight:600}

.g2{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp3)}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--sp3)}
@media(max-width:640px){.g2,.g3{grid-template-columns:1fr}}

.num{font-family:var(--font-m);font-weight:700;font-variant-numeric:tabular-nums}
.ptag{display:inline-flex;align-items:center;gap:var(--sp2);font-size:var(--sm);font-weight:500}
.pd{width:7px;height:7px;border-radius:50%;flex-shrink:0}

.heat{width:100%;border-collapse:separate;border-spacing:0}
.heat th{padding:var(--sp2) var(--sp3);font-size:var(--xs);font-weight:600;color:var(--muted);text-align:center;border-bottom:1px solid var(--line);font-family:var(--font-d)}
.heat td{padding:6px var(--sp3);font-size:var(--sm);text-align:center;border-bottom:1px solid var(--surface-2)}
.heat-y{background:var(--accent-light);color:var(--accent);font-family:var(--font-m);font-weight:700;border-radius:var(--rs)}
.heat-n{color:var(--muted);opacity:.4;background:var(--surface-2);font-weight:500}
.heat-f{color:var(--miss);font-size:var(--xs);background:var(--miss-light);border-radius:var(--rs)}

.tbl{width:100%;border-collapse:separate;border-spacing:0}
.tbl th{padding:var(--sp2) var(--sp3);text-align:left;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.03em;border-bottom:1px solid var(--line);font-family:var(--font-d);text-transform:uppercase}
.tbl td{padding:var(--sp2) var(--sp3);font-size:var(--sm);border-bottom:1px solid var(--surface-2);vertical-align:middle}
.tbl tr:hover td{background:var(--surface-2)}
.tbl .hl td{background:var(--accent-light);font-weight:600}
.tbl .hl:hover td{background:#ccfbf1}

.badge{display:inline-block;padding:2px 8px;border-radius:var(--rs);font-size:10px;font-weight:600;line-height:1.6}
.b-h{background:var(--hit-light);color:var(--hit)}
.b-m{background:var(--miss-light);color:var(--miss)}
.b-w{background:var(--warn-light);color:var(--warn)}
.b-a{background:var(--accent-light);color:var(--accent)}
.b-g{background:var(--surface-2);color:var(--muted)}

.insight{padding:var(--sp3) var(--sp4);border-radius:var(--r);margin-bottom:var(--sp2);font-size:var(--sm);line-height:1.7;border-left:3px solid}
.ins-h{background:var(--hit-light);border-color:var(--hit)}
.ins-m{background:var(--miss-light);border-color:var(--miss)}
.ins-n{background:var(--surface-2);border-color:var(--muted)}

.bar-row{display:flex;align-items:center;gap:var(--sp3);margin-bottom:var(--sp2)}
.bar-name{width:160px;font-size:var(--sm);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.bar-track{flex:1;background:var(--surface-2);border-radius:var(--rs);height:18px;overflow:hidden}
.bar-fill{height:100%;border-radius:var(--rs);display:flex;align-items:center;padding:0 var(--sp2);font-family:var(--font-m);font-size:var(--xs);font-weight:700;color:#fff;min-width:22px;font-variant-numeric:tabular-nums}

.fold{cursor:pointer;user-select:none}
.fold::before{content:'';display:inline-block;width:0;height:0;border-left:5px solid var(--muted);border-top:4px solid transparent;border-bottom:4px solid transparent;margin-right:var(--sp2);vertical-align:middle;transition:transform var(--dur) var(--ease)}
.fold.open::before{transform:rotate(90deg)}
.fold-body{display:none;margin-top:var(--sp3);padding:var(--sp4);background:var(--surface-2);border-radius:var(--r);font-size:var(--sm);line-height:1.7;border:1px solid var(--line)}
.fold.open+.fold-body{display:block}

.legend{display:flex;flex-direction:column;gap:var(--sp2)}
.legend-item{display:flex;align-items:center;gap:var(--sp3);font-size:var(--sm)}
.legend-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
.legend-val{font-family:var(--font-m);font-weight:700;margin-left:auto;font-variant-numeric:tabular-nums}

footer.rf{padding:var(--sp6) 0;border-top:1px solid var(--line);text-align:center;font-size:var(--xs);color:var(--muted)}

.vtag{display:inline-flex;align-items:center;gap:var(--sp1);padding:2px 8px;border-radius:var(--rs);font-size:var(--xs);font-weight:500;margin:0 var(--sp1) var(--sp2) 0;line-height:1.5}
.vtag-pos{background:var(--hit-light);color:var(--hit);border:1px solid rgba(5,150,105,.12)}
.vtag-neg{background:var(--miss-light);color:var(--miss);border:1px solid rgba(220,38,38,.12)}
.vtag .vp{font-size:10px;opacity:.5;margin-left:2px}

.pos-bar{display:flex;align-items:center;gap:var(--sp3);padding:var(--sp3) var(--sp4);border-radius:var(--r);border:1px solid var(--line);background:var(--surface)}
.pos-rank{font-family:var(--font-m);font-weight:800;font-size:var(--s4);line-height:1}
.pos-label{font-family:var(--font-d);font-weight:600;font-size:var(--sm);color:var(--text)}
.pos-desc{font-size:var(--xs);color:var(--muted)}
.pos-leading{color:var(--hit)}
.pos-upper{color:var(--accent)}
.pos-mid{color:var(--warn)}
.pos-trailing{color:var(--miss)}

.sa-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp3);align-items:start}
@media(max-width:900px){.sa-grid{grid-template-columns:1fr;}}
.sa-list{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);overflow:hidden}
.sa-list-hd{padding:var(--sp2) var(--sp3);font-family:var(--font-d);font-size:11px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--line);letter-spacing:.02em;text-transform:uppercase}
.sa-row{display:flex;align-items:center;gap:var(--sp2);padding:5px var(--sp3);border-bottom:1px solid var(--surface-2);font-size:var(--sm);transition:background var(--dur) var(--ease)}
.sa-row:hover{background:var(--surface-2)}
.sa-row:last-child{border-bottom:none}
.sa-rank{font-family:var(--font-m);font-weight:700;font-size:var(--xs);color:var(--muted);width:18px;text-align:center;flex-shrink:0}
.sa-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-cnt{font-family:var(--font-m);font-weight:700;font-size:var(--xs);color:var(--accent);width:24px;text-align:right;flex-shrink:0}
.sa-cat{font-size:10px;padding:1px 5px;border-radius:var(--rs);font-weight:500;flex-shrink:0}
.sa-cat-brand{background:var(--hit-light);color:var(--hit)}
.sa-cat-auto{background:#eff6ff;color:#2563eb}
.sa-cat-media{background:#f0fdf4;color:#059669}
.sa-cat-other{background:var(--surface-2);color:var(--muted)}
.sa-article-link{text-decoration:none;color:var(--text);display:block}
.sa-article-link:hover .sa-name{color:var(--accent)}
.sa-cat-bar{display:flex;gap:var(--sp5);justify-content:center;flex-wrap:wrap;margin-top:var(--sp3);padding:var(--sp3)}
.sa-cat-item{display:flex;align-items:center;gap:var(--sp2);font-size:var(--sm)}
.sa-cat-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.sa-cat-pct{font-family:var(--font-m);font-weight:700;font-variant-numeric:tabular-nums}

.summary{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin-bottom:var(--sp5)}
.summary-hd{padding:var(--sp4) var(--sp5);background:var(--accent);color:#fff;font-family:var(--font-d);font-weight:600;font-size:var(--sm);letter-spacing:.02em}
.summary-bd{padding:var(--sp5);font-size:var(--sm);line-height:1.85;color:var(--text)}
.summary-bd p{margin-bottom:var(--sp3)}
.summary-bd p:last-child{margin-bottom:0}
.summary-bd strong{color:var(--text);font-weight:600}
`

function buildHtml({ brand, platformLabels, now, geoStr, mrPct, totalCompleted, navHtml, sectionsHtml, summaryHtml }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="GEO 品牌感知报告 - ${esc(brand)}">
<title>"${esc(brand)}" GEO 品牌感知报告</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<nav class="top" aria-label="报告导航"><div class="inner">${navHtml}</div></nav>
<main class="wrap">
<header class="hero">
  <h1>"${esc(brand)}" GEO 品牌感知报告</h1>
  <div class="sub">${esc(platformLabels)} · ${esc(now)}</div>
</header>
${summaryHtml}
${sectionsHtml}
<footer class="rf">
  <p>GEO 品牌感知分析 · ${esc(platformLabels)} · 共 ${totalCompleted} 条有效回答</p>
  <p style="margin-top:var(--sp1);opacity:.7">提及率=品牌被提及次数/有效回答数 · 排名与情感=AI逐条分析 · 综合得分=提及*40%+排名*30%+情感*30%</p>
</footer>
</main>
<script>
document.querySelectorAll('.fold').forEach(el=>{el.addEventListener('click',()=>el.classList.toggle('open'))});
document.querySelectorAll('.nl').forEach(a=>{a.addEventListener('click',e=>{e.preventDefault();const t=document.querySelector(a.getAttribute('href'));if(t)t.scrollIntoView({behavior:'smooth',block:'start'})})});
</script>
</body>
</html>`
}
