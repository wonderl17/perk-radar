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
- discoveredAt, verifiedAt: ISO8601（首次收录时间、实际规则核验时间，人工或 GPT 完成核验后才更新）
- expiresAt: ISO8601 | null（null 表示官方未公布，不推断永久有效）
- offerType: ongoing | limited
- source: { name: string, url: https URL, evidence: string }
- status: published | withdrawn
- featured: boolean (optional)
- verification: optional；缺省兼容首批人工核验条目。GPT 自动条目必须为 `{ method: 'gpt', model: string, verifiedAt: ISO8601, evidenceHash: string, evidenceQuotes: [{ field: string, quote: string }] }`；内部 `verifiedAt` 与顶层一致，原文片段须可在本次抓取的官方证据中找到。`evidenceHash` 标识本次核验正文，不能凭模型自报的置信度发布。

前端时间流用 discoveredAt 降序；活动发布时间 publishedAt 独立显示。
日期/状态派生函数放 src/domain.mjs，供前端和测试复用。
采集配置 data/sources.json 为来源数组（ID/name/url/kind/region），kind page|rss，原始来源抓取只提供候选，不能直接写 published offer；`npm run ingest` 会在 GPT 结构化提取与证据校验通过后自动写入正式福利。
待审候选输出 work/candidates.json；GPT 证据不足、规则含糊或冲突时保留待审，成功完成规则核验才能更新 verifiedAt。自动收录保留首次发现时间，不将本次运行时间伪装成新活动发布时间。
已发表记录超过 7 天未完成规则复核，界面标记“待复核”。失败网络抓取不推断活动失效。
