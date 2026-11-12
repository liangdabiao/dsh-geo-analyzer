// 冒烟测试（离线）：假 RedFox 服务器 + 工具直调全链路（create→queries→search→read→ai_save→report→history）
// + 面板 API 全路由。搜索用毫秒级轮询（GEO_POLL_INTERVAL_MS）。
// 运行：npm run smoke
process.env.GEO_POLL_INTERVAL_MS = '120'
process.env.GEO_MAX_POLL_MS = '6000'
delete process.env.REDFOX_API_KEY // 冒烟只认假服务器里的 key，避免宿主环境变量干扰
const { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const http = await import('node:http')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-geo-smoke-'))
process.env.DSH_HOME = tmp

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failed++
}

// ── 假 RedFox 服务器：doubao 完成带信源 / kimi 完成无信源 / deepseek 限流话术(invalid) /
//    yuanbao 永远 processing（→timeout）/ qianwen 状态 failed / baidu 提交限流一次后成功 ──
const ANSWER = (brand) => `${brand}是无糖饮料里的头部品牌，市占率领先，口感清爽，0 糖 0 卡，深受年轻消费者喜爱，很多推荐列表都把它排在前三位。其他值得考虑的还有农夫山泉和可口可乐。`.repeat(3)
const answerByPlatform = {
  doubao: (b) => ANSWER(b),
  kimi: (b) => `推荐${b}，气泡水品类开创者。`,
  deepseek: (b) => `高峰期算力紧张，请稍后再试哦。${b}`,
  qianwen: (b) => `${b}不错`,
  baidu: (b) => ANSWER(b),
}
const submitted = new Map() // taskId -> {platform, query}
let submitN = 0
const pollN = new Map()
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (/submit$/i.test(req.url)) {
      submitN++
      // 平台路由对齐真实 endpoint：doubaoSearch / kimi / dsSubmit / ybSubmit / qwSubmit / bdSubmit
      const platform = req.url.includes('doubaoSearch') ? 'doubao'
        : req.url.includes('/kimi/') ? 'kimi'
        : req.url.includes('dsSubmit') ? 'deepseek'
        : req.url.includes('ybSubmit') ? 'yuanbao'
        : req.url.includes('qwSubmit') ? 'qianwen'
        : 'baidu'
      const id = `T${submitN}`
      submitted.set(id, { platform, query: payload.inquiry_text })
      if (platform === 'baidu' && !pollN.has('retry-baidu')) {
        pollN.set('retry-baidu', 1)
        return reply({ code: 3108, message: 'rate limited' }) // 首次提交限流 → 退避重试
      }
      return reply({ code: 0, data: { taskId: id } })
    }
    // result
    const task = submitted.get(payload.taskId)
    const n = (pollN.get(payload.taskId) || 0) + 1
    pollN.set(payload.taskId, n)
    if (!task) return reply({ code: 404, message: 'unknown task' })
    if (task.platform === 'yuanbao') return reply({ code: 0, data: { status: 'processing' } }) // 永远 pending → timeout
    if (task.platform === 'qianwen') return reply({ code: 0, data: { status: 'failed', message: 'boom' } })
    return reply({
      code: 0,
      data: {
        status: 'completed',
        result: {
          content: answerByPlatform[task.platform](task.query),
          ...(task.platform === 'doubao'
            ? { searchGuid: [{ text_card: { title: '知乎问答', url: 'https://www.zhihu.com/q/1', sitename: '知乎' } }, { text_card: { title: '官网', url: `https://genki.cn/about`, sitename: '' } }] }
            : {}),
        },
      },
    })
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`

// ── 设置：API base 指向假服务器 ──
mkdirSync(join(tmp, 'geo-analyzer'), { recursive: true })
writeFileSync(join(tmp, 'geo-analyzer', 'settings.json'), JSON.stringify({ api_key: 'ak_smoke', api_base: base }, null, 2))

// ── 工具直调 ──
const { geoAnalyzerTool } = await import('../src/host.js')
const call = async (args) => {
  try {
    return await geoAnalyzerTool.execute(args, {})
  } catch (e) {
    return { ok: false, summary: String(e?.message || e) } // 抛错 = 参数/状态拒绝，转成回执断言
  }
}

let runId
{
  const r = await call({ action: 'create', brand: '元气森林', category: '无糖气泡水', aliasesJson: '["Genki"]', competitorsJson: '["农夫山泉","可口可乐"]' })
  check('create', r.ok && r.summary.includes('runId='), r.summary.slice(0, 50))
  runId = r.summary.match(/runId=([\p{L}\p{N}-]+)/u)?.[1]
}
{
  const r = await call({ action: 'create', brand: '缺品类' })
  check('create 缺品类报错', !r.ok && r.summary.includes('category'), r.summary.slice(0, 60))
}
{
  const r = await call({ action: 'queries_save', queriesJson: '["无糖气泡水哪个品牌好？","办公室久坐党适合什么无糖饮料？","经常熬夜的人喝什么饮料比较健康？","0糖0卡的气泡水推荐","性价比高的无糖饮料有哪些？"]', runId })
  check('queries_save 5 题', r.ok && r.summary.includes('5 个问题'), r.summary.slice(0, 50))
}
{
  const r = await call({ action: 'search', runId })
  check('search 启动', r.ok && r.summary.includes('后台执行中'), r.summary.slice(0, 60))
}
{
  // 轮询直到 status 显示搜索结束（最长 10s）
  let done = false
  for (let i = 0; i < 50 && !done; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const r = await call({ action: 'status', runId })
    done = r.summary.includes('搜索已结束')
    if (i === 3) check('searching 中间态', r.data.includes('任务：30'), `${r.summary} ${String(r.data).slice(0, 120)}`.replace(/\n/g, ' ⏎ '))
  }
  check('搜索结束', done)
  const r = await call({ action: 'status', runId })
  check('计数：15 完成 / 5 无效 / 10 失败',
    r.summary.includes('15 完成') && r.summary.includes('5 无效') && r.summary.includes('10 失败'),
    r.summary.replace(/\n/g, ' ⏎ ').slice(0, 200))
}
{
  const r = await call({ action: 'read_answers', runId })
  check('read_answers 只含 completed（无限流话术）', r.ok && !r.data.includes('算力紧张') && r.data.includes('【#0 doubao】'), r.summary.slice(0, 50))
  check('回答已剥引用标记', !r.data.includes('<REF>') && !r.data.includes('[citation:'), '')
}
{
  // ai_save：先小批存 2 条，再补齐剩余 13 条（3 有效平台 × 5 题 = 15 份 completed）
  const bad = await call({ action: 'ai_save', runId, analysisJson: '[{"query_index":0,"platform":"yuanbao","sentiment":"positive"}]' })
  check('ai_save 键校验（timeout 平台拒绝）', !bad.ok && bad.summary.includes('对不上'), bad.summary.slice(0, 60))
  const mk = (qi, platform) => ({
    query_index: qi, platform,
    brand_rank: qi === 0 ? 1 : null,
    sentiment: qi % 2 ? 'neutral' : 'positive',
    sentiment_reason: '推荐语境，市占率领先',
    competitors_mentioned: qi === 0 ? ['农夫山泉', '可口可乐'] : [],
    competitor_details: qi === 0 ? [{ name: '农夫山泉', rank: 2, sentiment: 'neutral' }, { name: '可口可乐', rank: 3, sentiment: 'neutral' }] : [],
    key_claims: ['市占率领先', '0糖0卡'],
  })
  const r1 = await call({ action: 'ai_save', runId, analysisJson: JSON.stringify([mk(0, 'doubao'), mk(1, 'doubao')]) })
  check('ai_save 分批1', r1.ok && r1.summary.includes('累计 2/'), r1.summary.slice(0, 50))
  const rest = []
  for (let qi = 0; qi < 5; qi++) for (const p of ['doubao', 'kimi', 'baidu']) {
    if (p === 'doubao' && qi < 2) continue
    rest.push(mk(qi, p))
  }
  const r2 = await call({ action: 'ai_save', runId, analysisJson: JSON.stringify(rest) })
  check('ai_save 分批2 完成覆盖', r2.ok && r2.summary.includes('全部分析完成'), r2.summary.slice(0, 60))
}
{
  const r = await call({ action: 'report', runId })
  check('report 生成', r.ok && r.summary.includes('报告已生成'), r.summary.slice(0, 40))
  check('关键发现含提及率与得分', r.data.includes('跨平台提及率') && r.data.includes('GEO 综合得分'), '')
  check('关键发现含竞品与信源', r.data.includes('竞品对比') && r.data.includes('信源引用'), '')
  const file = r.data.match(/完整报告: (.+?)（/)?.[1]
  check('HTML 落盘', file && existsSync(file), file || '')
  const html = file ? readFileSync(file, 'utf8') : ''
  check('HTML 各板块齐全', ['品牌指纹', '提及矩阵', '情感分析', '信源分析', '竞品对比', '原始存档'].every((s) => html.includes(s)), '')
  check('HTML 无序列化泄漏', !html.includes('undefined') && !html.includes('[object Object]'), '')
  check('HTML 信源提示（Kimi 无外链）', html.includes('数据完整性提示'), '')
}
{
  const r = await call({ action: 'history' })
  check('history 列出且有报告标记', r.ok && r.data.includes('有报告'), r.data.split('\n')[0] || '')
}
{
  // 平台筛选 + 分页
  const r = await call({ action: 'read_answers', runId, platform: 'doubao', limit: 2 })
  check('read_answers 平台过滤', r.ok && r.data.split('【#').length === 3, '')
}
{
  // 未配置 key 的直连报错（先补问题列表，否则会先被「没有问题列表」挡住）
  const r2 = await call({ action: 'create', brand: '测试B', category: '品类B' })
  const runId2 = r2.summary.match(/runId=([\p{L}\p{N}-]+)/u)?.[1]
  await call({ action: 'queries_save', runId: runId2, queriesJson: '["测试问题一？","测试问题二？"]' })
  writeFileSync(join(tmp, 'geo-analyzer', 'settings.json'), JSON.stringify({}, null, 2))
  const r = await call({ action: 'search', runId: runId2 })
  check('无 key 报错引导', !r.ok && r.summary.includes('RedFox API Key'), r.summary.slice(0, 60))
  writeFileSync(join(tmp, 'geo-analyzer', 'settings.json'), JSON.stringify({ api_key: 'ak_smoke', api_base: base }, null, 2))
}

// ── 面板 API ──
const { registerApi } = await import('../lib/api.js')
const routes = {}
const fakeCtx = { get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }
registerApi(fakeCtx, { config: {} })
const req = async (method, path, body) => {
  const { Writable } = await import('node:stream')
  const { EventEmitter } = await import('node:events')
  const reqObj = new EventEmitter()
  reqObj.method = method
  reqObj.url = `/geo-analyzer${path}`
  reqObj.headers = body ? { 'content-type': 'application/json', host: 'x', origin: 'http://x' } : { host: 'x' }
  const chunks = []
  const resObj = new Writable({
    write(c, _e, cb) { chunks.push(c); cb() },
    destroy(err, cb) { cb(err) },
  })
  resObj.statusCode = 0
  resObj.writeHead = (code) => { resObj.statusCode = code }
  const done = new Promise((resolve) => {
    const origEnd = resObj.end.bind(resObj)
    resObj.end = (...args) => { origEnd(...args); resolve({ status: resObj.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null } })() }) }
  })
  const handler = routes['/geo-analyzer']
  const p = handler(reqObj, resObj)
  if (body) reqObj.emit('data', Buffer.from(JSON.stringify(body)))
  reqObj.emit('end')
  await p
  return done
}
{
  const cat = await req('GET', '/api/catalog')
  check('catalog：has_key/平台/运行列表', cat.status === 200 && cat.json.has_key && cat.json.platforms.length === 6 && cat.json.runs.length >= 1, '')
  check('catalog：searching 已清空', cat.json.searching === null, String(cat.json.searching))
}
{
  const runs = await req('GET', '/api/runs')
  check('runs 列表', runs.status === 200 && runs.json.runs.length >= 1, '')
  const one = await req('GET', `/api/runs/${runId}`)
  check('run 详情含 progress', one.status === 200 && one.json.progress.total === 30, `total=${one.json.progress.total}`)
  const analysis = await req('GET', `/api/runs/${runId}/analysis`)
  check('analysis 可读且含 geo_score', analysis.status === 200 && analysis.json.analysis.geo_score.overall > 0, String(analysis.json.analysis?.geo_score?.overall))
  check('run 详情 meta.brand', one.json.run.brand === '元气森林', '')
}
{
  // 面板建运行 → 存问题 → 删除
  const created = await req('POST', '/api/runs', { brand: '面板品牌', category: '面板品类', aliases: [], competitors: [], platforms: ['doubao'] })
  check('面板建运行', created.status === 200 && created.json.ok, '')
  const rid = created.json.run.run_id
  const qs = await req('POST', `/api/runs/${rid}/queries`, { queries: ['面板问题一？', '面板问题二？'] })
  check('面板存问题', qs.status === 200 && qs.json.run.queries.length === 2, '')
  const bad = await req('POST', `/api/runs/${rid}/queries`, { queries: [] })
  check('面板空问题 400', bad.status === 400, '')
  const del = await req('DELETE', `/api/runs/${rid}`)
  check('面板删运行', del.status === 200 && del.json.ok, '')
}
{
  const st = await req('GET', '/api/settings')
  check('settings GET：has_key + 尾号', st.status === 200 && st.json.settings.has_key && st.json.settings.key_tail === '_smoke', String(st.json.settings.key_tail))
  const saved = await req('POST', '/api/settings', { api_key: 'ak_newkey' })
  check('settings POST：保存', saved.status === 200 && saved.json.has_key, '')
  const bad = await req('POST', '/api/settings', { api_key: 'not-valid' })
  check('settings POST：非 ak_ 前缀拒绝', bad.status === 400, '')
}
{
  const idx = readFileSync(new URL('../lab/index.html', import.meta.url), 'utf8')
  check('lab/index.html 引用 scheme/app', idx.includes('app.js') && idx.includes('scheme.js'), '')
  const appjs = readFileSync(new URL('../lab/app.js', import.meta.url), 'utf8')
  check('lab/app.js 消息类型与 client 对齐', appjs.includes('geo-analyzer:refresh') && appjs.includes('geo-analyzer:start-ok'), '')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  check('client.js 消息类型一致', client.includes('geo-analyzer:refresh') && client.includes('geo-analyzer:start-ok'), '')
}

srv.close()
rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
