# 数据约定 v1

`data/offers.json`: { schemaVersion: 1, updatedAt: ISO8601, offers: Offer[] }

Offer 必需字段：
- id: lowercase-hyphen unique slug
- title, provider, summary, benefit: 非空中文说明/品牌
- category: ai | developer | learning | life
- regions: 非空数组，cn | global；global 不是承诺全球所有地区均可领取
- availability: 明确地区和人群限制的文本
- eligibility, steps, caveats, tags: string[]；前三项至少一项
- publishedAt: ISO8601 | null（未知不补造）
- publication: 可选的消息发布日期判断，见下文；与首次收录、规则核验和活动开始时间独立
- discoveredAt, verifiedAt: ISO8601（首次收录时间、实际规则核验时间，人工或 GPT 完成核验后才更新）
- expiresAt: ISO8601 | null（null 表示官方未公布，不推断永久有效）
- offerType: ongoing | limited
- source: { name: string, url: https URL, evidence: string }
- status: published | withdrawn
- featured: boolean (optional)
- verification: optional；缺省兼容首批人工核验条目。GPT 自动条目必须为 `{ method: 'gpt', model: string, verifiedAt: ISO8601, evidenceHash: string, evidenceQuotes: [{ field: string, quote: string }] }`；内部 `verifiedAt` 与顶层一致，原文片段须可在本次抓取的官方证据中找到。`evidenceHash` 标识本次核验正文，不能凭模型自报的置信度发布。

前端时间流用 discoveredAt 降序；活动发布时间 publishedAt 独立显示。

## 消息发布时间判断

`publication` 是可选对象，字段严格为：

```json
{
  "value": "2024-02",
  "precision": "month",
  "certainty": "approximate",
  "basis": "published",
  "evidence": [{ "url": "https://example.com/announcement", "quote": "Announced in February 2024." }],
  "reasoning": "官方公告能确认发布月份，未确认具体日期。",
  "assessedAt": "2026-10-28T03:00:00Z",
  "method": "gpt-web-search",
  "model": "本次实际调用的模型"
}
```

- `value` 不补造精度：年为 `YYYY`，月为 `YYYY-MM`，日为 `YYYY-MM-DD`，分钟为 `YYYY-MM-DDTHH:mmZ` 或 `YYYY-MM-DDTHH:mm±HH:mm`。分钟值不含秒，必须有明确时区；不得为了适配 ISO 把年份补成 1 月 1 日或把日期补成午夜。
- `precision` 为 `year | month | day | minute | null`；`certainty` 为 `exact | approximate | unknown`。年、月只能 `approximate`；`exact` 只允许日或分钟。
- `basis: published` 表示有公开依据的消息发布日期；`available_by` 只表示不晚于该时间已存在公开消息，必须 `approximate`，不能说成确切首发日期。福利版本、地区及权益须与该消息一致，不能用品牌成立或其他旧福利的日期替代。
- 未知必须为 `value: null, precision: null, certainty: unknown, basis: null`。未知结果也保留判断说明和核查时间，不能回退成首次收录或抓取时间。
- 非未知结果必须保留 1–3 条 `evidence`，未知允许 0–3 条。每条严格为无凭据 HTTPS `url`（最多 2000 字符，不允许本机、内网主机或 IP 字面量）及本次公开页面的逐字 `quote`（3–260 字符）；只保存可公开的短证据，不保存原始响应、待审报告或凭据。实际抓取还须执行公网 DNS 与连接检查。搜索摘要只作线索，实际原文、日期语义和同一福利身份仍须核对；机械日期匹配本身不能证明日期含义。
- `reasoning` 为 1–600 字符；`assessedAt` 为带秒和时区的真实 ISO 时间，允许最多 5 分钟时钟偏差。`method` 为 `gpt-web-search | manual`，GPT 必须有非空 `model`（最多 200 字符），人工可省略。
- 日期必须是真实日历，范围从 1970 年到当前；年/月/日按上海当前日历比较，分钟按实际时间比较。日期也不能晚于首次 `discoveredAt`：同年/月粗粒度允许，日按上海日期比较，分钟按实际时间比较。文档更新、活动开始、HTTP 修改时间或搜索抓取时间不能自动当作消息发布依据。

`publishedAt` 保留历史 `ISO8601 | null` 契约，不从粗粒度 `publication` 自动映射，也不改写原值。`publication.assessedAt` 只记录日期判断，不能刷新规则 `verifiedAt` 或首次 `discoveredAt`。日期再核查必须保留人工更正及已有有效证据，网络失败与无公开依据的未知结果分开处理。

日期/状态派生函数放 src/domain.mjs，供前端和测试复用。
采集配置 data/sources.json 为来源数组（ID/name/url/kind/region），kind page|rss，原始来源抓取只提供候选，不能直接写 published offer；`npm run ingest` 会在 GPT 结构化提取与证据校验通过后自动写入正式福利。
待审候选输出 work/candidates.json；GPT 证据不足、规则含糊或冲突时保留待审，成功完成规则核验才能更新 verifiedAt。自动收录保留首次发现时间，不将本次运行时间伪装成新活动发布时间。
已发表记录超过 7 天未完成规则复核，界面标记“待复核”。失败网络抓取不推断活动失效。
