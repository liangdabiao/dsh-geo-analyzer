// GEO 分析逻辑库：确定性分析（提及/域名/矩阵/得分）+ AI 分析合并。
// Node 移植自 geo-analyzer scripts/lib/analyzer.py 与 geo_analyze.py 的合并编排，
// 采纳 plus 版：invalid 状态不计入提及率分母（视为无效样本，不当作「未提及」）。
// 关键词匹配保持大小写不敏感、普通子串计数（与上游一致，含别名）。

// ── 提及检测 ────────────────────────────────────────────────────────────

export function detectMention(text, keywords) {
  const t = String(text || '').toLowerCase()
  if (!t) return { mentioned: false, count: 0 }
  let count = 0
  for (const kw of keywords || []) {
    const k = String(kw || '').toLowerCase()
    if (!k) continue
    count += t.split(k).length - 1
  }
  return { mentioned: count > 0, count }
}

export function detectAllMentions(text, brandKeywords, competitorMap) {
  const brand = detectMention(text, brandKeywords)
  const competitorMentions = {}
  for (const [name, kws] of Object.entries(competitorMap || {})) {
    competitorMentions[name] = detectMention(text, kws).count
  }
  return {
    brand_mentioned: brand.mentioned,
    brand_mention_count: brand.count,
    competitor_mentions: competitorMentions,
  }
}

// ── 域名 ────────────────────────────────────────────────────────────────

export function extractDomain(url) {
  if (!url) return ''
  try {
    const u = new URL(String(url))
    return (u.hostname || String(url).split('/')[0]).replace(/^www\./, '').toLowerCase()
  } catch {
    return String(url).split('/')[0].replace(/^www\./, '').toLowerCase()
  }
}

export function extractDomainsFromSources(sources) {
  const out = []
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s !== 'object') continue
    let domain = s.domain || ''
    if (!domain && s.url) domain = extractDomain(s.url)
    if (domain) out.push(domain)
  }
  return out
}

// 常见多段后缀，用于判断主域名边界（www.gov.cn 类保留三段）
const MULTI_PART_TLDS = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.tw', 'com.mo', 'co.jp', 'co.kr', 'co.uk',
  'com.au', 'com.sg', 'com.my', 'com.br',
])

export function rootDomain(domain) {
  const d = String(domain || '').toLowerCase().trim().replace(/^\.+/, '')
  if (!d || !d.includes('.')) return d
  const parts = d.split('.')
  if (parts.length <= 2) return d
  if (MULTI_PART_TLDS.has(parts.slice(-2).join('.'))) {
    return parts.length >= 3 ? parts.slice(-3).join('.') : d
  }
  return parts.slice(-2).join('.')
}

// 同站点子域合并计数（enterprise.dji.com 与 dji.com 归一）
export function mergeSubdomains(domainCount) {
  const merged = {}
  for (const [domain, count] of Object.entries(domainCount || {})) {
    const root = rootDomain(domain)
    merged[root] = (merged[root] || 0) + count
  }
  return Object.fromEntries(Object.entries(merged).sort((a, b) => b[1] - a[1]))
}

// ── 逐回答确定性分析 ────────────────────────────────────────────────────

// 统计有效样本：completed + invalid 都排除出「未提及」？——上游口径：
//   completed 计入分母；invalid（限流话术）与 failed/timeout/submit_failed 一律排除。
export function isValidSample(r) {
  return r?.status === 'completed'
}

export function computePerAnswerAnalysis(results, brandKeywords, competitorMap) {
  return (results || []).map((r) => {
    if (!isValidSample(r)) {
      return {
        question: r.question || '', query_index: r.query_index || 0, platform: r.platform || '',
        status: r.status || 'unknown',
        brand_mentioned: false, brand_mention_count: 0, competitor_mentions: {}, source_domains: [],
      }
    }
    const mentions = detectAllMentions(r.content || '', brandKeywords, competitorMap)
    return {
      question: r.question || '', query_index: r.query_index || 0, platform: r.platform || '',
      status: 'completed',
      brand_mentioned: mentions.brand_mentioned,
      brand_mention_count: mentions.brand_mention_count,
      competitor_mentions: mentions.competitor_mentions,
      source_domains: extractDomainsFromSources(r.sources),
    }
  })
}

export function buildMentionMatrix(results, queries, platforms, brandKeywords) {
  const matrix = []
  for (let qi = 0; qi < queries.length; qi++) {
    const row = []
    for (const platform of platforms) {
      const cell = { mentioned: false, mention_count: 0, platform, question: queries[qi], status: null }
      const hit = (results || []).find((r) => r.query_index === qi && r.platform === platform && r.status === 'completed')
      if (hit) {
        const m = detectMention(hit.content || '', brandKeywords)
        cell.mentioned = m.mentioned
        cell.mention_count = m.count
        cell.status = 'completed'
      } else {
        const any = (results || []).find((r) => r.query_index === qi && r.platform === platform)
        cell.status = any ? any.status : 'missing'
      }
      row.push(cell)
    }
    matrix.push(row)
  }
  return matrix
}

