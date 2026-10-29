# 项目常驻维护

`npm start` 同时启动网页服务和一条项目维护调度，按顺序执行扫描到期检查、正式数据同步和 Vercel 生产核对。它使用项目自身的持久状态，不依赖 Codex 定时任务，也不安装系统 cron、LaunchAgent 或云端扫描器。

```sh
npm start
# 网页服务 + 持续维护

npm run maintain:due
# 执行一次完整维护的到期检查

npm run maintain:status
# 只查看本机维护状态，不调用模型、不写远端

npm run scan:status
# 查看原有扫描器的独立状态
```

## 配置与运行条件

`data/maintenance.json` 默认配置：

```json
{
  "enabled": true,
  "intervalMinutes": 60,
  "retryIntervalMinutes": 5,
  "deploymentPollMinutes": 1
}
```

常规维护每 60 分钟检查；同步或生产核对失败 5 分钟后重试；提交已存在而 Vercel 尚在部署时，1 分钟后再核对。单次核对完成就返回，不阻塞等待一分钟。维护只通过原扫描器的到期入口触发 GPT，扫描仍每 60 分钟一次、核心失败 15 分钟后重试；`data/runtime.json`、自主发现和日期查证的独立限额不变。发布失败不会提前启动新一轮 GPT，也不使用 `scan:now`、`ingest` 或 `dates:backfill` 绕过预算。

需要 Node.js、可用 Hermes/GPT 运行配置、`gh` 登录、网络和持久磁盘。GitHub 账号必须与 `data/github.json` 一致；当前目标为 `wonderl17/perk-radar`、账号 `wonderl17`、生产分支 `luke/main`。凭据只留在受限本机配置或运行时环境，不写入项目、命令参数、日志或网页。

退出 Codex 后，只要 Node 服务独立运行就可继续维护。电脑睡眠、关机或服务进程退出期间不能运行。若需要这些时段仍持续维护，可把同一 Node 服务迁到常驻服务器；本次没有创建云资源或系统级后台服务。Vercel 只负责静态网站，不运行扫描服务。

## 扫描、同步与发布

维护与单独的 `scan:due` 共用扫描状态及跨进程锁，并另用跨进程维护锁防止两个维护进程同时发布。其他进程正在扫描时保留维护工作，约 30 秒后重检；扫描完成再同步，避免把扫描中的中间结果当作完成。

同步只更新经过校验的 `data/offers.json` 与 `data/sources.json`，无变化不提交。每份文件用自身旧 SHA 防覆盖，部分成功不回滚；下一次比较实际差异后补齐。维护不会提交源码、待审内容或私人历史，源码发布仍从经过清理的公开 checkout 进行，见 [github.md](github.md)。

生产核对读取 GitHub 生产分支最新提交，检查该提交的 Vercel 生产部署状态，再读取真实生产域名的首页、公开 JSON 和 RSS，核对内容是否与正式数据一致。旧部署可访问或 GitHub 写入成功都不能单独作为完成依据。部署等待期间只查询状态；不主动重复部署、建仓库或建 Vercel 项目。失败不删除已核验内容，保留阶段状态并按重试间隔恢复。

## 状态与排查

- `work/maintenance-state.json`：持久保存维护状态、上次尝试和下一次检查时间。
- `work/maintenance-report.json`：最近一次维护的扫描、GitHub 同步和生产核对摘要。
- `work/scan-state.json` 及原有采集、发现、日期报告：保留各阶段自己的状态和预算。
- `/api/health`：服务、扫描与维护的安全摘要，不含凭据、模型配置或原始错误。

这些文件位于忽略的 `work/`，不能上传公开仓库或静态站点。优先用状态命令和项目日志判断阻塞阶段；网络、登录或部署问题恢复后由维护重试补齐，不靠删除状态文件提前重复付费调用。正常无变化只更新本机检查状态，不产生新提交或重复部署，不自动给他人发送消息。
