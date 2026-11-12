// analyzer 单测：提及检测/域名归并/矩阵/得分/合并（口径对齐上游 analyzer.py）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectMention, detectAllMentions, rootDomain, mergeSubdomains, extractDomainsFromSources,
  computePerAnswerAnalysis, buildMentionMatrix, computeAggregateMetrics, buildAiAnalysisTemplate,
  mergeAnalysis, computeSentimentDistribution, computeBrandAvgRank, computeCompetitorMetrics,
  computeGeoScore, runFullAnalysis,
} from '../lib/analyzer.js'

test('detectMention：大小写不敏感、别名合计计数', () => {
  assert.deepEqual(detectMention('元气森林真好喝', ['元气森林']), { mentioned: true, count: 1 })
  assert.deepEqual(detectMention('Genki Forest and 元气森林', ['genki forest', '元气森林']), { mentioned: true, count: 2 })
  assert.deepEqual(detectMention('无关内容', ['元气森林']), { mentioned: false, count: 0 })
  assert.deepEqual(detectMention('', ['x']), { mentioned: false, count: 0 })
})

test('detectAllMentions：品牌与竞品分开计数', () => {
  const m = detectAllMentions('元气森林 vs 农夫山泉 vs 元气森林', ['元气森林'], { 农夫山泉: ['农夫山泉'] })
  assert.equal(m.brand_mentioned, true)
  assert.equal(m.brand_mention_count, 2)
  assert.equal(m.competitor_mentions['农夫山泉'], 1)
})

test('rootDomain/mergeSubdomains：多段后缀与子域合并', () => {
  assert.equal(rootDomain('enterprise.dji.com'), 'dji.com')
  assert.equal(rootDomain('www.gov.cn'), 'www.gov.cn')
  assert.equal(rootDomain('dji.com'), 'dji.com')
  const merged = mergeSubdomains({ 'm.it168.com': 2, 'digital.it168.com': 1, 'zhihu.com': 3 })
  assert.deepEqual(merged, { 'it168.com': 3, 'zhihu.com': 3 })
})

test('extractDomainsFromSources：domain 缺失时从 url 兜底', () => {
  const out = extractDomainsFromSources([{ domain: 'a.com' }, { url: 'https://www.b.com/x' }, 'junk', {}])
  assert.deepEqual(out, ['a.com', 'b.com'])
})

const mkResult = (qi, platform, content, sources = [], status = 'completed') => ({
  question: `Q${qi + 1}`, query_index: qi, platform, content, sources, status,
})

test('computePerAnswerAnalysis：failed 不计入、completed 全量分析', () => {
  const results = [
    mkResult(0, 'doubao', '推荐元气森林', [{ url: 'https://a.com/1', title: 'x' }]),
    mkResult(0, 'kimi', '元气森林不错', [], 'timeout'),
  ]
  const per = computePerAnswerAnalysis(results, ['元气森林'], {})
  assert.equal(per[0].brand_mentioned, true)
  assert.equal(per[0].status, 'completed')
  assert.deepEqual(per[0].source_domains, ['a.com'])
  assert.equal(per[1].brand_mentioned, false)
  assert.equal(per[1].status, 'timeout')
})

test('computeAggregateMetrics：提及率分母只含 completed', () => {
  const results = [
    mkResult(0, 'doubao', '元气森林'),
    mkResult(0, 'kimi', '元气森林', [], 'timeout'),
    mkResult(0, 'deepseek', '没有别的'),
  ]
  const per = computePerAnswerAnalysis(results, ['元气森林'], {})
  const m = computeAggregateMetrics(per, ['Q1'], ['doubao', 'kimi', 'deepseek'], '元气森林', [])
  assert.equal(m.total_completed, 2)
  assert.equal(m.total_mentioned, 1)
  assert.equal(m.brand_mention_rate.overall, 0.5)
  assert.equal(m.brand_mention_rate.doubao, 1)
  assert.equal(m.brand_mention_rate.kimi, 0) // timeout 平台无有效样本 → 0
})

test('buildMentionMatrix：提及/未提及/失败三态', () => {
  const results = [
    mkResult(0, 'doubao', '元气森林第一'),
    mkResult(0, 'kimi', '别的品牌'),
    mkResult(0, 'deepseek', '', [], 'failed'),
  ]
  const matrix = buildMentionMatrix(results, ['Q1'], ['doubao', 'kimi', 'deepseek'], ['元气森林'])
  assert.equal(matrix[0][0].mentioned, true)
  assert.equal(matrix[0][1].mentioned, false)
  assert.equal(matrix[0][2].status, 'failed')
})

test('mergeAnalysis + 情绪/排名分布', () => {
  const per = computePerAnswerAnalysis([
    mkResult(0, 'doubao', '元气森林'),
    mkResult(0, 'kimi', '元气森林'),
  ], ['元气森林'], {})
  const ai = [
    { query_index: 0, platform: 'doubao', brand_rank: 1, sentiment: 'positive', competitor_details: [{ name: '农夫山泉', rank: 2, sentiment: 'neutral' }], competitors_mentioned: ['农夫山泉'] },
    { query_index: 0, platform: 'kimi', sentiment: 'negative', brand_rank: null },
  ]
  const merged = mergeAnalysis(per, ai)
  const dist = computeSentimentDistribution(merged, ['doubao', 'kimi'])
  assert.deepEqual(dist.overall, { positive: 1, neutral: 0, negative: 1 })
  assert.deepEqual(dist.doubao, { positive: 1, neutral: 0, negative: 0 })
  const ranks = computeBrandAvgRank(merged, ['doubao', 'kimi'])
  assert.equal(ranks.overall, 1)
  assert.equal(ranks.kimi, null)
})