// ── 聚合指标 ────────────────────────────────────────────────────────────

export function computeAggregateMetrics(perAnswer, queries, platforms, brand, competitors) {
  const brandMentionRate = { overall: 0 }
  for (const p of platforms) brandMentionRate[p] = 0

  let totalCompleted = 0
  let totalMentioned = 0
  const platformStats = {}
  for (const p of platforms) platformStats[p] = { total: 0, mentioned: 0 }

  for (const ans of perAnswer || []) {
    if (ans.status !== 'completed') continue
    const p = ans.platform || ''
    totalCompleted++
    platformStats[p] ??= { total: 0, mentioned: 0 }
    platformStats[p].total++
    if (ans.brand_mentioned) {
      totalMentioned++
      platformStats[p].mentioned++
    }
  }
  brandMentionRate.overall = totalCompleted ? totalMentioned / totalCompleted : 0
  for (const p of platforms) {
    const st = platformStats[p] || { total: 0, mentioned: 0 }
    brandMentionRate[p] = st.total ? st.mentioned / st.total : 0
  }

  // 竞品提及率（确定性关键词口径）
  const competitorMentionRates = {}
  for (const comp of competitors || []) {
    const rates = { overall: 0 }
    for (const p of platforms) rates[p] = 0
    let total = 0, mentioned = 0
    const st = {}
    for (const p of platforms) st[p] = { total: 0, mentioned: 0 }
    for (const ans of perAnswer || []) {
      if (ans.status !== 'completed') continue
      const p = ans.platform || ''
      total++
      st[p] ??= { total: 0, mentioned: 0 }
      st[p].total++
      if ((ans.competitor_mentions || {})[comp] > 0) {
        mentioned++
        st[p].mentioned++
      }
    }
    rates.overall = total ? mentioned / total : 0
    for (const p of platforms) {
      const s = st[p] || { total: 0, mentioned: 0 }
      rates[p] = s.total ? s.mentioned / s.total : 0
    }
    competitorMentionRates[comp] = rates
  }

  // 域名统计（合并子域）
  const domainStats = {}
  const domainStatsByPlatform = {}
  for (const ans of perAnswer || []) {
    if (ans.status !== 'completed') continue
    const p = ans.platform || ''
    for (const d of ans.source_domains || []) {
      domainStats[d] = (domainStats[d] || 0) + 1
      domainStatsByPlatform[p] ??= {}
      domainStatsByPlatform[p][d] = (domainStatsByPlatform[p][d] || 0) + 1
    }
  }
  const domains = mergeSubdomains(domainStats)
  const domainsByPlatform = {}
  for (const p of platforms) domainsByPlatform[p] = mergeSubdomains(domainStatsByPlatform[p] || {})

  return {
    brand_mention_rate: brandMentionRate,
    competitor_mention_rates: competitorMentionRates,
    domain_stats: domains,
    domain_stats_by_platform: domainsByPlatform,
    total_completed: totalCompleted,
    total_mentioned: totalMentioned,
  }
}

// ── AI 分析模板（会话模型填充）──────────────────────────────────────────

export function buildAiAnalysisTemplate(results, brand, competitors) {
  return (results || [])
    .filter((r) => isValidSample(r))
    .map((r) => ({
      question: r.question || '',
      query_index: r.query_index || 0,
      platform: r.platform || '',
      brand,
      competitors: competitors || [],
      brand_rank: null,
      brand_context: '',
      sentiment: 'neutral',
      sentiment_reason: '',
      competitors_mentioned: [],
      competitor_details: [],
      key_claims: [],
    }))
}

// ── 合并 + 高阶指标 ─────────────────────────────────────────────────────

const normSent = (s) => (['positive', 'neutral', 'negative'].includes(s) ? s : 'neutral')

