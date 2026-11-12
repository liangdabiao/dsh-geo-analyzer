// GEO 批量搜索调度器：N 问题 × M 平台 → 并行提交 → 轮询到完成/超时 → search_results.json
// 移植自 geo_search.py（30s 轮询间隔、最长 5 分钟、限并发防 Kimi 限流），
// 差异：宿主进程内后台任务（工具调用秒回，进度实时持久化，面板/工具都能查），
// 另采纳 plus 版：限流话术记 invalid 并排除出统计分母。
import { submit, poll, extractResult, looksInvalid, PLATFORM_KEYS } from './redfox.js'
import { patchMeta, saveSearchResults } from './store.js'

const POLL_INTERVAL_MS = Number(process.env.GEO_POLL_INTERVAL_MS) || 30_000   // 与上游一致：轮询间隔 30s，降低服务端压力
const MAX_POLL_TIME_MS = Number(process.env.GEO_MAX_POLL_MS) || 5 * 60_000 // 最长 5 分钟；超时任务记 timeout 不阻塞
// ^ 环境变量供离线冒烟/演示覆盖（假服务器毫秒级返回），生产默认不变
const MAX_WORKERS = 6

// 活动任务注册表（每宿主进程同时只跑一个 run 的搜索）
const active = new Map() // runId -> { started_at, total, done, failed, tasks: [{query_index, platform, status}], promise }

export function isSearching(runId) {
  return active.has(runId)
}

export function activeRunId() {
  for (const id of active.keys()) return id
  return null
}

// 进度快照（面板/status 用）：内存中有活动任务用内存值，否则读 meta.counts
export function progressOf(runId, meta) {
  const job = active.get(runId)
  if (job) {
    return {
      running: true,
      started_at: job.startedAt,
      total: job.total,
      completed: job.tasks.filter((t) => t.status === 'completed').length,
      invalid: job.tasks.filter((t) => t.status === 'invalid').length,
      failed: job.tasks.filter((t) => ['failed', 'timeout', 'submit_failed'].includes(t.status)).length,
      pending: job.tasks.filter((t) => t.status === 'pending').length,
      tasks: job.tasks.map((t) => ({ ...t })),
    }
  }
  const counts = meta?.counts || null
  return {
    running: false,
    started_at: meta?.search_started_at || null,
    total: counts?.total ?? (meta?.queries?.length || 0) * (meta?.platforms?.length || 0),
    completed: counts?.completed ?? 0,
    invalid: counts?.invalid ?? 0,
    failed: counts?.failed ?? 0,
    pending: 0,
    tasks: null,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 有界并发映射
async function pool(items, workers, fn) {
  const results = new Array(items.length)
  let next = 0
  const launch = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, launch))
  return results
}

/**
 * 启动一个 run 的批量搜索（不等待完成，返回 promise 供调用方可选 await）。
 * 完成后写 search_results.json + meta.counts，状态推进到 searched。
 */
export function startSearch(runId, { queries, platforms, apiKey, apiBase, proxyUrl = '', pollIntervalMs = POLL_INTERVAL_MS, maxPollTimeMs = MAX_POLL_TIME_MS } = {}) {
  if (active.has(runId)) return { ok: false, error: '该运行的搜索已在进行中', runId }

  const tasks = []
  for (let qi = 0; qi < queries.length; qi++) {
    for (const platform of platforms) {
      tasks.push({ query: queries[qi], query_index: qi, platform, task_id: null, status: 'pending' })
    }
  }
  const job = { startedAt: new Date().toISOString(), total: tasks.length, tasks }
  active.set(runId, job)
  patchMeta(runId, { status: 'searching', search_started_at: job.startedAt })

  const promise = (async () => {
    try {
      // Phase 1: 并行提交
      await pool(tasks, MAX_WORKERS, async (t) => {
        try {
          t.task_id = await submit(t.platform, t.query, { apiKey, apiBase, proxyUrl })
        } catch (err) {
          t.status = 'submit_failed'
          t.error = String(err?.message || err)
        }
      })

      // Phase 2: 轮询至完成/超时
      const pending = tasks.filter((t) => t.status === 'pending')
      const done = []
      const maxAttempts = Math.max(1, Math.round(maxPollTimeMs / pollIntervalMs))
      let round = 0
      while (pending.length && round < maxAttempts) {
        await sleep(pollIntervalMs)
        round++
        const still = []
        await pool(pending, MAX_WORKERS, async (t) => {
          try {
            const raw = await poll(t.platform, t.task_id, { apiKey, apiBase, proxyUrl })
            if (raw == null) { still.push(t); return }
            const { content, sources, sources_note } = extractResult(t.platform, raw)
            // plus 版：限流话术不算「未提及」，记 invalid 排除出分母
            if (looksInvalid(content)) {
              t.status = 'invalid'
              done.push({ ...t, content, sources, sources_note, status: 'invalid' })
            } else {
              t.status = 'completed'
              done.push({ ...t, content, sources, sources_note, status: 'completed' })
            }
          } catch (err) {
            t.status = 'failed'
            t.error = String(err?.message || err)
            done.push({ ...t, content: '', sources: [] })
          }
        })
        pending.length = 0
        pending.push(...still)
      }
      for (const t of pending) { t.status = 'timeout'; done.push({ ...t, content: '', sources: [] }) }

      // 落盘（含 submit_failed）
      const results = []
      for (const t of tasks) {
        const rec = done.find((d) => d.query_index === t.query_index && d.platform === t.platform)
        results.push(rec ? {
          question: t.query,
          query_index: t.query_index,
          platform: t.platform,
          content: rec.content || '',
          sources: rec.sources || [],
          sources_note: rec.sources_note || undefined,
          status: rec.status,
          error: rec.error || undefined,
        } : {
          question: t.query,
          query_index: t.query_index,
          platform: t.platform,
          content: '',
          sources: [],
          status: t.status === 'pending' ? 'submit_failed' : t.status,
          error: t.error || undefined,
        })
      }
      const platformOrder = new Map(platforms.map((p, i) => [p, i]))
      results.sort((a, b) => (a.query_index - b.query_index) || ((platformOrder.get(a.platform) ?? 99) - (platformOrder.get(b.platform) ?? 99)))

      const data = {
        queries,
        platforms,
        total_tasks: tasks.length,
        completed: results.filter((r) => r.status === 'completed').length,
        invalid: results.filter((r) => r.status === 'invalid').length,
        failed: results.filter((r) => !['completed', 'invalid'].includes(r.status)).length,
        finished_at: new Date().toISOString(),
        results,
      }
      saveSearchResults(runId, data)
      patchMeta(runId, {
        status: 'searched',
        search_finished_at: data.finished_at,
        counts: { total: data.total_tasks, completed: data.completed, invalid: data.invalid, failed: data.failed },
      })
      return data
    } catch (err) {
      patchMeta(runId, { last_error: String(err?.message || err) })
      throw err
    } finally {
      active.delete(runId)
    }
  })()

  job.promise = promise
  promise.catch(() => {}) // 后台模式调用方不 await 时避免 unhandledRejection
  return { ok: true, runId, total: tasks.length, promise }
}

// 工具/面板共用的搜索入口：可 await（冒烟/脚本），也可后台跑（会话/面板）
export async function runSearch(runId, opts = {}) {
  const { ok, error, promise, total } = startSearch(runId, opts)
  if (!ok) throw new Error(error)
  if (opts.waitFor) return promise
  return { ok: true, total }
}

export { PLATFORM_KEYS }
