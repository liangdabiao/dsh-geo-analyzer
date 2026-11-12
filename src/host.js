// GEO 品牌雷达 · Host 半边（geo_analyzer 原生工具 + geo-analyzer 技能提供方 + 硬规则注入 + 面板数据面）。
// 提问调度/确定性分析/HTML 报告是纯数据操作由工具完成；情绪与排名分析由会话模型按
// geo-analyzer 技能执行（read_answers 读回答 → ai_save 存结论）。
import Schema from '@deepseek-ai/schemastery'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from '../lib/skills.js'
import { systemSection } from './systemPrompt.js'
import { registerApi } from '../lib/api.js'
import { PLATFORM_KEYS, resolveApiKey, resolveApiBase, PLATFORMS } from '../lib/redfox.js'
import { startSearch, progressOf } from '../lib/search.js'
import { runFullAnalysis, buildAiAnalysisTemplate } from '../lib/analyzer.js'
import { generateReportHtml } from '../lib/report.js'
import {
  createRun, getMeta, patchMeta, listRuns, saveQueries, getSearchResults, saveAiAnalysis,
  getAiAnalysis, saveAnalysisResult, saveReport, deleteRun, getSettings, publicMeta,
} from '../lib/store.js'

export const name = 'geo-analyzer' // = cordis.patch.yml 的 id

export const inject = ['tools', 'skills', 'systemPrompt', 'webServer', 'connection']

export const Config = Schema.object({
  injectRules: Schema.boolean().default(true).description('注入 GEO 分析工作流到系统提示'),
  apiKey: Schema.string().default('').description('RedFox API Key（ak_ 开头；留空读面板设置或环境变量 REDFOX_API_KEY）'),
  proxyUrl: Schema.string().default('').description('HTTP(S) 代理（访问 redfox.hk 用），留空直连'),
})

