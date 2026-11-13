# dsh-geo-analyzer · GEO 品牌雷达

DeepSeek Harness（dsh）插件：**品牌在 AI 搜索引擎里的可见度分析（GEO）**。
向豆包、Kimi、DeepSeek、元宝、千问、百度六大 AI 搜索提出相同问题，分析品牌提及率、排名、情绪、信源引用、竞品对比，生成交互式 HTML 报告 + 侧栏看板。

移植自 [redfox-data/redfox-community](https://github.com/redfox-data/redfox-community) 的 `skills/geo-analyzer`（API 用例与方法论参考；另采纳了同仓库 `brand-geo-analysis-plus` 的三处健壮性改进：限流话术记 invalid 排除出分母、内联引用标记剥离、信源缺失提示）。Python 脚本全部重写为 Node 原生实现，**零 Python 依赖**。
<img width="2490" height="1404" alt="image" src="https://github.com/user-attachments/assets/ecffcb4a-db3a-4f47-b791-3b093421a8b2" />


## GEO vs SEO

SEO 是让百度/Google 搜到你，GEO 是让 AI 在回答里"提到你"。如果 AI 回答里提到你的竞品却没提到你——你在 AI 时代就是隐形的。

插件回答三个问题：

1. **提及率**：问 AI「XX品类哪个品牌好」，它会不会提到你？（分平台 × 分问题热力矩阵）
2. **怎么提**：排第几？推荐还是提醒防坑？（情绪分析 + 平均排名）
3. **凭什么**：AI 的信源是谁？你的官网在不在被引用列表里？（域名 TOP10 + 引用文章）

## 工作流（agent 对话为主，面板为辅）

```
create 建运行（品牌+品类，缺品类 agent 会追问）
  → 生成 5 个问题（推荐类≥1，多场景+功能类≥4，一律不带品牌名）→ 用户确认
  → queries_save → search（5×6=30 任务后台并行，3-5 分钟，面板实时进度矩阵）
  → read_answers → 会话模型逐条分析情绪/排名/竞品 → ai_save（分批）
  → report（GEO 综合得分 + 交互式 HTML 报告 + 关键发现 5 条）
```

**GEO 综合得分** = 提及率×100×40% + max(0, 100−(均排名−1)×10)×30% + 正面率×100×30%（正面率=1−负面率，中性计入正面）。70+ 优秀 / 50-69 良好 / 30-49 一般 / <30 不足。

情绪与排名分析由**会话模型**完成（工具不调外部 LLM），确定性分析（提及检测/域名统计/矩阵/得分）由脚本完成——同一份回答，谁擅长什么就干什么。

## 面板（侧栏「GEO 品牌雷达」）

- **概览**：运行历史、进行中搜索、Key 状态；一键「开始一次分析」开新对话
- **新建分析**：品牌/品类/别名/竞品/平台勾选，创建后可直接在面板改问题、点「保存并开始搜索」
- **运行详情**：问题编辑（带品牌词泄漏警告）、实时进度矩阵（OK/INVALID/FAIL/…）、GEO 摘要卡（得分/提及率/平均排名/正面率）、分平台提及率条、竞品 TOP、「打开完整报告」
- **设置**：RedFox API Key（本机存储）、代理、接口地址

HTML 报告单页交互式：顶部锚点导航、报告摘要、品牌指纹、提及矩阵热力表、情感分析、信源分析（域名/文章 TOP10 + 数据完整性提示）、竞品对比（可展开分平台明细）、原始存档（品牌词高亮、可折叠）。

## 配置

**RedFox API Key**（必需，`ak_` 开头）：[红狐 hub](https://redfox.hk/settings/api-keys?source=github) 获取。三级优先：插件配置 `apiKey` > 面板「设置」页 > 环境变量 `REDFOX_API_KEY`。

> ⚠️ 2026-11 实测：RedFox 六个 AI 搜索提交接口**已升级为仅付费调用**（免费积分不适用，官方为防批量薅羊毛调整了计费），需要在 [redfox.hk/dashboard/recharge](https://redfox.hk/dashboard/recharge) 充值后使用。插件遇到 3203 会明确提示。

其余配置（`Config` schema）：`injectRules` 注入工作流硬规则（默认开）、`proxyUrl` 访问 redfox.hk 走代理（默认直连）。

## 安装

```bash
dsh plugin add https://github.com/liangdabiao/dsh-geo-analyzer
```

依赖自动安装（仅 `@deepseek-ai/schemastery`；HTTP 层是 node:https 手写的，零第三方运行时依赖）。数据在 `~/.dsh/geo-analyzer/`（`DSH_HOME` 可改）。

## 开发

```bash
npm i
npm run build      # client.js → dist/client.js（esbuild 单文件 + 幂等包装）
npm test           # 29 个单测（分析口径/响应提取/runs 生命周期/报告生成）
npm run smoke      # 离线冒烟：本地假 RedFox 服务器全链路（工具直调 + 面板 API）
npm run live       # 真实 API 冒烟：node scripts/live.mjs <品牌> <品类> ak_xxx（1题×2平台）
npm run dev        # 面板独立预览：DSH_HOME=<目录> node scripts/devserver.mjs 5179
```

数据落在 `$DSH_HOME/geo-analyzer/`：`settings.json` + `runs/<runId>/`（meta/原始回答/AI 分析/合并指标/HTML 报告），原子写（tmp+rename）。

## 结构

```
src/host.js            geo_analyzer 工具（8 个 action）+ 装配
src/systemPrompt.js    工作流硬规则注入
lib/redfox.js          6 平台适配器（提交/轮询/提取/限流重试/错误码翻译，可选代理隧道）
lib/search.js          批量调度（宿主后台任务，进度持久化，工具秒回）
lib/analyzer.js        确定性分析 + 合并 + GEO 得分（口径对齐上游 analyzer.py）
lib/report.js          HTML 报告生成器（report_template.py v6 移植 + 3 处本地化修正）
lib/store.js           runs/<id> 持久化 + 设置
lib/api.js             /geo-analyzer 面板路由
client.js / lab/       浏览器半边（侧栏入口 + iframe 面板，明暗跟随 dsh 主题）
skills/geo-analyzer/   分析方法论技能（SKILL.md + geo-metrics.md）
```

## License

MIT（本插件代码）。方法论与 API 用例参考 redfox-data/redfox-community（上游未附许可证文件，仅作技术参考；RedFox API 使用受其服务条款约束）。


## 特别致谢

https://linux.do 社区支持
