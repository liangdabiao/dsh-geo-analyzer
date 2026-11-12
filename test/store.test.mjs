// store + search + report 单测：runs 生命周期、状态只进不退、AI 分析分批合并、报告生成
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateReportHtml } from '../lib/report.js'
import { classifyDomain } from '../lib/report.js'
import { runFullAnalysis } from '../lib/analyzer.js'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-geo-store-'))
process.env.DSH_HOME = tmp

const {
  createRun, getMeta, patchMeta, listRuns, saveQueries, saveSearchResults, getSearchResults,
  saveAiAnalysis, getAiAnalysis, saveAnalysisResult, saveReport, readReport, deleteRun,
  getSettings, saveSettings, publicMeta, DATA_DIR,
} = await import('../lib/store.js')

test('settings：保存与读取', () => {
  const next = saveSettings({ api_key: 'ak_abc', proxy_url: 'http://127.0.0.1:7890' })
  assert.equal(next.api_key, 'ak_abc')
  assert.equal(getSettings().api_key, 'ak_abc')
})

test('runs：创建/查询列表/问题保存/非法 runId', () => {
  const meta = createRun({ brand: '元气森林', category: '无糖饮料', aliases: ['Genki'], competitors: ['农夫山泉'], platforms: ['doubao', 'kimi'] })
  assert.ok(meta.run_id.includes('-元气森林'))
  assert.equal(getMeta(meta.run_id).brand, '元气森林')
  assert.equal(DATA_DIR, join(tmp, 'geo-analyzer'))
  assert.equal(listRuns()[0].run_id, meta.run_id)

  const updated = saveQueries(meta.run_id, ['无糖饮料哪个品牌好？', '  ', '经常熬夜喝什么饮料好？'])
  assert.deepEqual(updated.queries, ['无糖饮料哪个品牌好？', '经常熬夜喝什么饮料好？'])
  assert.throws(() => saveQueries(meta.run_id, []), /问题列表为空/)
  assert.throws(() => getMeta('../escape'), /非法|不存在|运行/)
  assert.equal(listRuns().length, 1)
})

test('runs：状态只进不退（并发保护）', () => {
  const m = createRun({ brand: 'X', category: 'Y', platforms: ['doubao'] })
  patchMeta(m.run_id, { status: 'searched' })
  const rolled = patchMeta(m.run_id, { status: 'created' }) // 试图回退 → 保留 searched
  assert.equal(rolled.status, 'searched')
  const forced = patchMeta(m.run_id, { status: 'created', forceStatus: true })
  assert.equal(forced.status, 'created')
  assert.equal(publicMeta(forced).run_id, m.run_id)
})

test('搜索结果与 AI 分析：分批合并按 query_index|platform 覆盖', () => {
  const m = createRun({ brand: 'B', category: 'C', platforms: ['doubao'] })
  saveSearchResults(m.run_id, { queries: ['q'], platforms: ['doubao'], total_tasks: 1, completed: 1, failed: 0, results: [{ question: 'q', query_index: 0, platform: 'doubao', content: 'c', sources: [], status: 'completed' }] })
  assert.equal(getSearchResults(m.run_id).completed, 1)

  saveAiAnalysis(m.run_id, [{ query_index: 0, platform: 'doubao', sentiment: 'neutral' }])
  saveAiAnalysis(m.run_id, [{ query_index: 0, platform: 'doubao', sentiment: 'positive' }]) // 覆盖同键
  saveAiAnalysis(m.run_id, [{ query_index: 0, platform: 'kimi', sentiment: 'negative' }]) // 新键
  const all = getAiAnalysis(m.run_id)
  assert.equal(all.length, 2)
  assert.equal(all.find((e) => e.platform === 'doubao').sentiment, 'positive')
})

test('报告：生成/读取/删除', () => {
  const m = createRun({ brand: '元气森林', category: '无糖饮料', aliases: [], competitors: ['农夫山泉'], platforms: ['doubao', 'kimi'] })
  const searchData = {
    queries: ['无糖饮料哪个品牌好？'],
    platforms: ['doubao', 'kimi'],
    results: [
      { question: '无糖饮料哪个品牌好？', query_index: 0, platform: 'doubao', content: '元气森林是头部品牌，市占率领先，口感清爽。', sources: [{ title: '知乎', url: 'https://www.zhihu.com/a', domain: 'zhihu.com' }], status: 'completed' },
      // Kimi 现实形态：完成但只有内联引用、无外链 → 触发「数据完整性提示」
      { question: '无糖饮料哪个品牌好？', query_index: 0, platform: 'kimi', content: '推荐元气森林，市占率领先，是无糖气泡水的代表品牌之一，口感清爽受年轻人喜爱。', sources: [], sources_note: '该平台未返回可解析的外链信源（常见于 Kimi 的内联引用），信源板块数据不完整不代表官网未被引用。', status: 'completed' },
    ],
  }
  const ai = [{ query_index: 0, platform: 'doubao', brand_rank: 1, brand_context: '头部品牌', sentiment: 'positive', sentiment_reason: '市占率领先', competitors_mentioned: ['农夫山泉'], competitor_details: [{ name: '农夫山泉', rank: 2, sentiment: 'neutral' }], key_claims: ['市占率领先'] }]
  saveSearchResults(m.run_id, searchData)
  const analysis = runFullAnalysis(searchData, { brand: m.brand, aliases: [], competitors: ['农夫山泉'], aiAnalysis: ai })
  saveAnalysisResult(m.run_id, analysis)

  const html = generateReportHtml(analysis, searchData)
  assert.ok(html.includes('GEO 品牌感知报告'))
  assert.ok(html.includes('元气森林'))
  assert.ok(html.includes('报告摘要'))
  assert.ok(html.includes('提及矩阵'))
  assert.ok(html.includes('数据完整性提示')) // kimi invalid → 覆盖度提示
  assert.ok(!html.includes('undefined'))
  assert.ok(!html.includes('[object Object]'))

  const file = saveReport(m.run_id, html)
  assert.ok(existsSync(file))
  assert.equal(readReport(m.run_id), file)
  assert.ok(readFileSync(file, 'utf8').includes('竞品对比'))

  assert.equal(deleteRun(m.run_id).ok, true)
  assert.equal(getMeta(m.run_id), null)
  assert.ok(!listRuns().some((r) => r.run_id === m.run_id))
  assert.equal(deleteRun(m.run_id).ok, false) // 再删幂等返回 false
})

test('classifyDomain：品牌词动态命中官网分类', () => {
  assert.equal(classifyDomain('dji.com', ['大疆', 'DJI']), '品牌官网') // 别名给拉丁名可命中
  assert.equal(classifyDomain('www.zhihu.com', ['元气森林']), '社媒资讯') // 纯中文品牌名匹配不到域名，归社媒
  assert.equal(classifyDomain('autohome.com.cn', []), '汽车垂直')
  assert.equal(classifyDomain('example.org', []), '其他网站')
})

test.after(() => rmSync(tmp, { recursive: true, force: true }))
