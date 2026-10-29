# Project guidelines

- 福利雷达面向中国与全球用户，默认中文。不得编造活动、奖励金额、截止时间、热度或用户数。
- 网站只读取正式 `data/offers.json`；通过校验的 `data/sources.json` 是公开信源注册表。原始候选、运行状态、健康报告和日志留在忽略的 `work/`。
- GPT 自主规划中英文查询，经独立 DDGS 真实搜索后选择候选；先核对规则页、同站首页、关联与官方身份，通过准入才扩充信源，不能凭记忆编造 URL。
- 信源准入不等于福利通过。GPT 必须根据本次官方证据提取并复核规则，证据不足保留待审。抓取成功本身不能更新核验时间；区分 GPT 自动核验与人工核验。
- 凭据仅来自受限本机配置或运行时环境，不进入代码、日志、浏览器或命令参数。
- `npm start` 启动页面和项目维护调度：原有到期扫描、正式数据同步、Vercel 生产核对。后台完整维护用 `npm run maintain:due`，状态用 `npm run maintain:status`；单独扫描继续用 `scan:due`，共用原有状态、锁、间隔与预算。`npm run dev` 只预览。
- 维护发布失败独立重试，不提前调用 GPT；无变化不提交，待部署只核对不重复部署。其他进程扫描时保留维护工作，完成后再同步。状态与报告留在忽略的 `work/`，健康接口只输出安全摘要。
- 自动运行不依赖 Codex 计划，不新增系统 cron、LaunchAgent 或 Vercel Cron，不自动给他人发消息；电脑睡眠、关机或服务退出期间不能维护。
- GitHub 同步使用 `data/github.json` 绑定账号，当前为 `wonderl17`，仓库 `wonderl17/perk-radar`、生产分支 `luke/main`；账号不匹配停止。只同步正式 offers 与通过校验的 sources 两份 JSON，逐文件旧 SHA 防覆盖。源码只从经过清理的公开 checkout 发布，不上传私人历史、待审内容或凭据；Vercel 只托管静态站点。
- 验证受影响范围：`npm test`、`npm run check:data`、`npm run build`；未经用户要求不做网页自动化测试，不跑全仓 type-check。
- 浏览器仅使用原生 cua 或连接能力；不得使用 Chrome 9222、旧 chrome-devtools 独立入口，也不在迁移时恢复这些入口。
- 默认采用最小可靠改动；bugfix先定位原因，新功能先分析需求与缺口。
- 新分支使用 `luke/` 前缀。已有项目留在当前 checkout 开发，用户全局目录和工具约定优先。