function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  for (const key of Object.keys(args || {})) {
    if (!spec.properties || !(key in spec.properties)) problems.push(`未知参数 ${key}`)
  }
  if (problems.length) throw new Error(`参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '可选：进度/问题/回答/指标明细' },
    },
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary),
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

const MAX_TEXT = 58000
const PER_ANSWER_CHARS = 2200 // read_answers 单条回答截断长度（足够情绪/排名分析）

function parseJsonArray(input, field) {
  if (input === undefined || input === null || input === '') return []
  let v
  try {
    v = JSON.parse(input)
  } catch {
    throw new Error(`${field} 不是合法 JSON 数组（示例：["甲","乙"]）。`)
  }
  if (!Array.isArray(v)) throw new Error(`${field} 必须是 JSON 数组。`)
  return v.map(String).map((s) => s.trim()).filter(Boolean)
}

// runId 缺省解析为最新一次运行
function resolveRun(runId) {
  if (runId) {
    const meta = getMeta(runId)
    if (!meta) throw new Error(`运行不存在：${runId}。用 history 查看已有运行。`)
    return meta
  }
  const [latest] = listRuns({ limit: 1 })
  if (!latest) throw new Error('还没有分析运行。先 create 创建（品牌名+品类必填）。')
  return getMeta(latest.run_id)
}

// 搜索参数（工具与面板共用一份）
function searchOpts(config) {
  const settings = getSettings()
  const apiKey = resolveApiKey({ settings, config })
  return {
    apiKey,
    apiBase: resolveApiBase({ settings }),
    proxyUrl: config?.proxyUrl || settings.proxy_url || '',
  }
}

// ---------------------------------------------------------------------------
// 工具：geo_analyzer —— 建运行 / 问题 / 搜索 / 读回答 / AI 分析存档 / 报告 / 历史
// ---------------------------------------------------------------------------
export const geoAnalyzerTool = {
  name: 'geo_analyzer',
  description:
    'GEO 品牌雷达档案库：向豆包/Kimi/DeepSeek/元宝/千问/百度 六大 AI 搜索引擎批量提问，' +
    '分析品牌提及率、排名、情绪、信源引用、竞品对比，生成交互式 HTML 报告与侧栏看板。' +
    '流程：create 建运行（追问品类）→ 生成 5 个问题并经用户确认 → queries_save → search 后台批量搜索（3-5 分钟，status 查进度）→ ' +
    'read_answers 读回答 → 按 geo-analyzer 技能逐条分析情绪/排名 → ai_save 存档 → report 生成报告。' +
    '情绪与排名分析由你完成（工具不调外部 LLM）；需要 RedFox API Key（面板「设置」页或环境变量 REDFOX_API_KEY）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('create 建运行；queries_save 存问题；search 启动搜索；status 进度；read_answers 读回答；ai_save 存 AI 分析；report 生成报告；history 历史', {
        enum: ['create', 'queries_save', 'search', 'status', 'read_answers', 'ai_save', 'report', 'history'],
      }),
      brand: str('create：品牌名（必填），如「元气森林」'),
      category: str('create：品类/行业（必填），如「无糖饮料」。用户没说就先追问，不要瞎猜'),
      aliasesJson: str('create：品牌别名 JSON 数组，如 ["RED"]（小红书的别名）'),
      competitorsJson: str('create：已知竞品 JSON 数组，如 ["可口可乐","百事可乐"]；可为空'),
      platforms: str('create/search：平台逗号分隔，默认全部六平台 doubao,kimi,deepseek,yuanbao,qianwen,baidu'),
      queriesJson: str('create/queries_save：问题列表 JSON 数组（5 个左右；所有问题不得含品牌名，除非是评价类）'),
      runId: str('除 create 外所有 action：目标运行 id；缺省=最新一次运行'),
      queryIndex: str('read_answers：只读第几个问题（0 起）的回答；缺省=全部'),
      platform: str('read_answers：只读某平台的回答'),
      limit: str('read_answers：最多返回几条回答，默认 12'),
      analysisJson: str('ai_save：AI 分析结果 JSON 数组（每条含 query_index/platform/brand_rank/brand_context/sentiment/sentiment_reason/competitors_mentioned/competitor_details/key_claims）'),
    },
  },
  output: OUTPUT,
  async execute(args, ctxConfig) {
    check(args, this.parameters)
    const cfg = ctxConfig || {}

    // ── create ───────────────────────────────────────────────────────────
    if (args.action === 'create') {
      if (!args.brand) throw new Error('create 需要 brand（品牌名）。')
      if (!args.category) throw new Error('create 需要 category（品类/行业）。用户只给了品牌名时必须先追问品类，这是生成问题的前提。')
      let platforms = args.platforms
        ? String(args.platforms).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
        : PLATFORM_KEYS
      const bad = platforms.filter((p) => !PLATFORM_KEYS.includes(p))
      if (bad.length) throw new Error(`未知平台：${bad.join(',')}（可选：${PLATFORM_KEYS.join(',')}）`)
      const queries = parseJsonArray(args.queriesJson, 'queriesJson')
      const meta = createRun({
        brand: String(args.brand).trim(),
        category: String(args.category).trim(),
        aliases: parseJsonArray(args.aliasesJson, 'aliasesJson'),
        competitors: parseJsonArray(args.competitorsJson, 'competitorsJson'),
        platforms,
        queries,
      })
      const next = queries.length
        ? `运行已创建（runId=${meta.run_id}），问题列表已带入。下一步：向用户确认问题列表（可增删改），确认后 queries_save 覆盖保存，再 search。`
        : `运行已创建（runId=${meta.run_id}）。下一步：生成 5 个问题（推荐类≥1，多场景+功能类合计≥4；一律不带品牌名；10-30 字），展示给用户确认后 queries_save 保存。`
      return result(true, next, `品牌：${meta.brand}｜品类：${meta.category}｜别名：${meta.aliases.join('、') || '—'}｜竞品：${meta.competitors.join('、') || '—'}｜平台：${meta.platforms.map((p) => PLATFORMS[p].label).join('、')}`)
    }

    // ── queries_save ─────────────────────────────────────────────────────
    if (args.action === 'queries_save') {
      const meta = resolveRun(args.runId)
      const queries = parseJsonArray(args.queriesJson, 'queriesJson')
      if (!queries.length) throw new Error('queries_save 需要 queriesJson（问题列表 JSON 数组）。')
      if (queries.length > 12) throw new Error(`问题太多（${queries.length} 个）。建议 5 个（最多 12），否则任务量与耗时翻倍。`)
      const brandKw = [meta.brand, ...meta.aliases]
      const leaked = queries.filter((q) => brandKw.some((k) => q.toLowerCase().includes(String(k).toLowerCase())))
      const updated = saveQueries(meta.run_id, queries)
      return result(true,
        `已保存 ${updated.queries.length} 个问题（${updated.queries.length}×${updated.platforms.length}=${updated.queries.length * updated.platforms.length} 个任务）。下一步：search 启动批量搜索（预计 3-5 分钟）。${leaked.length ? `⚠ 有 ${leaked.length} 个问题包含品牌词「${meta.brand}」，这会让 AI 知道在测谁、结果偏乐观——除非用户明确要求评价类问题，建议改写后重新 queries_save。` : ''}`,
        updated.queries.map((q, i) => `${i + 1}. ${q}`).join('\n'))
    }

    // ── search ───────────────────────────────────────────────────────────
    if (args.action === 'search') {
      const meta = resolveRun(args.runId)
      if (!meta.queries.length) throw new Error('该运行还没有问题列表。先 queries_save。')
      const opts = searchOpts(cfg)
      if (!opts.apiKey) {
        return result(false, '未配置 RedFox API Key。请用户到面板「GEO 品牌雷达 → 设置」填入，或在插件配置/环境变量 REDFOX_API_KEY 里配置（获取：https://redfox.hk/settings/api-keys?source=github）。')
      }
      const r = startSearch(meta.run_id, { ...opts, queries: meta.queries, platforms: meta.platforms })
      if (!r.ok) return result(false, r.error)
      return result(true, `已提交 ${r.total} 个搜索任务（${meta.queries.length} 问题 × ${meta.platforms.length} 平台），后台执行中，预计 3-5 分钟。期间不要空转：等 30-60 秒再 status 查进度；全部完成后 read_answers 读回答做情绪/排名分析。部分平台超时属常见现象，完成的回答够分析就用。`)
    }

    // ── status ───────────────────────────────────────────────────────────
    if (args.action === 'status') {
      const meta = resolveRun(args.runId)
      const prog = progressOf(meta.run_id, meta)
      const lines = [
        `运行 ${meta.run_id}（品牌 ${meta.brand}，状态 ${meta.status}）`,
        `任务：${prog.total} 个｜完成 ${prog.completed}｜无效 ${prog.invalid}｜失败 ${prog.failed}｜进行中 ${prog.pending}`,
      ]
      if (prog.tasks) {
        const byQ = {}
        for (const t of prog.tasks) {
          byQ[t.query_index] ??= {}
          byQ[t.query_index][t.platform] = t.status
        }
        for (const [qi, byP] of Object.entries(byQ)) {
          lines.push(`Q${Number(qi) + 1}: ${meta.platforms.map((p) => `${PLATFORMS[p].label}=${byP[p] || '-'}`).join(' ')}`)
        }
      }
      const done = meta.status === 'searched'
      return result(true,
        done
          ? `搜索已结束（${meta.counts?.completed ?? 0} 完成 / ${meta.counts?.invalid ?? 0} 无效 / ${meta.counts?.failed ?? 0} 失败）。下一步：read_answers 读回答 → 按 geo-analyzer 技能分析 → ai_save。`
          : prog.running
            ? '搜索进行中，等 30-60 秒再查。'
            : '当前没有进行中的搜索。',
        lines.join('\n'))
    }

    // ── read_answers ─────────────────────────────────────────────────────
    if (args.action === 'read_answers') {
      const meta = resolveRun(args.runId)
      const data = getSearchResults(meta.run_id)
      if (!data) throw new Error('还没有搜索结果。先 search 并等 status 显示完成。')
      let list = data.results.filter((r) => r.status === 'completed')
      if (args.queryIndex !== undefined) list = list.filter((r) => r.query_index === Number(args.queryIndex))
      if (args.platform) {
        if (!PLATFORM_KEYS.includes(args.platform)) throw new Error(`platform 只能是 ${PLATFORM_KEYS.join(' / ')} 之一`)
        list = list.filter((r) => r.platform === args.platform)
      }
      if (!list.length) {
        const failed = data.results.filter((r) => r.status !== 'completed').length
        return result(false, `没有可分析的已完成回答（失败/超时 ${failed} 条）。可稍后重试 search，或用 report 先出确定性分析。`)
      }
      const limit = Math.min(Number(args.limit) || 12, 30)
      const chunks = []
      let size = 0
      let shown = 0
      for (const r of list) {
        if (shown >= limit) break
        const content = (r.content || '').slice(0, PER_ANSWER_CHARS)
        const block = `【#${r.query_index} ${r.platform}】Q${r.query_index + 1}「${r.question}」 信源${r.sources.length}条\n${content}${(r.content || '').length > PER_ANSWER_CHARS ? '…（截断）' : ''}`
        if (size + block.length > MAX_TEXT && shown > 0) break
        chunks.push(block)
        size += block.length
        shown++
      }
      const template = buildAiAnalysisTemplate(list, meta.brand, meta.competitors)
      return result(true,
        `已读 ${shown}/${list.length} 条回答（单条最多 ${PER_ANSWER_CHARS} 字符，超长已截断）。按 geo-analyzer 技能对每条输出分析（brand_rank/brand_context/sentiment/sentiment_reason/competitors_mentioned/competitor_details/key_claims；同一回答内排名不得重复），然后 ai_save 分批存（支持只传本次分析的条数）。剩余回答用 queryIndex/platform/limit 继续 read_answers。`,
        chunks.join('\n\n' + '-'.repeat(40) + '\n\n'))
    }

    // ── ai_save ──────────────────────────────────────────────────────────
    if (args.action === 'ai_save') {
      const meta = resolveRun(args.runId)
      if (!args.analysisJson) throw new Error('ai_save 需要 analysisJson。')
      let parsed
      try {
        parsed = JSON.parse(args.analysisJson)
      } catch {
        throw new Error('analysisJson 不是合法 JSON（应为数组，每条含 query_index/platform/sentiment 等字段）。')
      }
      if (!Array.isArray(parsed)) throw new Error('analysisJson 必须是 JSON 数组。')
      const data = getSearchResults(meta.run_id)
      const validKeys = new Set((data?.results || []).filter((r) => r.status === 'completed').map((r) => `${r.query_index}|${r.platform}`))
      const bad = parsed.filter((e) => !validKeys.has(`${e.query_index}|${e.platform}`))
      if (bad.length) throw new Error(`analysisJson 里有 ${bad.length} 条的 query_index/platform 对不上已完成的回答（#${bad.map((b) => `${b.query_index}|${b.platform}`).join(', #')}）。只分析 status=completed 的回答。`)
      const merged = saveAiAnalysis(meta.run_id, parsed)
      const totalCompleted = data?.completed || 0
      const doneAll = merged.length >= totalCompleted
      if (doneAll) patchMeta(meta.run_id, { status: 'analyzed' })
      return result(true,
        `已存 ${parsed.length} 条分析（累计 ${merged.length}/${totalCompleted}）。${doneAll ? '全部分析完成，下一步 report 生成报告。' : '继续 read_answers → ai_save，直到覆盖全部已完成回答，再 report。'}`)
    }

    // ── report ───────────────────────────────────────────────────────────
    if (args.action === 'report') {
      const meta = resolveRun(args.runId)
      const data = getSearchResults(meta.run_id)
      if (!data) throw new Error('还没有搜索结果。先 search。')
      const aiAnalysis = getAiAnalysis(meta.run_id)
      const analysis = runFullAnalysis(data, {
        brand: meta.brand, aliases: meta.aliases, competitors: meta.competitors, aiAnalysis,
      })
      const html = generateReportHtml(analysis, data)
      const file = saveReport(meta.run_id, html)
      saveAnalysisResult(meta.run_id, analysis)
      if (aiAnalysis.length) patchMeta(meta.run_id, { status: 'done', analyzed_at: new Date().toISOString() })
      else patchMeta(meta.run_id, { status: 'done', analyzed_at: null })

      // 关键发现摘要（技能 Step 6 口径）
      const mr = analysis.metrics.brand_mention_rate
      const gs = analysis.geo_score
      const sd = analysis.sentiment_distribution?.overall || {}
      const sentTotal = Object.values(sd).reduce((a, b) => a + b, 0)
      const negPct = sentTotal ? Math.round(((sd.negative || 0) / sentTotal) * 100) : 0
      const bestP = meta.platforms.reduce((w, p) => ((gs[p] ?? 0) > (gs[w] ?? 0) ? p : w), meta.platforms[0])
      const worstP = meta.platforms.reduce((w, p) => ((gs[p] ?? 0) < (gs[w] ?? 0) ? p : w), meta.platforms[0])
      const comps = [...analysis.competitor_comparison].filter((c) => c.name !== meta.brand && c.mention_rate_overall > 0)
      const topComp = comps[0]
      const topDomains = Object.entries(analysis.metrics.domain_stats).slice(0, 3).map(([d]) => d)
      const summaryLines = [
        `GEO 分析完成 — ${meta.brand} 在 ${meta.platforms.map((p) => PLATFORMS[p].label).join('/')} 中的表现：`,
        '',
        `1. 跨平台提及率: ${Math.round(mr.overall * 100)}%（${analysis.metrics.total_mentioned}/${analysis.metrics.total_completed}）`,
        `   ${meta.platforms.map((p) => `${PLATFORMS[p].label}: ${Math.round((mr[p] || 0) * 100)}%`).join(' | ')}`,
        '',
        `2. GEO 综合得分: ${gs.overall}/100`,
        `   ${PLATFORMS[bestP].label} 表现最佳（${gs[bestP]}分），${PLATFORMS[worstP].label} 表现最弱（${gs[worstP]}分）`,
        '',
        aiAnalysis.length
          ? `3. 情绪分布: 正面 ${sentTotal - (sd.neutral || 0) - (sd.negative || 0)} 条 | 中性 ${sd.neutral || 0} 条 | 负面 ${sd.negative || 0} 条（正面率 ${100 - negPct}%，中性计入正面）`
          : '3. 情绪分布: 待分析（未执行 AI 情绪分析，报告情绪板块为占位）',
        '',
        `4. 竞品对比: 共发现 ${analysis.all_competitors.length} 个竞品`,
        topComp ? `   提及率最高的竞品: ${topComp.name}（${Math.round(topComp.mention_rate_overall * 100)}%）；本品牌提及率排名: 第 ${comps.filter((c) => c.mention_rate_overall > mr.overall).length + 1} 位` : '   AI 回答中暂无明显竞品',
        '',
        `5. 信源引用: TOP3 引用域名为 ${topDomains.join('、') || '—'}${(analysis.metrics.domain_stats && Object.keys(analysis.metrics.domain_stats).length) ? '' : '（本次无平台返回可解析信源）'}`,
        '',
        `完整报告: ${file}（面板「GEO 品牌雷达」可直接查看）`,
      ]
      return result(true,
        `报告已生成（runId=${meta.run_id}）。把下面关键发现完整输出给用户（保留分平台数字），再附报告位置。`,
        summaryLines.join('\n').slice(0, MAX_TEXT))
    }

    // ── history ──────────────────────────────────────────────────────────
    if (args.action === 'history') {
      const runs = listRuns({ limit: 20 })
      if (!runs.length) return result(false, '还没有分析运行。先 create。')
      const lines = runs.map((r) => {
        const c = r.counts
        return `${r.run_id}｜${r.brand}（${r.category || '—'}）｜${r.status}｜问题 ${r.queries.length}｜${c ? `完成 ${c.completed}/无效 ${c.invalid}/失败 ${c.failed}` : '未搜索'}${r.has_report ? '｜有报告' : ''}`
      })
      return result(true, `共 ${runs.length} 次运行（新→旧）。对历史运行操作传 runId：status/read_answers/report 可重跑补数据。`, lines.join('\n').slice(0, MAX_TEXT))
    }

    throw new Error(`未知 action：${args.action}`)
  },
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const skillDirs = [join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')]

  const toolWithConfig = { ...geoAnalyzerTool, execute(args) { return geoAnalyzerTool.execute(args, config) } }

  ctx.effect(() => ctx.tools.register(toolWithConfig), `${name}: tool`)
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(skillDirs)), `${name}: skills`)
  if (config.injectRules !== false) {
    ctx.effect(() => ctx.systemPrompt.section(systemSection()), `${name}: workflow`)
  }
  ctx.effect(() => registerApi(ctx, { config }), `${name}: routes`)
}

export { publicMeta }
