# 定期扫描与公开数据

运行 `npm start` 同时启动 HTTP 服务和项目内定期扫描。默认每6小时检查一次，每轮最多处理6份官方证据，失败15分钟后重试。配置见 `data/runtime.json`，可通过 `PERK_SCAN_INTERVAL_MINUTES`、`PERK_SCAN_LIMIT`、`PERK_SCAN_RETRY_MINUTES` 覆盖。修改后重启服务，已经保存的下一次时间保留，后续周期使用新配置。

`work/scan-state.json` 保存执行状态、上次成功和下一次时间；`npm run scan:status` 只查询，`npm run scan:due` 仅在到期时扫描。共享锁避免与常驻服务重复执行。工作目录必须位于持久磁盘；复制仓库不包含该本机运行状态。

模型默认通过本机 Hermes 原生配置读取，或使用完整的 `PERK_LLM_API_KEY`、`PERK_LLM_BASE_URL`、`PERK_LLM_MODEL` 运行时配置。可指定 `PERK_LLM_API_MODE` 和 `PERK_LLM_REASONING_EFFORT`。不复制或提交密钥；网页前端从来不调用模型。

采集、结构化提取、原文证据校验和第二轮审核全部通过才写正式福利，保留模型、时间与证据。长正文、冲突、过期和缺依据条目不直接发布；不以模型自信代替原文依据。核验不表示库存或个人资格保证。

`npm run sync:github` 通过已登录 gh CLI 只同步正式 `data/offers.json`，无差异不提交，更新带旧文件 SHA 防止覆盖并发更改。仓库与分支在 `data/github.json`，fork后先修改为自己的目标仓库。它不推送本机Git历史、不保存Token。网站部署是独立步骤。

仓库本身不等于常驻服务。原始工作流仅作为 `docs/examples/collect.workflow.yml` 示例保存，未启用云端GPT或定时工作流。启用前应自行审阅权限、运行配置及公共缓存/artifact内容，不能公开待审队列。
