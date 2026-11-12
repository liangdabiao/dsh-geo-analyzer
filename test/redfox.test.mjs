// redfox 单测：响应提取（各平台真实响应形态）+ 限流话术 + 引用剥离 + 提交/轮询（本地假服务器）
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  extractResult, looksInvalid, extractDomain, submit, poll, httpPostJson,
  DEFAULT_API_BASE, PLATFORM_KEYS,
} from '../lib/redfox.js'

test('extractDomain：剥 www、非法输入兜底', () => {
  assert.equal(extractDomain('https://www.zhihu.com/question/1'), 'zhihu.com')
  assert.equal(extractDomain('not a url'), 'not a url')
  assert.equal(extractDomain(''), '')
})

test('extractResult：豆包 searchGuid[].text_card', () => {
  const raw = {
    code: 0, data: {
      status: 'completed',
      result: {
        content: '推荐元气森林 <REF>1</REF>。第二是农夫山泉 [citation:1]。',
        searchGuid: [{ text_card: { title: '知乎回答', url: 'https://www.zhihu.com/q/1', sitename: '知乎' } }],
      },
    },
  }
  const { content, sources } = extractResult('doubao', raw)
  assert.equal(content.includes('<REF>'), false)
  assert.equal(content.includes('[citation:1]'), false)
  assert.ok(content.startsWith('推荐元气森林'))
  assert.deepEqual(sources, [{ title: '知乎回答', url: 'https://www.zhihu.com/q/1', domain: 'zhihu.com' }])
})

test('extractResult：元宝 searchGuid.docs[]', () => {
  const raw = {
    data: {
      result: {
        content: '回答',
        searchGuid: { docs: [{ title: '文档', url: 'https://docs.qq.com/1', web_site_name: '腾讯文档' }] },
      },
    },
  }
  const { sources } = extractResult('yuanbao', raw)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].domain, 'docs.qq.com')
})

test('extractResult：Kimi webPages + 无信源时 sources_note', () => {
  const raw = { data: { result: { content: '很长的一段回答'.repeat(30), webPages: [{ title: '页面', url: 'https://a.com/1' }] } } }
  const ok = extractResult('kimi', raw)
  assert.equal(ok.sources.length, 1)
  assert.ok(!ok.sources_note)
  const noSrc = extractResult('kimi', { data: { result: { content: '很长的一段回答'.repeat(30) } } })
  assert.equal(noSrc.sources.length, 0)
  assert.ok(noSrc.sources_note.includes('Kimi'))
})

test('extractResult：deepSearch 系通用 sources 字段 + data 层兜底', () => {
  const raw = { data: { result: { content: '答', sources: [{ url: 'https://b.com/2', title: 't' }] } } }
  assert.equal(extractResult('deepseek', raw).sources[0].domain, 'b.com')
  // result 非 dict 时：content 与 sources 都在 data 层
  const raw2 = { data: { content: '答', sources: [{ url: 'https://c.com/3', title: 't' }] } }
  assert.equal(extractResult('qianwen', raw2).sources[0].domain, 'c.com')
  assert.equal(extractResult('baidu', raw2).content, '答')
})

test('looksInvalid：限流话术与空白', () => {
  assert.equal(looksInvalid('高峰期算力紧张，请稍后再试哦'), true)
  assert.equal(looksInvalid('   '), true)
  assert.equal(looksInvalid('元气森林是无糖气泡水头部品牌，市占率领先，口感清爽，深受年轻消费者喜爱，常出现在各类推荐列表前列。'), false)
})

test('PLATFORM_KEYS：六平台齐全', () => {
  assert.deepEqual(PLATFORM_KEYS, ['doubao', 'kimi', 'deepseek', 'yuanbao', 'qianwen', 'baidu'])
  assert.equal(DEFAULT_API_BASE, 'https://redfox.hk')
})

// ── 假服务器：submit/poll/httpPostJson 端到端 ────────────────────────────
let srv
test('submit/poll：taskId 提取、3108 重试、pending→completed、失败抛错', async (t) => {
  let submitCalls = 0
  const pollCounts = new Map()
  srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url.endsWith('/submit')) {
        submitCalls++
        // 前两次 3108 限流，第三次成功（key 校验也顺便验证）
        if (req.headers['x-api-key'] !== 'ak_test') {
          res.end(JSON.stringify({ code: 401, message: 'bad key' }))
          return
        }
        if (submitCalls <= 2) res.end(JSON.stringify({ code: 3108, message: 'rate limited' }))
        else res.end(JSON.stringify({ code: 0, data: { taskId: 'T-123' } }))
      } else {
        const n = (pollCounts.get(payload.taskId) || 0) + 1
        pollCounts.set(payload.taskId, n)
        if (payload.taskId === 'T-FAIL') res.end(JSON.stringify({ code: 0, data: { status: 'failed', message: 'boom' } }))
        else if (n === 1) res.end(JSON.stringify({ code: 0, data: { status: 'processing' } }))
        else res.end(JSON.stringify({ code: 0, data: { status: 'completed', result: { content: 'done' } } }))
      }
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`

  const id = await submit('doubao', '问题', { apiKey: 'ak_test', apiBase: base, maxRetries: 3, timeout: 2000 })
  assert.equal(id, 'T-123')
  await assert.rejects(() => submit('doubao', '问题', { apiKey: 'ak_bad', apiBase: base, maxRetries: 0, timeout: 2000 }), /鉴权失败/)

  const pending = await poll('doubao', 'T-123', { apiKey: 'ak_test', apiBase: base, timeout: 2000 })
  assert.equal(pending, null)
  const done = await poll('doubao', 'T-123', { apiKey: 'ak_test', apiBase: base, timeout: 2000 })
  assert.equal(done.data.result.content, 'done')
  await assert.rejects(() => poll('doubao', 'T-FAIL', { apiKey: 'ak_test', apiBase: base, timeout: 2000 }), /搜索任务失败/)
})

test('httpPostJson：非 JSON 响应报错带片段', async () => {
  const hsrv = http.createServer((req, res) => { res.writeHead(200); res.end('<html>oops</html>') })
  await new Promise((r) => hsrv.listen(0, '127.0.0.1', r))
  await assert.rejects(
    () => httpPostJson(`http://127.0.0.1:${hsrv.address().port}/x`, {}, { timeout: 2000 }),
    /响应不是合法 JSON/,
  )
  await new Promise((r) => hsrv.close(r))
})

test.after(() => new Promise((r) => srv?.close(r)))
