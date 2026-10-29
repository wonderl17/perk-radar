# 福利雷达 · Perk Radar

在线访问：https://perk-radar.vercel.app

面向中国与全球的福利信息流：AI积分、免费额度、开发者工具、学习资源与生活活动。按首次收录时间排列，公开说明领取条件、地区、期限和官方出处。

这是项目当前源码与已核验数据的公开快照。福利数据持续通过文件版本提交同步；未包含创建者的私人部署配置、旧本机Git历史、凭据或待审内容。

## 公开数据

- 正式数据：[`data/offers.json`](data/offers.json)
- 信源配置：[`data/sources.json`](data/sources.json)
- 数据约定：[`docs/data-contract.md`](docs/data-contract.md)
- 常驻维护：[`docs/maintenance.md`](docs/maintenance.md)
- 定期扫描：[`docs/automation.md`](docs/automation.md)
- 自主搜索与信源扩充：[`docs/discovery.md`](docs/discovery.md)
- 消息发布时间查证：[`docs/publication.md`](docs/publication.md)

“GPT 自动核验”表示根据官方公开证据提取并校验规则，不代表人工实领、库存或个人资格保证。未知期限不编造截止日，过期活动从发现页归档；出现冲突会标待复核。

## 本地运行

页面预览与静态构建需要 Node.js 22+，无第三方 Node 依赖；自主联网搜索另需独立 Python 环境与 `requirements-search.txt`。安装步骤见 [`docs/discovery.md`](docs/discovery.md)，不会修改 Hermes 环境。

```sh
git clone https://github.com/wonderl17/perk-radar.git
cd perk-radar
npm run dev
# http://127.0.0.1:4173，只预览公开数据，不调用模型

npm start
# 页面服务 + 到期扫描 + GitHub正式数据同步 + Vercel生产核对

npm run maintain:status
npm run maintain:due
npm run scan:status
npm run scan:due
npm test
npm run check:data
npm run build
```

扫描默认每1小时一次，核心失败15分钟重试，自主发现异常保留独立状态与预算时间，每轮最多6份证据；配置在 `data/runtime.json`。维护配置在 `data/maintenance.json`，默认60分钟检查，发布失败5分钟重试、部署中1分钟后核对；发布重试不提前调用 GPT，无变化不提交、不重复部署。维护与扫描各自持久保存 `work/` 中的状态并共享跨进程锁，重启不会提前重复扫描。退出 Codex 后，独立运行的 Node 服务可继续；电脑睡眠、关机或服务停止期间不能维护。未新增 Codex计划、系统cron或LaunchAgent。

## GPT 自动收录

GPT 规划中英文查询 → DDGS 真实联网搜索并在同一预算内追踪第一方规则 → 规则页与同站首页的官方身份准入 → 扩充信源 → 官方页面/RSS采集与URL去重 → GPT结构化提取 → 原文证据校验 → 第二轮独立核对 → 自动收录。不局限于初始的 21 个来源；默认每轮 2–4 个查询、最多新增 2 个信源，注册表默认上限 200 条，参数见 `data/discovery.json`。信源通过不等于福利通过；证据不全或规则含糊的保留待审，抓取成功不等于重新核验。

默认读取本机Hermes配置；也支持运行时传入完整的 `PERK_LLM_API_KEY`、`PERK_LLM_BASE_URL`、`PERK_LLM_MODEL`，可指定API模式和推理强度。密钥不写入仓库、日志、前端或命令参数。没有模型配置时仍可用 `npm run dev` 浏览已收录数据。

`npm run sync:github` 只同步正式福利与经过校验的信源注册表，使用既有gh登录及逐文件旧SHA防并发覆盖；fork后先修改 `data/github.json` 的仓库和account账号。

## 网站部署

`dist/` 为静态构建输出，`vercel.json` 已配置校验和构建命令。在 Vercel 导入本仓库并绑定 `luke/main` 生产分支后，提交正式数据将自动部署。项目维护会核对分支最新提交的 Vercel 生产部署及首页、公开 JSON、RSS，部署中只安排下次核对，不重复发布。源码更新只从经过清理的公开 checkout 提交，先 fetch 并快进合并远端生产分支，保留已有数据提交。RSS 优先使用显式 `SITE_URL`，其次使用 Vercel 的 `VERCEL_PROJECT_PRODUCTION_URL`，本地回退到 `data/site.json`。扫描继续使用独立的本机 Hermes 运行环境，Vercel 构建不安装 Python 搜索依赖、不调用模型，也不需要模型密钥。

工作流仅保存在 [`docs/examples/collect.workflow.yml`](docs/examples/collect.workflow.yml) 作为未启用示例。它不是云端GPT服务；启用前自行审阅权限和输出，不要把待审队列或密钥放进公共artifact/cache。

## 设计取舍

借鉴 [AIHOT](https://github.com/KKKKhazix/AIHOT) 的配置化信源、先去重后处理及健康记录，独立实现福利规则、证据校验和界面，没有复制其代码或视觉。详见 [`docs/research.md`](docs/research.md)。

不收录拉人头、批量注册、套现或无法追溯的权益；无推广链接、无付费排名。各项福利最终以官方当前规则为准。
