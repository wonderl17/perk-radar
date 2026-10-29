# GitHub 上的正式福利数据

公开仓库：https://github.com/wonderl17/perk-radar ，默认分支 `luke/main`。

`data/offers.json` 为已核验的正式福利；`data/sources.json` 是通过准入检查的信源注册表。福利含官方出处、首次收录时间、核验时间、期限及限制，自动发现的信源保留公开归属证据。它记录在Git中，可查历史、比较变化、提交纠错。待审内容、运行日志和凭据不属于公开数据。

`npm start` 内置维护在到期扫描后同步正式数据，`npm run maintain:due` 可执行同一维护到期检查。扫描未到期也补齐先前未同步的正式内容；发布重试不提前调用 GPT。维护者也可单独运行 `npm run sync:github` 同步本机正式数据到目标仓库。脚本先校验福利与信源两个文件，使用已有gh登录、内容SHA对比和逐文件带旧SHA的写入；无变化不提交，冲突即停止。两个文件分别提交，后一文件失败保留前一文件已完成更新。只更新这两个文件，不推送整个本机历史。提交身份使用noreply地址。

默认目标在 `data/github.json`，账号绑定 `wonderl17`、生产分支 `luke/main`；账号不匹配停止，fork或部署时改成自己的目标。Vercel Git 集成部署静态网站后，维护核对生产分支最新提交的部署状态和生产首页、公开 JSON、RSS，尚在部署时只安排下一次核对，不重复部署。GitHub只持久保存和分发正式文件，Vercel只验证、构建和托管静态站，不调用模型。维护独立于 Codex，仍需要 Node 常驻环境与持久磁盘，见 [maintenance.md](maintenance.md)。源码只从经过清理的公开 checkout 发布：先 fetch 并快进合并生产分支保留既有数据提交，禁止上传私人 Git 历史、运行状态、待审内容或凭据。
