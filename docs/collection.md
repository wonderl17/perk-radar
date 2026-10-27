# 发现、核验与自动收录

来源采集只读公开官方页面，无需登录来源。GPT 自动收录使用与本机 Hermes 相同的模型和接口配置，在运行时读取已有凭据，不把凭据复制到仓库、浏览器、日志或命令参数。当前是可配置的官方来源监测，不声称已覆盖全网或全球所有活动。

## GPT 自动收录

```sh
npm run ingest
```

流程为 **采集 → 去重 → GPT 结构化提取 → 官方证据校验 → 写正式福利 → 构建站点**。GPT 提取具体权益、适用人群、地区、领取步骤、期限和风险；证据完整、字段有效且通过去重校验即可自动收录，不需要逐条人工批准。官方没有公布的时间写 `null`，不得让模型补造金额、截止日或资格。

证据不足、规则含糊或冲突、已过期、模型返回异常或无法读取的内容不会直接发布，保留待审及失败记录。抓取成功本身不能刷新 `verifiedAt`；只有完成本次规则提取和证据校验后才更新核验时间。首次 `discoveredAt` 保留不变。

自动条目的 `verification` 记录 `method: gpt`、实际模型、核验时间、正文 `evidenceHash` 与对应字段的 `evidenceQuotes`。证据片段须能在本次抓取的官方正文中找到，模型自报置信度不能代替证据。页面明确区分“GPT 自动核验”和历史人工核验条目；两者均不表示人工登录实领，个人资格和库存以领取时为准。

`ingest` 更新本地正式数据与 `dist/`；后台任务随后运行 `sync:github`，由 Vercel 的 Git 集成构建部署网站。单独运行 `ingest` 不等于线上部署成功。Node.js 22+，运行前需保证本机 Hermes 配置可用；不能把本机配置及密钥直接复制进公开部署包。

## 单独发现线索

```sh
npm run collect
```

`collect` 只负责抓取、发现线索与变化检测，不调用 GPT，不会覆盖、核验或发布 `data/offers.json`。这使来源检查和模型收录可以独立调试。

- `data/sources.json` 定义官方来源，支持 `page` 与受限 RSS/Atom 解析；新域名要先确认官方归属。
- 每个来源默认只接受该 URL 的 host；官方跨域跳转需在该来源 `allowedHosts` 数组明确列出所有允许的完整 host。
- 并发 3，单次请求 12 秒，正文默认上限 1 MiB，重定向最多 5 次。来源可选配置 `maxBytes`（字节数），必须为 1–4194304 的整数，最大严格限制为 4 MiB；超限、负数或字符串均拒绝抓取。当前 Qoder 规则页经过有界抓取测得约 1.06 MiB，仅该来源设为 2 MiB。仅接受公开域名 HTTP(S)，拒绝 URL 中的凭据、IP 地址和未声明域名。
- `work/candidates.json` 保存关键词发现的线索，`firstDiscoveredAt` 保留第一次发现时间，`lastSeenAt` 仅代表抓取时再次见到。未经 GPT 提取及证据校验的原始线索不能直接作为正式福利。
- URL 去除已知营销参数和片段、排序查询参数；保留 `ref`、`id`、`code` 等可能影响业务的参数。同一来源或活动的重复线索需合并，不能靠传播链接数量提高排名。
- `work/health.json` 的 `sources` 记录来源健康状况、上次成功正文摘要 `contentHash`、`lastSuccessAt`、`consecutiveFailures`。首次成功只建立 baseline；抓取失败保留上次成功摘要与时间，连续失败计数增加，不推断过期。
- `work/changes.json` 保存正文变化的待复核记录。正文经 `plainText` 清理 script/style/noscript 和 HTML 标签，优先使用 main/body，减少 JS 资源和样式改版造成的噪声。正文摘要改变只是检测信号，不代表已经确认权益规则改变。
- 正文变化记录包含精确匹配来源 URL 的正式 `affectedOfferIds`、`firstDetectedAt`、`lastDetectedAt` 与变化前后摘要。未处理的同源变化合并并保留首次发现时间，后续重新核验仍须实际读取官方证据。

