// GEO 品牌雷达 · 数据层。
//   $DSH_HOME/geo-analyzer/
//   ├── settings.json          api_key / api_base(测试用) / proxy_url
//   ├── runs/index.json        运行索引（新→旧）
//   └── runs/<runId>/
//       ├── meta.json          品牌/别名/竞品/品类/平台/问题/状态
//       ├── search_results.json  六平台原始回答（搜索完成后写，含 invalid 标注）
//       ├── ai_analysis.json     会话模型写入的情绪/排名分析
//       ├── analysis_result.json 合并后的完整指标
//       └── geo_report.html      最终 HTML 报告
// 原子写沿用 invest-radar 同款（tmp + rename）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'geo-analyzer')
const RUNS_DIR = join(DATA_DIR, 'runs')
const INDEX_FILE = join(RUNS_DIR, 'index.json')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

const nowIso = () => new Date().toISOString()

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(RUNS_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

// ── 设置 ───────────────────────────────────────────────────────────────
export function getSettings() {
  return readJson(SETTINGS_FILE, {}) || {}
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch, updated_at: nowIso() }
  writeJson(SETTINGS_FILE, next)
  return next
}

// ── 运行（一次完整分析 = 一个 run）──────────────────────────────────────
// runId 消毒与 createRun 的 slug 同语义：\p{L}\p{N} 保留中文品牌词；单段目录名无分隔符，路径安全
function runDir(runId) {
  const safe = String(runId).replace(/[^\p{L}\p{N}_-]+/gu, '')
  if (!safe || safe !== String(runId)) throw new Error('非法 runId')
  const dir = join(RUNS_DIR, safe)
  if (normalize(dir) !== normalize(join(RUNS_DIR, safe))) throw new Error('非法 runId')
  return dir
}

export function getRunIndex() {
  return readJson(INDEX_FILE, []) || []
}

function writeRunIndex(list) {
  writeJson(INDEX_FILE, list.slice(0, 200))
}

function readMeta(dir) {
  return readJson(join(dir, 'meta.json'))
}

export function listRuns({ limit = 50 } = {}) {
  const index = getRunIndex()
  const out = []
  for (const item of index.slice(0, limit)) {
    const meta = readMeta(join(RUNS_DIR, item.run_id))
    if (!meta) continue
    out.push(publicMeta(meta))
  }
  return out
}

// meta 的对外视图（面板/工具列表用，剥掉大字段）
export function publicMeta(meta) {
  return {
    run_id: meta.run_id,
    brand: meta.brand,
    category: meta.category || '',
    aliases: meta.aliases || [],
    competitors: meta.competitors || [],
    platforms: meta.platforms || [],
    queries: meta.queries || [],
    status: meta.status || 'created', // created → searching → searched → analyzed → done
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    search_finished_at: meta.search_finished_at || null,
    analyzed_at: meta.analyzed_at || null,
    has_report: existsSync(join(RUNS_DIR, meta.run_id, 'geo_report.html')),
    counts: meta.counts || null,
  }
}

export function createRun({ brand, category = '', aliases = [], competitors = [], platforms, queries = [] }) {
  const ts = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const slug = String(brand).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'brand'
  // 带毫秒位：同一秒内连续创建同品牌运行不会撞 runId
  const runId = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}${String(ts.getMilliseconds()).padStart(3, '0')}-${slug}`
  const meta = {
    run_id: runId,
    brand: String(brand),
    category: String(category || ''),
    aliases: (aliases || []).map(String).filter(Boolean),
    competitors: (competitors || []).map(String).filter(Boolean),
    platforms: (platforms || []).map(String).filter((p) => p),
    queries: (queries || []).map(String).filter(Boolean),
    status: 'created',
    created_at: ts.toISOString(),
    updated_at: ts.toISOString(),
  }
  const dir = runDir(runId)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'meta.json'), meta)
  const index = getRunIndex().filter((i) => i.run_id !== runId)
  index.unshift({ run_id: runId, created_at: meta.created_at })
  writeRunIndex(index)
  return meta
}

export function getMeta(runId) {
  const dir = runDir(runId)
  return readMeta(dir)
}

// 局部更新 meta（patch 合并）；状态只能前进，防止并发写回退
const STATUS_ORDER = ['created', 'searching', 'searched', 'analyzed', 'done']
export function patchMeta(runId, patch) {
  const dir = runDir(runId)
  const meta = readMeta(dir)
  if (!meta) throw new Error(`运行不存在: ${runId}`)
  const { forceStatus, ...rest } = patch
  const next = { ...meta, ...rest, updated_at: nowIso() }
  if (rest.status && !forceStatus && STATUS_ORDER.indexOf(rest.status) < STATUS_ORDER.indexOf(meta.status)) {
    next.status = meta.status
  }
  writeJson(join(dir, 'meta.json'), next)
  return next
}

export function saveQueries(runId, queries) {
  const list = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q || '').trim()).filter(Boolean)
  if (!list.length) throw new Error('问题列表为空')
  return patchMeta(runId, { queries: list })
}

export function saveSearchResults(runId, data) {
  const dir = runDir(runId)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'search_results.json'), data)
  return data
}

export function getSearchResults(runId) {
  return readJson(join(runDir(runId), 'search_results.json'))
}

export function saveAiAnalysis(runId, entries) {
  if (!Array.isArray(entries)) throw new Error('AI 分析结果必须是数组')
  const dir = runDir(runId)
  // 分批合并：按 query_index+platform 去重覆盖
  const prev = readJson(join(dir, 'ai_analysis.json'), []) || []
  const map = new Map(prev.map((e) => [`${e.query_index}|${e.platform}`, e]))
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    map.set(`${e.query_index}|${e.platform}`, e)
  }
  const merged = [...map.values()]
  writeJson(join(dir, 'ai_analysis.json'), merged)
  return merged
}

export function getAiAnalysis(runId) {
  return readJson(join(runDir(runId), 'ai_analysis.json'), []) || []
}

export function saveAnalysisResult(runId, data) {
  const dir = runDir(runId)
  writeJson(join(dir, 'analysis_result.json'), data)
  return data
}

export function getAnalysisResult(runId) {
  return readJson(join(runDir(runId), 'analysis_result.json'))
}

export function saveReport(runId, html) {
  const dir = runDir(runId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'geo_report.html')
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, html, 'utf8')
  renameSync(tmp, file)
  return file
}

export function readReport(runId) {
  const file = join(runDir(runId), 'geo_report.html')
  return existsSync(file) ? file : null
}

export function deleteRun(runId) {
  const dir = runDir(runId)
  if (!existsSync(dir)) return { ok: false, error: `运行不存在: ${runId}` }
  rmSync(dir, { recursive: true, force: true })
  writeRunIndex(getRunIndex().filter((i) => i.run_id !== runId))
  return { ok: true }
}