export function mergeAnalysis(deterministic, aiAnalysis) {
  const aiMap = new Map()
  for (const ai of aiAnalysis || []) aiMap.set(`${ai.query_index}|${ai.platform}`, ai)
  return (deterministic || []).map((det) => {
    const ai = aiMap.get(`${det.query_index}|${det.platform}`) || {}
    return {
      question: det.question,
      query_index: det.query_index,
      platform: det.platform,
      status: det.status,
      brand_mentioned: det.brand_mentioned,
      brand_mention_count: det.brand_mention_count,
      competitor_mentions: det.competitor_mentions || {},
      source_domains: det.source_domains || [],
      // 没提到品牌就不该有排名：模型偶尔会给未提及的回答编一个 brand_rank，
      // 那会把「平均排名」和 GEO 得分一起抬高（0% 提及却拿 60 分）。
      brand_rank: det.brand_mentioned ? ai.brand_rank ?? null : null,
      brand_context: ai.brand_context || '',
      sentiment: normSent(ai.sentiment),
      sentiment_reason: ai.sentiment_reason || '',
      ai_competitors_mentioned: ai.competitors_mentioned || [],
      competitor_details: ai.competitor_details || [],
      key_claims: ai.key_claims || [],
    }
  })
}

export function computeSentimentDistribution(merged, platforms) {
  const dist = { overall: { positive: 0, neutral: 0, negative: 0 } }
  for (const p of platforms) dist[p] = { positive: 0, neutral: 0, negative: 0 }
  for (const r of merged || []) {
    if (r.status !== 'completed') continue
    const s = normSent(r.sentiment)
    dist.overall[s]++
    if (dist[r.platform]) dist[r.platform][s]++
  }
  return dist
}

export function computeBrandAvgRank(merged, platforms) {
  const ranks = { overall: [] }
  for (const p of platforms) ranks[p] = []
  for (const r of merged || []) {
    if (r.status !== 'completed') continue
    if (!r.brand_mentioned) continue // 未提及品牌的回答不参与平均排名（口径见 mergeAnalysis）
    const rank = Number(r.brand_rank)
    if (Number.isFinite(rank) && rank > 0) {
      ranks.overall.push(rank)
      if (ranks[r.platform]) ranks[r.platform].push(rank)
    }
  }
  const out = {}
  for (const [key, values] of Object.entries(ranks)) {
    out[key] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  }
  return out
}

// 竞品平均排名 + 情绪分布（显式 rank 优先，缺失时按 ai_competitors_mentioned 位置推断隐式排名）
export function computeCompetitorMetrics(merged, platforms, allCompetitors) {
  const result = {}
  const nameMatch = (a, b) => {
    const x = String(a || '').toLowerCase()
    const y = String(b || '').toLowerCase()
    return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)))
  }
  for (const comp of allCompetitors || []) {
    const ranks = { overall: [] }
    const sentiment = { overall: { positive: 0, neutral: 0, negative: 0 } }
    for (const p of platforms) {
      ranks[p] = []
      sentiment[p] = { positive: 0, neutral: 0, negative: 0 }
    }
    for (const r of merged || []) {
      if (r.status !== 'completed') continue
      const p = r.platform || ''
      const details = Array.isArray(r.competitor_details) ? r.competitor_details : []
      const aiMentioned = Array.isArray(r.ai_competitors_mentioned) ? r.ai_competitors_mentioned : []

      let matchedInDetails = false
      let gotRank = false
      for (const d of details) {
        if (!d || typeof d !== 'object') continue
        if (!nameMatch(d.name, comp)) continue
        matchedInDetails = true
        const rank = Number(d.rank)
        if (Number.isFinite(rank) && rank > 0) {
          ranks.overall.push(rank)
          if (ranks[p]) ranks[p].push(rank)
          gotRank = true
        }
        const s = normSent(d.sentiment)
        sentiment.overall[s]++
        if (sentiment[p]) sentiment[p][s]++
      }

      if (!gotRank) {
        const idx = aiMentioned.findIndex((n) => typeof n === 'string' && nameMatch(n, comp))
        if (idx !== -1) {
          const implicit = idx + 1
          ranks.overall.push(implicit)
          if (ranks[p]) ranks[p].push(implicit)
          if (!matchedInDetails) {
            sentiment.overall.neutral++
            if (sentiment[p]) sentiment[p].neutral++
          }
        }
      }
    }
    const avgRank = {}
    for (const [key, values] of Object.entries(ranks)) {
      avgRank[key] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
    }
    result[comp] = { avg_rank: avgRank, sentiment }
  }
  return result
}

// GEO 综合得分 = 提及率×100×40% + max(0,100-(均排名-1)×10)×30% + (1-负面率)×100×30%
export function computeGeoScore(mentionRate, avgRank, sentimentDist, maxRank = 10) {
  const mentionScore = mentionRate * 100
  const rankScore = Number.isFinite(Number(avgRank)) && Number(avgRank) > 0
    ? Math.max(0, 100 - (Number(avgRank) - 1) * 100 / maxRank)
    : 0
  const total = Object.values(sentimentDist || {}).reduce((a, b) => a + b, 0)
  const sentimentScore = total > 0
    ? Math.max(0, Math.min(100, (1 - (sentimentDist.negative || 0) / total) * 100))
    : 50
  return Math.round((mentionScore * 0.4 + rankScore * 0.3 + sentimentScore * 0.3) * 10) / 10
}

