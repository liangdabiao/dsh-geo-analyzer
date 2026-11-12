// RedFox API · 六大 AI 搜索平台适配器（豆包/Kimi/DeepSeek/元宝/千问/百度）
// 移植自 redfox-community skills/geo-analyzer scripts/lib/platforms.py（API 用例参考），
// 外加 plus 版两处健壮性改进：内联引用标记剥离、限流话术识别（invalid）。
//
// 统一接口:
//   submit(platform, query, opts) -> task_id
//   poll(platform, task_id, opts) -> raw | null   (null = 还在处理)
//   extractResult(platform, raw)  -> { content, sources, sources_note? }
//
// 传输层自带可选 HTTP 代理（CONNECT 隧道）；apiBase 可被 settings/env 覆盖（离线冒烟用本地假服务器）。
import http from 'node:http'
import https from 'node:https'
import { TLSSocket } from 'node:tls'

export const DEFAULT_API_BASE = 'https://redfox.hk'

export const PLATFORMS = {
  doubao: { submit: '/story/api/doubaoSearch/submit', result: '/story/api/doubaoSearch/result', label: '豆包' },
  kimi: { submit: '/story/api/kimi/submit', result: '/story/api/kimi/result', label: 'Kimi' },
  deepseek: { submit: '/story/api/deepSearch/dsSubmit', result: '/story/api/deepSearch/dsResult', label: 'DeepSeek' },
  yuanbao: { submit: '/story/api/deepSearch/ybSubmit', result: '/story/api/deepSearch/ybResult', label: '元宝' },
  qianwen: { submit: '/story/api/deepSearch/qwSubmit', result: '/story/api/deepSearch/qwResult', label: '千问' },
  baidu: { submit: '/story/api/deepSearch/bdSubmit', result: '/story/api/deepSearch/bdResult', label: '百度' },
}

export const PLATFORM_KEYS = Object.keys(PLATFORMS)
export const SOURCE_TAG = '品牌GEO分析-dsh'

// 限流话术（plus 版）：平台返回这类「高峰期算力紧张」的正文不算「品牌未提及」，
// 记 status:"invalid"，排除出统计分母。
const INVALID_CONTENT_PATTERNS = [
  /高峰期.{0,12}算力紧张/,
  /请稍后再试/,
  /系统繁忙/,
  /加载失败.{0,20}重试/,
]

// Kimi 只回正文内联引用（<REF>…</REF>），DeepSeek 用 [citation:N] —— 展示前剥掉
const REF_BLOCK_RE = /<REF>[\s\S]*?<\/REF>/g
const REF_OPEN_RE = /<\/?REF[^>]*>/g
const CITATION_RE = /\[citation:\d+\]/g

export function resolveApiKey({ settings = {}, config = {} } = {}) {
  return String(
    config.apiKey || settings.api_key || process.env.REDFOX_API_KEY || '',
  ).trim()
}

export function resolveApiBase({ settings = {} } = {}) {
  const base = String(settings.api_base || process.env.REDFOX_API_BASE || '').trim()
  return (base || DEFAULT_API_BASE).replace(/\/+$/, '')
}

// ── 传输层（JSON POST + 可选代理 CONNECT 隧道）───────────────────────────

