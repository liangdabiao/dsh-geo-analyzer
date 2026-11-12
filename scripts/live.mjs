// 真实网络冒烟：1 个问题 × 2 个平台（doubao+kimi 最快），全链路到 HTML 报告。
//   DSH_HOME=<目录> node scripts/live.mjs <brand> <category> [ak_xxx]
// key 优先级：命令行第三参 > 数据目录 settings.json > 环境变量 REDFOX_API_KEY。
// 等待约 1-4 分钟（30 秒一轮轮询）；DeepSeek 系平台较慢，冒烟刻意避开。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , brandArg, categoryArg, keyArg] = process.argv
const brand = brandArg || '元气森林'
const category = categoryArg || '无糖气泡水'
const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE, '.dsh')

if (keyArg) {
  mkdirSync(join(home, 'geo-analyzer'), { recursive: true })
  writeFileSync(join(home, 'geo-analyzer', 'settings.json'), JSON.stringify({ api_key: keyArg }, null, 2))
  console.log('API key 已写入 settings.json')
}
const { getSettings } = await import('../lib/store.js')
if (!getSettings().api_key && !process.env.REDFOX_API_KEY) {
  console.error('缺少 RedFox API Key：node scripts/live.mjs <品牌> <品类> ak_xxx')
  process.exit(1)
}

const { geoAnalyzerTool } = await import('../src/host.js')
const call = (args) => geoAnalyzerTool.execute(args, {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`真实冒烟：品牌「${brand}」品类「${category}」 1 题 × 2 平台（doubao/kimi）`)
let r = await call({ action: 'create', brand, category, platforms: 'doubao,kimi' })
const runId = r.summary.match(/runId=([\p{L}\p{N}-]+)/u)?.[1]
console.log(r.summary)

const query = `${category}哪个品牌好？`
r = await call({ action: 'queries_save', runId, queriesJson: JSON.stringify([query]) })
console.log(r.summary)

const t0 = Date.now()
r = await call({ action: 'search', runId })
console.log(r.summary)
let done = false
while (!done) {
  await sleep(15000)
  r = await call({ action: 'status', runId })
  const line = r.data?.split('\n')[1] || r.summary
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${String(line).replace(/\n/g, ' ')}`)
  done = r.summary.includes('搜索已结束')
  if (Date.now() - t0 > 6 * 60_000) { console.log('超过 6 分钟，强制结束等待'); break }
}
if (!done) process.exit(1)

r = await call({ action: 'read_answers', runId })
console.log(`\n${r.summary}`)
if (r.data) console.log(r.data.slice(0, 1200) + '\n…')

// 真实情绪分析这里留给会话模型；live 冒烟只验证数据面 → 直接出确定性报告
r = await call({ action: 'report', runId })
console.log(`\n${r.data}`)