// ── 完整分析（geo_analyze.py Phase 3 的单入口移植）───────────────────────
/**
 * @param searchData getSearchResults() 的完整 JSON
 * @param opts { brand, aliases, competitors, aiAnalysis }
 * @returns analysis_result（含 per_answer / metrics / matrix / sentiment / geo_score / competitor_comparison）
 */
export function runFullAnalysis(searchData, { brand, aliases = [], competitors = [], aiAnalysis = [] } = {}) {
  const results = searchData?.results || []
  const queries = searchData?.queries || []
  const platforms = searchData?.platforms || []
  const brandKeywords = [brand, ...aliases].filter(Boolean)
  const competitorMap = Object.fromEntries((competitors || []).map((c) => [c, [c]]))

  const perAnswer = computePerAnswerAnalysis(results, brandKeywords, competitorMap)
  const metrics = computeAggregateMetrics(perAnswer, queries, platforms, brand, competitors)
  const mentionMatrix = buildMentionMatrix(results, queries, platforms, brandKeywords)

  const merged = mergeAnalysis(perAnswer, aiAnalysis)
  const sentimentDist = computeSentimentDistribution(merged, platforms)
  const brandAvgRank = computeBrandAvgRank(merged, platforms)

  // 竞品全集 = 用户指定 + AI 发现
  const allCompetitors = new Set(competitors || [])
  for (const ai of aiAnalysis || []) {
    for (const c of ai.competitors_mentioned || []) if (c) allCompetitors.add(c)
  }

  const competitorMetrics = computeCompetitorMetrics(merged, platforms, allCompetitors)

  const geoScore = { overall: computeGeoScore(metrics.brand_mention_rate.overall, brandAvgRank.overall, sentimentDist.overall) }
  for (const p of platforms) {
    geoScore[p] = computeGeoScore(metrics.brand_mention_rate[p] ?? 0, brandAvgRank[p], sentimentDist[p] || { positive: 0, neutral: 0, negative: 0 })
  }

  // 竞品提及率（覆盖 AI 发现任品：确定性关键词 + AI 模糊匹配）
  const nameMatch = (a, b) => {
    const x = String(a || '').toLowerCase()
    const y = String(b || '').toLowerCase()
    return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)))
  }
  const competitorComparison = []
  for (const comp of [...allCompetitors].sort()) {
    let total = 0, hit = 0
    const pStats = {}
    for (const p of platforms) pStats[p] = { t: 0, h: 0 }
    for (const ans of merged) {
      if (ans.status !== 'completed') continue
      const p = ans.platform || ''
      total++
      pStats[p] ??= { t: 0, h: 0 }
      pStats[p].t++
      const detCount = (ans.competitor_mentions || {})[comp] || 0
      let aiHit = false
      if (!detCount) {
        for (const c of ans.ai_competitors_mentioned || []) {
          if (nameMatch(c, comp)) { aiHit = true; break }
        }
      }
      if (detCount > 0 || aiHit) {
        hit++
        pStats[p].h++
      }
    }
    const byRate = (p) => (pStats[p]?.t ? pStats[p].h / pStats[p].t : 0)
    const rates = { overall: total ? hit / total : 0 }
    for (const p of platforms) rates[p] = byRate(p)

    const m = competitorMetrics[comp] || {}
    const sentOverall = m.sentiment?.overall || { positive: 0, neutral: 0, negative: 0 }
    const sentTotal = sentOverall.positive + sentOverall.neutral + sentOverall.negative
    competitorComparison.push({
      name: comp,
      mention_rate_overall: rates.overall,
      mention_rate_by_platform: Object.fromEntries(platforms.map((p) => [p, rates[p]])),
      avg_rank: m.avg_rank?.overall ?? null,
      positive_pct: sentTotal ? sentOverall.positive / sentTotal : 0,
      negative_pct: sentTotal ? sentOverall.negative / sentTotal : 0,
      sentiment_dist: sentOverall,
    })
  }
  competitorComparison.sort((a, b) => b.mention_rate_overall - a.mention_rate_overall)

  return {
    brand,
    aliases,
    competitors: competitors || [],
    discovered_competitors: [...allCompetitors].filter((c) => !(competitors || []).includes(c)).sort(),
    all_competitors: [...allCompetitors].sort(),
    platforms,
    queries,
    per_answer: merged,
    metrics,
    mention_matrix: mentionMatrix,
    sentiment_distribution: sentimentDist,
    brand_avg_rank: brandAvgRank,
    geo_score: geoScore,
    competitor_comparison: competitorComparison,
    competitor_metrics: competitorMetrics,
  }
}
