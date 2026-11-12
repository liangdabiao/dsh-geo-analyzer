// 面板数据面：/geo-analyzer 前缀路由（运行管理 + 进度 + 报告 + 设置；AI 分析走 agent 对话）。
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRun, getMeta, patchMeta, listRuns, saveQueries, deleteRun, getSettings, saveSettings,
  getAnalysisResult, publicMeta, readReport, DATA_DIR,
} from './store.js'
import { startSearch, progressOf, isSearching } from './search.js'
import { PLATFORM_KEYS, PLATFORMS, resolveApiKey, resolveApiBase } from './redfox.js'

const BASE = '/geo-analyzer'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return false // dsh 0.2.x 宿主已 token 鉴权
  return connection.requestRejection({ headers: req.headers })
}

function safeFile(dir, rel) {
  if (!dir || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(dir) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serveFile(req, res, file) {
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('type'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

function readVersion() {
  try { return JSON.parse(readFileSync(join(LAB, '..', 'package.json'), 'utf8')).version } catch { return '' }
}

function catalog() {
  const settings = getSettings()
  const runs = listRuns({ limit: 50 })
  const searching = runs.find((r) => isSearching(r.run_id))
  return {
    version: readVersion(),
    dataDir: DATA_DIR,
    has_key: Boolean(resolveApiKey({ settings })),
    key_source: settings.api_key ? 'settings' : (process.env.REDFOX_API_KEY ? 'env' : 'none'),
    platforms: PLATFORM_KEYS.map((k) => ({ key: k, label: PLATFORMS[k].label })),
    runs,
    searching: searching ? searching.run_id : null,
    settings: { proxy_url: settings.proxy_url || '', api_base: settings.api_base || '' },
  }
}

export function registerApi(ctx, hooks = {}) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })

        const url = new URL(req.url, 'http://x')
        if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) return json(res, 404, { error: 'not found' })
        const path = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        // ---- API ----
        if (path === '/api/catalog' && req.method === 'GET') return json(res, 200, catalog())

        if (path === '/api/runs' && req.method === 'GET') return json(res, 200, { runs: listRuns({ limit: 100 }) })

        if (path === '/api/runs' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            if (!body.brand || !body.category) return json(res, 400, { ok: false, error: '品牌名与品类必填' })
            const platforms = Array.isArray(body.platforms) && body.platforms.length ? body.platforms : PLATFORM_KEYS
            const bad = platforms.filter((p) => !PLATFORM_KEYS.includes(p))
            if (bad.length) return json(res, 400, { ok: false, error: `未知平台：${bad.join(',')}` })
            const meta = createRun({
              brand: String(body.brand).trim(),
              category: String(body.category).trim(),
              aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : [],
              competitors: Array.isArray(body.competitors) ? body.competitors.map(String) : [],
              platforms,
              queries: Array.isArray(body.queries) ? body.queries.map(String) : [],
            })
            return json(res, 200, { ok: true, run: publicMeta(meta) })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }

        const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/.*)?$/)
        if (runMatch) {
          const runId = runMatch[1]
          const sub = runMatch[2] || ''
          const meta = getMeta(runId)
          if (!meta) return json(res, 404, { error: `运行不存在: ${runId}` })

          if (!sub && req.method === 'GET') {
            return json(res, 200, { run: publicMeta(meta), progress: progressOf(runId, meta) })
          }
          if (!sub && req.method === 'DELETE') {
            if (isSearching(runId)) return json(res, 409, { ok: false, error: '搜索进行中，不能删除' })
            return json(res, 200, deleteRun(runId))
          }
          if (sub === '/queries' && req.method === 'POST') {
            try {
              const body = await readJson(req)
              const queries = (Array.isArray(body.queries) ? body.queries : String(body.queries || '').split('\n'))
                .map((q) => String(q).trim()).filter(Boolean)
              if (!queries.length) return json(res, 400, { ok: false, error: '问题列表为空' })
              const updated = saveQueries(runId, queries)
              return json(res, 200, { ok: true, run: publicMeta(updated) })
            } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
          }
          if (sub === '/search' && req.method === 'POST') {
            try {
              const body = await readJson(req).catch(() => ({}))
              if (Array.isArray(body.queries) && body.queries.length) saveQueries(runId, body.queries)
              const current = getMeta(runId)
              if (!current.queries.length) return json(res, 400, { ok: false, error: '先保存问题列表再搜索' })
              const settings = getSettings()
              const opts = {
                apiKey: resolveApiKey({ settings, config: hooks.config }),
                apiBase: resolveApiBase({ settings }),
                proxyUrl: hooks.config?.proxyUrl || settings.proxy_url || '',
              }
              if (!opts.apiKey) return json(res, 400, { ok: false, error: '未配置 RedFox API Key（设置页或插件配置/环境变量 REDFOX_API_KEY）' })
              const r = startSearch(runId, { ...opts, queries: current.queries, platforms: current.platforms })
              if (!r.ok) return json(res, 409, r)
              return json(res, 200, { ok: true, total: r.total })
            } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
          }
          if (sub === '/analysis' && req.method === 'GET') {
            const analysis = getAnalysisResult(runId)
            if (!analysis) return json(res, 404, { error: '还没有分析结果——在对话里让 agent 跑 geo_analyzer(action="report")，或面板直接重新生成' })
            return json(res, 200, { analysis })
          }
          if (sub === '/report' && (req.method === 'GET' || req.method === 'HEAD')) {
            const file = readReport(runId)
            if (!file) return json(res, 404, { error: '报告还没生成' })
            return serveFile(req, res, file)
          }
          return json(res, 404, { error: 'not found' })
        }

        if (path === '/api/settings' && req.method === 'GET') {
          const settings = getSettings()
          const key = String(settings.api_key || '')
          return json(res, 200, {
            settings: {
              has_key: Boolean(key || process.env.REDFOX_API_KEY),
              key_tail: key ? key.slice(-6) : '',
              from_env: Boolean(process.env.REDFOX_API_KEY),
              proxy_url: settings.proxy_url || '',
              api_base: settings.api_base || '',
            },
          })
        }
        if (path === '/api/settings' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const patch = {}
            if (body.api_key !== undefined) {
              const key = String(body.api_key).trim()
              if (key && !key.startsWith('ak_')) return json(res, 400, { ok: false, error: 'RedFox API Key 以 ak_ 开头，请检查' })
              patch.api_key = key
            }
            if (body.proxy_url !== undefined) patch.proxy_url = String(body.proxy_url).trim()
            if (body.api_base !== undefined) patch.api_base = String(body.api_base).trim()
            const next = saveSettings(patch)
            return json(res, 200, { ok: true, has_key: Boolean(resolveApiKey({ settings: next })) })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }
        if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' })

        // ---- 静态页面 ----
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' })
        const file = safeFile(LAB, path === '/' ? 'index.html' : path.replace(/^\/+/, ''))
        return file ? serveFile(req, res, file) : json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, 500, { error: err?.message || '内部错误' })
      }
    },
  })
}

// patchMeta 供面板「重新生成报告」等场景透出（保持单一入口）
export { patchMeta }
