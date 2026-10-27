# GPT 自主搜索与信源扩充

正常的每小时扫描包含自主发现，不需要维护者逐个填写新来源。GPT 根据当前日期、已有福利、历史查询和轮换主题规划中英文搜索词；DDGS 执行真实联网搜索，再由 GPT 筛选新线索。现有来源继续监测，新来源经过准入后自动追加，不局限于初始 21 个来源。

这是一条有预算与证据门槛的发现流程，不代表覆盖全网，也不保证每轮都会找到或发布新福利。

## 一轮如何运行

1. GPT 规划 2–4 个查询，必须同时覆盖中国与全球；主题轮换包含 AI/效率、开发者与教育、生活文化及其他公开福利，参考上一轮查询减少重复。
2. DDGS 搜索每个查询最多 5 条结果。模型只能选择本次结果的 ID，不能凭记忆编造网址；搜索摘要只是线索，不能直接充当福利规则。
3. 默认最多检查 3 个候选。只读取公开 HTTPS 页面，先做域名、DNS 与连接检查，再读取规则页及同 host 的首页（允许明确的 www 变体）；两页之间必须存在可核对的链接关系。
4. 独立 GPT 审核对照规则、品牌身份和页面关系，给出首页身份片段与规则页权益片段。两段引用必须在本次原文中找到，审核须为 approve、official=true 且 confidence ≥ 0.97。这个数值是程序的准入阈值，不是经过校准的真实性概率或官方认证保证。
5. 单轮最多将 2 个通过检查的信源追加到 `data/sources.json`，保留模型、时间、查询、主页、原文摘要与短证据片段，再放入待核验候选队列。**信源准入不等于福利通过**；新福利继续经过结构化提取、原文与字段校验、独立第二轮规则审核，全部通过才写入 `data/offers.json`。

新发现的合格候选会获得一份处理位置，避免一直被旧信源复核挤出；每轮福利核验总量仍由 `data/runtime.json` 控制，默认最多 6 份证据。证据不足、疑似转载或归属不明、过期、返佣邀请、登录或反爬限制等内容不会因为搜索排名高就直接收录。

## 安装独立搜索环境

页面预览与静态构建只需要 Node.js 22+，没有第三方 Node 依赖。自主搜索另需 Python 3.11+ 及锁定的 `ddgs==9.16.1`。搜索环境独立放在忽略的 `work/`，不向 Hermes 的 Python 环境安装包，也不读取或传递模型密钥。

macOS / Linux：

```sh
python3 -m venv work/search-venv
work/search-venv/bin/python -m pip install --index-url https://pypi.org/simple -r requirements-search.txt
npm start
```

Windows PowerShell：

```powershell
py -3.11 -m venv work/search-venv
.\work\search-venv\Scripts\python.exe -m pip install --index-url https://pypi.org/simple -r requirements-search.txt
npm start
```

若使用其他已经安装上述依赖的 Python，设置 `PERK_SEARCH_PYTHON` 为解释器路径。Node 默认查找 `work/search-venv/bin/python`，Windows 使用 `work/search-venv/Scripts/python.exe`。无需搜索 API Key；模型调用继续复用本机 Hermes 配置，或已有的完整 GPT 运行时配置。

搜索通过 stdin/stdout JSON 子进程桥执行，每次查询最多 240 字符、结果最多 8 条，最长 45 秒、输出最大 256 KiB。只传入必要系统、代理及 CA 环境；模型密钥不进入搜索子进程。桥接错误只返回清洗后的摘要，不公开提供方诊断。

## 配置与状态

`data/discovery.json` 的当前默认值：

```json
{
  "enabled": true,
  "maxQueriesPerScan": 4,
  "resultsPerQuery": 5,
  "maxCandidatesPerScan": 3,
  "maxNewSourcesPerScan": 2,
  "maxSources": 200,
  "intervalMinutes": 60,
  "candidateCooldownHours": 24
}
```

`maxSources` 按信源 URL 条目计数，默认 200，配置上限 500；达到上限后停止扩充，已接入来源仍继续监测。`enabled: false` 可只关闭自主发现，保留已有来源扫描。搜索周期默认一小时；已经处理但未准入的候选默认冷却 24 小时，避免每轮重复核验相同页面。

运行记录仅保存在忽略的工作目录：

- `work/discovery-state.json`：查询轮次、下次尝试、历史查询与候选冷却。
- `work/discovery-report.json`：最近一轮实际查询、结果数、考虑候选、准入/待复核数量及失败摘要。
- `work/candidates.json`：等待福利规则核验的线索，不能直接发布。

发现尝试开始前先持久化下一次时间，避免核心扫描的 15 分钟重试重复执行同一轮搜索。搜索失败不抹掉既有数据，原有来源采集与规则核验继续；维护时同时检查发现报告与收录报告。不要以“本轮没有新增”推断搜索已经执行或成功。

## 持久化与发布边界

`npm run sync:github` 分别校验并同步正式福利与已准入的信源注册表，各文件以自己的旧 SHA 防止并发覆盖。准入信源里的公开证据、短查询和出处可以进入版本历史；原始搜索结果、未准入候选、冷却状态及日志留在本机。两个文件分别提交，后一文件失败不回滚已经完成的更新。

Vercel 只执行数据校验和静态构建，发布 `dist/`；它不安装搜索 Python 环境、不调用 GPT，也不运行扫描调度。搜索与核验仍需要本机服务或其他持久运行环境可用。现有自动任务共用到期状态与锁，不另建一套扫描计划。

官方归属判断可能出错，网页条款、库存及个人资格也可能变化；模型审核通过不表示人工实领。保留人工纠错入口，发现错误时修正注册表或正式福利，并重新核验对应规则。
