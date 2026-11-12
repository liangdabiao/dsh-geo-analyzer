// 开发预览：把 GEO 品牌雷达面板跑在独立 http 服务上（复用 lib/api.js 路由 + 真实数据）。
//   DSH_HOME=<数据目录> node scripts/devserver.mjs [port]   默认 5179
// 想连真实 API 就在数据目录 settings.json 里放 api_key；留空则只看不搜。
import { createServer } from 'node:http'
import { registerApi } from '../lib/api.js'

const port = Number(process.argv[2]) || 5179
const routes = {}
const fakeCtx = { get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }
registerApi(fakeCtx, { config: {} })

createServer(async (req, res) => {
  try {
    await routes['/geo-analyzer'](req, res)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  }
}).listen(port, () => console.log(`[dev] http://127.0.0.1:${port}/geo-analyzer/  (DSH_HOME=${process.env.DSH_HOME || '~/.dsh'})`))
