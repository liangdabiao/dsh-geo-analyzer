// 系统提示注入：GEO 品牌雷达工作流硬规则（方法论细节在 geo-analyzer 技能里）。
export const SYSTEM_RULES = `## GEO 品牌雷达（geo-analyzer）

用户要「分析品牌在 AI 搜索里的表现 / GEO 分析 / 品牌 AI 可见度 / 竞品 AI 对比」时：

**流程**：geo_analyzer(action="create") 建运行（缺品类必须先追问）→ 生成问题（推荐类≥1，多场景+功能类合计≥4，一律不带品牌名，10-30 字，把列表给用户确认）→ queries_save 存问题 → search 启动六平台批量搜索（后台跑 3-5 分钟，工具秒回，用 status 查进度）→ read_answers 读回答 → 按 geo-analyzer 技能逐条做情绪/排名分析 → ai_save 存分析 → report 生成 HTML 报告并交付。

**硬规则**：情绪判断基于整段回答而非单句；只分析 status=completed 的回答；同一回答内 brand_rank 与竞品 rank 不得重复；竞品不限于用户列出的，发现新竞品也要写进 competitors_mentioned；失败/超时任务如实标注，不编造没拿到的回答。搜索等待期间可先告知用户预计时间，不要空转反复 status（30 秒一轮即可）。

**交付**：report 返回关键发现摘要，把 5 条核心结论完整输出给用户，并给出面板与 HTML 报告路径。无 AI 分析数据时报告情绪板块会显示占位，如实说明。`

export function systemSection() {
  return {
    name: 'geo-analyzer:workflow',
    order: 110,
    text: SYSTEM_RULES,
  }
}