test('computeCompetitorMetrics：显式 rank 优先，缺失按提及列表推断', () => {
  const merged = [
    {
      status: 'completed', platform: 'doubao',
      competitor_details: [{ name: '农夫山泉', rank: 2, sentiment: 'positive' }],
      ai_competitors_mentioned: ['农夫山泉', '可口可乐'],
    },
  ]
  const m = computeCompetitorMetrics(merged, ['doubao'], ['农夫山泉', '可口可乐'])
  assert.equal(m['农夫山泉'].avg_rank.overall, 2)
  assert.equal(m['农夫山泉'].sentiment.overall.positive, 1)
  assert.equal(m['可口可乐'].avg_rank.overall, 2) // 列表第 2 位 → 隐式 rank 2
  assert.equal(m['可口可乐'].sentiment.overall.neutral, 1) // 隐式分支补中性
})

test('未提及品牌的回答不参与平均排名（防模型瞎给 rank 抬高得分）', () => {
  // 回答里没有品牌名 → 即使模型给了 brand_rank，也要丢掉
  const per = computePerAnswerAnalysis([
    mkResult(0, 'doubao', '推荐农夫山泉和可口可乐'),
    mkResult(0, 'kimi', '没有提到任何饮料品牌'),
  ], ['元气森林'], {})
  const ai = [
    { query_index: 0, platform: 'doubao', brand_rank: 1, sentiment: 'positive' },
    { query_index: 0, platform: 'kimi', brand_rank: 2, sentiment: 'positive' },
  ]
  const merged = mergeAnalysis(per, ai)
  assert.equal(merged[0].brand_rank, null)
  assert.equal(merged[1].brand_rank, null)
  const ranks = computeBrandAvgRank(merged, ['doubao', 'kimi'])
  assert.equal(ranks.overall, null)
  // 提及率 0 + 平均排名 null → 30 分（只有情绪分），不会因为假排名变成 60
  assert.equal(computeGeoScore(0, null, { positive: 2, neutral: 0, negative: 0 }), 30)
})

test('computeGeoScore：加权与边界', () => {
  // 提及率 1.0、平均排名 1、无负面 → 40 + 30 + 30 = 100
  assert.equal(computeGeoScore(1, 1, { positive: 3, neutral: 1, negative: 0 }), 100)
  // 全未提及 → 0*0.4 + 0*0.3 + 100*0.3 = 30
  assert.equal(computeGeoScore(0, null, { positive: 0, neutral: 2, negative: 0 }), 30)
  // 有负面按负面率扣
  const half = computeGeoScore(1, 1, { positive: 1, neutral: 0, negative: 1 })
  assert.equal(half, 85) // 40 + 30 + 15
})

test('buildAiAnalysisTemplate：只为 completed 生成', () => {
  const results = [mkResult(0, 'doubao', 'x'), mkResult(0, 'kimi', '', [], 'failed')]
  const t = buildAiAnalysisTemplate(results, '品牌', ['竞品'])
  assert.equal(t.length, 1)
  assert.equal(t[0].platform, 'doubao')
})

test('runFullAnalysis：端到端（含 AI 发现竞品 + competitor_comparison 排序）', () => {
  const searchData = {
    queries: ['无糖饮料哪个好'],
    platforms: ['doubao', 'kimi'],
    results: [
      mkResult(0, 'doubao', '元气森林、农夫山泉、可口可乐都值得考虑，元气森林气泡口感领先', [
        { url: 'https://www.zhihu.com/a', title: 'z' }, { url: 'https://yuanqisenlin.com/b', title: '官网' },
      ]),
      mkResult(0, 'kimi', '推荐农夫山泉和可乐', [], 'timeout'),
    ],
  }
  const aiAnalysis = [{
    query_index: 0, platform: 'doubao',
    brand_rank: 1, brand_context: '气泡口感领先', sentiment: 'positive',
    sentiment_reason: '口感领先', competitors_mentioned: ['农夫山泉', '可口可乐'],
    competitor_details: [{ name: '农夫山泉', rank: 2, sentiment: 'neutral' }, { name: '可口可乐', rank: 3, sentiment: 'neutral' }],
    key_claims: ['气泡口感领先'],
  }]
  const out = runFullAnalysis(searchData, { brand: '元气森林', aliases: [], competitors: [], aiAnalysis })
  assert.equal(out.per_answer.length, 2)
  assert.equal(out.geo_score.overall, 100) // 提及 100%、排名 1、全正面
  assert.deepEqual(out.discovered_competitors, ['农夫山泉', '可口可乐']) // AI 发现任品并入
  assert.ok(out.all_competitors.includes('农夫山泉'))
  const comp = out.competitor_comparison.find((c) => c.name === '农夫山泉')
  assert.equal(comp.mention_rate_overall, 1) // 唯一有效回答里被提及
  assert.ok(out.metrics.domain_stats['zhihu.com'] >= 1)
  // 官网域名按品牌词动态归类（report.js 侧）
})

test('runFullAnalysis：invalid 不计入分母', () => {
  const searchData = {
    queries: ['Q'], platforms: ['doubao', 'kimi', 'deepseek'],
    results: [
      mkResult(0, 'doubao', '元气森林'),
      mkResult(0, 'kimi', '高峰期算力紧张，请稍后再试', [], 'invalid'),
      mkResult(0, 'deepseek', '没有'),
    ],
  }
  const out = runFullAnalysis(searchData, { brand: '元气森林', aliases: [], competitors: [] })
  assert.equal(out.metrics.total_completed, 2)
  assert.equal(out.metrics.brand_mention_rate.overall, 0.5)
  assert.equal(out.per_answer.find((a) => a.platform === 'kimi').status, 'invalid')
})