function connectTunnel(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { host: `${targetHost}:${targetPort}` },
      timeout,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT ${res.statusCode}`)); return }
      resolve(socket)
    })
    req.on('timeout', () => req.destroy(new Error('proxy connect timeout')))
    req.on('error', reject)
    req.end()
  })
}

// JSON POST（https 直连/代理隧道，http 走明文——本地假服务器与测试网关用）。
// 返回 {status, json}；非 JSON 响应抛错（带前 200 字符方便定位）。
export function httpPostJson(url, body, { timeout = 30000, proxyUrl = '', headers = {} } = {}) {
  const u = new URL(url)
  const isHttp = u.protocol === 'http:'
  const port = Number(u.port) || (isHttp ? 80 : 443)
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const transport = isHttp ? http : https
  const opts = {
    host: u.hostname,
    port,
    method: 'POST',
    path: `${u.pathname}${u.search}`,
    headers: {
      'content-type': 'application/json',
      'content-length': payload.length,
      ...headers,
    },
  }
  return new Promise((resolve, reject) => {
    const finish = (socket) => {
      const req = transport.request(socket ? { ...opts, socket, agent: false } : { ...opts, agent: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) })
          } catch {
            reject(new Error(`响应不是合法 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）`)))
      req.end(payload)
    }
    if (proxyUrl && !isHttp) {
      connectTunnel(proxyUrl, u.hostname, port, timeout)
        .then((socket) => finish(new TLSSocket(socket, { servername: u.hostname })))
        .catch(reject)
    } else {
      finish()
    }
  })
}

function assertKey(apiKey) {
  if (!apiKey) {
    throw new Error('未配置 RedFox API Key。请到面板「设置」页填入，或在插件配置/环境变量 REDFOX_API_KEY 里配置（获取：https://redfox.hk/settings/api-keys?source=github）。')
  }
}

// 业务错误码翻译（裸 JSON 用户看不懂）
function friendlyApiError(json) {
  const code = json?.code
  const msg = String(json?.msg || json?.message || '')
  if (code === 3203 || msg.includes('付费调用')) {
    return new Error('RedFox 的 AI 搜索接口已转为付费调用（免费积分不适用）：请到 https://redfox.hk/dashboard/recharge 充值后重试。')
  }
  if (code === 3108) return new Error('RedFox 提交被限流（3108），稍等片刻再试。')
  if (code === 401 || code === 403 || msg.includes('key') || msg.includes('Key')) {
    return new Error(`RedFox 鉴权失败（${code}）：请检查面板「设置」页的 API Key。`)
  }
  return new Error(`提交失败（code=${code ?? '?'}）：${msg || JSON.stringify(json).slice(0, 200)}`)
}

// ── 提交 / 轮询 / 提取 ──────────────────────────────────────────────────

// 提交搜索，返回 taskId。code 3108（限流）按 2s/4s/6s 退避重试。
export async function submit(platform, query, { apiKey, apiBase, proxyUrl = '', source = SOURCE_TAG, timeout = 30000, maxRetries = 3 } = {}) {
  assertKey(apiKey)
  const conf = PLATFORMS[platform]
  if (!conf) throw new Error(`未知平台: ${platform}（可选：${PLATFORM_KEYS.join(', ')}）`)
  const url = `${apiBase}${conf.submit}`
  let lastErr = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 2000))
    const { json } = await httpPostJson(url, { inquiry_text: query, source }, {
      timeout, proxyUrl, headers: { 'X-API-Key': apiKey },
    })
    const taskId = json?.data?.taskId
    if (taskId) return String(taskId)
    if (json?.code === 3108 && attempt < maxRetries) { lastErr = friendlyApiError(json); continue }
    throw friendlyApiError(json)
  }
  throw lastErr || new Error(`提交失败，重试 ${maxRetries} 次后仍未获取到 taskId`)
}

// 轮询单个任务：完成返回原始 JSON；处理中返回 null；失败抛错。
export async function poll(platform, taskId, { apiKey, apiBase, proxyUrl = '', timeout = 30000 } = {}) {
  assertKey(apiKey)
  const conf = PLATFORMS[platform]
  if (!conf) throw new Error(`未知平台: ${platform}`)
  const { json } = await httpPostJson(`${apiBase}${conf.result}`, { taskId }, {
    timeout, proxyUrl, headers: { 'X-API-Key': apiKey },
  })
  const inner = json?.data && typeof json.data === 'object' ? json.data : {}
  const status = inner.status || json?.status || ''
  if (['completed', 'success', 'done'].includes(status)) return json
  if (['failed', 'error'].includes(status)) {
    const reason = json?.data?.message || json?.msg || json?.message || '未知原因'
    throw new Error(`搜索任务失败：${String(reason).slice(0, 200)}`)
  }
  return null
}

export function extractDomain(url) {
  if (!url) return ''
  try {
    const u = new URL(String(url))
    return (u.hostname || String(url).split('/')[0]).replace(/^www\./, '').toLowerCase()
  } catch {
    return String(url).split('/')[0].replace(/^www\./, '').toLowerCase()
  }
}

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function collectSources(list, out) {
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const card = item.text_card && typeof item.text_card === 'object' ? item.text_card : item
    const url = pickString(card, ['url', 'link', 'href'])
    const title = pickString(card, ['title', 'name', 'sitename', 'text'])
    if (url || title) out.push({ title, url, domain: extractDomain(url) })
  }
}

// 从原始响应提取 {content, sources}。各平台差异：
//   豆包 searchGuid[].text_card / 元宝 searchGuid.docs[] / Kimi webPages[] /
//   deepSearch 系（DeepSeek/元宝/千问/百度）通用 sources|references|citations。
export function extractResult(platform, raw) {
  const data = raw?.data || raw || {}
  const result = data.result
  let content = ''
  if (typeof result === 'string') content = result
  else if (result && typeof result === 'object') {
    content = pickString(result, ['content', 'answer', 'text', 'response'])
  }
  if (!content) content = pickString(data, ['content', 'answer', 'text', 'response'])

  const sources = []
  if (result && typeof result === 'object') {
    let searchGuid = result.searchGuid
    if (searchGuid && typeof searchGuid === 'object' && !Array.isArray(searchGuid)) searchGuid = searchGuid.docs // 元宝
    collectSources(searchGuid, sources)
    if (!sources.length) collectSources(result.webPages, sources) // Kimi
    if (!sources.length) {
      for (const key of ['sources', 'references', 'citations']) {
        const rawList = result[key]
        if (Array.isArray(rawList) && rawList.length) { collectSources(rawList, sources); break }
      }
    }
  }
  if (!sources.length) {
    for (const key of ['sources', 'references', 'citations']) {
      const rawList = data[key]
      if (Array.isArray(rawList) && rawList.length) { collectSources(rawList, sources); break }
    }
  }

  // 剥离内联引用标记（plus 版）
  content = String(content || '')
    .replace(REF_BLOCK_RE, '')
    .replace(REF_OPEN_RE, '')
    .replace(CITATION_RE, '')
    .trim()

  const out = { content, sources }
  // Kimi 只有内联引用、无外链属正常现象——报告侧需要这个提示，别当「官网未被引用」
  if (!sources.length && content) out.sources_note = '该平台未返回可解析的外链信源（常见于 Kimi 的内联引用），信源板块数据不完整不代表官网未被引用。'
  return out
}

// 判断回答正文是否为限流/故障话术（记 invalid，排除出统计）
export function looksInvalid(content) {
  const text = String(content || '')
  if (!text.trim()) return true
  return INVALID_CONTENT_PATTERNS.some((re) => re.test(text))
}