JS 渲染、登录墙、反爬或跨域重定向可能使来源暂不可读；失败保留在健康报告，不把活动标为失效，也不绕过来源访问限制。

## 人工补充与纠错

自动收录是默认路径，人工 CLI 用于补齐证据、修正条目或处理无法自动确认的内容。按 `docs/data-contract.md` 写入完整 Offer，`source.evidence` 简短记录官方页面支持的结论，`verifiedAt` 使用实际核验时间，不编造活动发布时间或期限。

```sh
npm run review -- --file work/reviewed-offer.json
# 明确更正或复核现有条目，保留首次收录时间
npm run review -- --file work/reviewed-offer.json --replace
npm run check:data
npm test
npm run build
```

同一来源 URL 或 ID 的重复记录会被拒绝。人工纠正 GPT 条目时，应移除旧的 GPT `verification` 并填本次人工核验时间，避免把人工修改误标为旧模型判断。审核命令更新本地正式数据，更新线上网站仍需部署。

对 `work/changes.json` 的 `pending` 记录，比较新的官方依据与正式条目；变化可能来自导航、日期或地区显示，不能只凭摘要变化判优惠失效。完成复核后可设 `status: reviewed`，添加 `reviewedAt`、`notes`，避免后续变化并入已完成记录。正式福利可用 `status: withdrawn` 记录撤回；失败网络抓取不能自行撤回。超过 7 天未完成规则核验，界面标记待复核。

## 构建与运行

```sh
npm start
# HTTP 服务 + 定期扫描
npm run scan:status
# 只查看扫描状态
npm run dev
# 仅页面预览，不扫描
npm run build
npm run preview
```

开发和预览默认仅监听 `127.0.0.1:4173`，可加 `-- --port 4174`。`SITE_URL` 或 `data/site.json` 的 `siteUrl` 必须为真实网站 origin，用于 RSS channel。`dist/` 仅包含页面、src、公有资源、正式福利 JSON 与 RSS；待审线索、抓取日志、来源配置、Hermes 配置和脚本均不发布。

RSS `/feed.xml` 按首次收录时间排序，指向官方活动页面；构建时排除已撤回和已到明确截止时间的条目。`null` 期限只代表未公布。

## 定时运行边界

项目内调度随 `npm start` 运行，启动即检查是否到期，默认每 1 小时扫描，每轮最多处理 6 份证据，执行失败 15 分钟后重试。`data/runtime.json` 配置间隔与数量，`work/scan-state.json` 保存上次成功与下一次扫描时间；重启不会提前重复调用模型。`npm run scan:due` 使用同一到期检查与跨进程锁，`npm run scan:status` 只查看状态。

现有 Codex 任务每 1 小时调用 `scan:due` 作为兜底，并检查是否有尚未部署的变化。项目自身扫描只需电脑、Node 服务、Hermes 配置和网络，不依赖 Codex；兜底任务同步正式数据至 `wonderl17/perk-radar` 的 `luke/main` 生产分支后，由 Vercel Git 集成构建静态网站。即使本轮扫描跳过，也会检查之前未同步的数据和未完成的 Vercel 发布。Vercel 不运行本机模型或扫描调度。具体步骤见 `docs/automation.md`。下文 GitHub Actions 是独立、尚未启用的原始发现配置。

`docs/examples/collect.workflow.yml` 提供每天北京时间 09:15 的原始采集工作流和手动触发入口。只有把项目上传到启用 Actions 的 GitHub 仓库后才会运行；当前尚未启用远端定时执行。这个工作流仅运行 `collect`，上传候选、变化和健康 artifact，并缓存候选历史与正文 baseline，不调用本机 Hermes、不执行 GPT 自动收录，也不自动发布。

若迁移到其他常驻运行环境，需要接入对应的模型配置、凭据与站点发布通道。不要把本机 Hermes 密钥写入工作流文件。缓存可能被平台淘汰，丢失 baseline 后首次成功会重新建基线；artifact 保留 14 天，需要永久审计历史时再接数据库。
