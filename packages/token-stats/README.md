# @liziy/token-stats

**pi 的 Token 用量与配额监控扩展 —— 让你随时看到 5h 窗口还剩多少、缓存命中率有没有省到钱、模型现在跑多快，跑到一半不再被限流中断。**

在 pi 的 footer 实时显示本轮 token 累计、缓存命中率、滚动窗口输出速率、上下文占用，以及 MiniMax / GLM / Kimi / DeepSeek 的套餐用量；每轮对话自动记录到 JSONL，可用 `/stats` 按日/小时/周/月/年回看。

## 为什么要装

- **避免跑到一半被限流** —— 5h 窗口剩余百分比、距下次刷新的倒计时直接挂在 footer 上，看到 `5h: 18%` 就知道要续杯或切号
- **调 prompt 有依据** —— 缓存命中率一栏量化你的 prompt 缓存策略好不好，从 20% 调到 80% 是真省了钱不是感觉
- **实时反馈输出速度** —— 滚动 2 秒窗口计算即时 t/s，对比不同模型/不同 `service_tier` 一眼看出差距
- **可追溯** —— 每次对话自动落 JSONL，事后用 `/stats month 2026-07` 看月度账单
- **零运行时依赖** —— 纯 Node.js `fs`，不连外部数据库，不上传任何数据

## 展示效果

### 场景 1：对话开始（空闲）

```
                                     (minimax_local) MiniMax-M3
```

### 场景 2：流式输出中（实时速率）

```
↑1.2k ↓820 Σ2.0k CH45% | ⚡720 t @ 6.65 t/s | 🧠 1.2%/1.0M          (minimax_local) MiniMax-M3
```

### 场景 3：套餐用量告警

```
↑33M ↓395k Σ33M CH79% | ⚡6.65 t/s | 🧠 11.2%/1.0M | 5h: 18% ⏱ 1h 12m W: 62% ⏱ 4d   (minimax_local) MiniMax-M3
```

### 字段说明

| 段 | 字段 | 含义 |
|---|------|------|
| 1 | `↑33M ↓395k Σ33M` | 累计输入 / 输出 / 总 token |
| 1 | `CH79%` | 累计缓存命中率（≥80% 绿、≥50% 默认、<50% 黄） |
| 2 | `⚡720 t @ 6.65 t/s` | 已输出 720 tokens / 滚动 2 秒窗口 6.65 t/s |
| 3 | `🧠 11.2%/1.0M` | 当前上下文占用% / 上限 |
| 4 | `5h: 18%` | 5 小时窗口剩余百分比（颜色：≥50 绿 / ≥20 黄 / <20 红） |
| 4 | `⏱ 1h 12m` | 5 小时窗口距下次刷新的倒计时 |
| 4 | `W: 62%` | 周配额剩余百分比 |
| 4 | `⏱ 4d` | 周配额距下次刷新的倒计时 |
| 5 | `(minimax_local) MiniMax-M3` | provider + model |

每段用 ` | ` 分隔，显示哪些段可通过 `/stats config` 配置。

## 安装

```bash
pi install npm:@liziy/token-stats
```

## 5 分钟上手

### 1. 启用套餐用量

切到任意模型后输入 `/stats`，在主菜单选择 `📦 套餐配额配置`，为当前 provider 手动选择一个套餐（MiniMax / GLM / Kimi / DeepSeek），footer 立刻多出 5h/周/倒计时三段。套餐按 provider 分别保存，不会根据 provider 名称自动推断。

> 套餐用量按 provider 维度记忆，下次切回同一个 provider 自动恢复。

### 2. 自定义显示项

```
/stats config
  ┌─ 配置 ──────────────┐
  │ 显示样式             │
  │ 显示内容             │
  │ 查询间隔  (当前 60s) │
  └─────────────────────┘
```

**显示内容** —— 勾选 footer 中要显示哪些段（TUI 下为勾选组件：↑↓ 选择、enter 切换、ctrl+a 全选、ctrl+x 清空、ctrl+s 保存；勾选的排在最上面）：

```
┌─ 状态栏显示内容 ───────┐
│ → 输入              ✓ │   ← 累计输入 token
│   输出              ✓ │
│   总token           ✗ │   ← 关闭 Σ 一段
│   缓存命中          ✓ │   ← CH%
│   速度              ✓ │   ← ⚡ 实时速率
│   容量              ✓ │   ← 🧠 上下文占用
│   5h额度（含倒计时） ✓ │
│   周额度（含倒计时） ✓ │
│   思考强度          ✓ │   ← TH 当前模型思考档位
│                       │
│  enter 切换 · ctrl+a 全选 · ctrl+x 清空 · ctrl+s 保存 · esc 取消 · 显示 8/9 │
└───────────────────────┘
```

非 TUI 模式（rpc/print）自动降级为循环单选切换。

**配额显示样式** —— 在 `/stats config` → `显示样式` → `📦 配额样式` 中选择：

```text
→ ● with-clock     5h: 89% ⏱ 4h 15m W: 72% ⏱ 2d
  ○ compact              5h: 89% 7d: 72%
  ● with-clock-7d         5h: 89% ⏱ 4h 15m 7d: 72% ⏱ 2d
  ○ nearest-clock-7d      5h: 89% 7d: 72% ⏱ 4h
```

默认使用 `with-clock-7d`，5 小时和周额度分别显示自己的倒计时，并将周额度标签显示为 `7d`；`nearest-clock-7d` 只显示两个重置时间中较近的一个；`compact` 不显示倒计时。配额百分比固定显示为整数。

**查询间隔** —— 设置套餐用量接口刷新间隔（秒，最小 10s）：

```
输入查询间隔（秒） [60] > 30
→ 查询间隔已设为 30 秒
```

## 历史查询

每轮对话结束后，扩展把以下字段写入 `~/.pi/agent/extensions/token-stats-logs/raw/YYYY-MM-DD.jsonl`：

```json
{
  "ts": "2026-07-09T03:14:25.123Z",
  "session": "abc123",
  "model": "minimax_local/MiniMax-M3",
  "input": 1234,
  "output": 567,
  "cacheRead": 8900,
  "cacheWrite": 0,
  "tokensPerSec": 32.5,
  "cacheHitRate": 87.8,
  "liveTokenSpeed": 41.2,
  "firstTokenLatency": 412,
  "wordCount": 320,
  "cost": 0.012
}
```

> 同一份原始数据自动汇总到 `hourly/YYYY-MM-DD.jsonl` 和 `daily/daily.jsonl`，`/stats` 命令直接读这两个汇总。

### `/stats` 命令一览

无参数执行 `/stats` 时，主菜单按以下层级组织：

```text
⚙️  状态栏配置
📦 套餐配额配置
📊 统计查询
  ├─ 📊 今日统计
  ├─ 📊 按小时分布（今日）
  ├─ 📊 本周汇总
  ├─ 📊 月度汇总
  └─ 📊 年度汇总（按月）
```

其中“状态栏配置”进入显示样式、显示内容、查询间隔和联网搜索；显示样式中还可以配置配额样式；“统计查询”进入今日、按小时、本周、月度和年度（按月）统计。

```bash
/stats                       # 打开主菜单
/stats today                 # 等价于 day，今天的统计
/stats day                   # 今天的统计
/stats day 2026-07-07        # 指定日期
/stats hour                  # 今天的小时分布
/stats hour 2026-07-07       # 指定日期的小时分布
/stats week                  # 最近 7 天汇总
/stats month                 # 当月汇总
/stats month 2026-07         # 指定月份
/stats year                  # 当年汇总（按月）
/stats year 2026             # 指定年度汇总（按月）
/stats config                # 状态栏配置：显示项 / 样式 / 查询间隔 / 联网搜索
```

### 输出示例：`/stats day`

```
Token 统计  |  2026-07-09
──────────────────────────────────────────
对话次数:   42
新增输入:   128k  (平均 3.1k/次，未命中缓存)
缓存输入:   890k
总输出:     23k  (平均 548/次)
总token:    1.0M  (新增 + 缓存)
缓存命中率: 87.4%
平均速率:   32.5 t/s
```

### 输出示例：`/stats month 2026-07`

```
2026-07 月度汇总
──────────────────────────────────────────────────────────────────────
日期        次数  新增输入  缓存输入  输出      总token   命中率  速率
──────────────────────────────────────────────────────────────────────
2026-07-01    8      24k      156k     5k       185k    84.3%  31.2
2026-07-02   12      31k      201k     7k       239k    85.7%  29.8
...
──────────────────────────────────────────────────────────────────────
合计       156     412k    2.6M     87k     3.1M    86.2%  30.5
```

## 支持的套餐用量

| 套餐 | 适用 provider（需手动选择） | 鉴权 | 显示 |
|------|-----------------------------|------|------|
| MiniMax (Coding Plan) | `minimax_local` / `minimax-cn` / `minimax` | `MINIMAX_API_KEY` | 5h 窗口 + 周 + 倒计时 |
| GLM (智谱) | `zhipu-cn` / `zhipu` / `glm` / `bigmodel` | `GLM_API_KEY` | 5h 窗口 + 周 + 倒计时 |
| Kimi (Coding Plan) | `moonshot-cn` / `moonshot` / `kimi` | `MOONSHOT_API_KEY` 或 OAuth `access` | 5h 窗口 + 周 + 倒计时 |
| DeepSeek | `deepseek-cn` / `deepseek` | `DEEPSEEK_API_KEY` | 账户余额（CNY） |

套餐必须在 `/stats` → `📦 套餐配额配置` 中按当前 provider 手动选择；没有显式选择时不显示套餐配额。配置保存于 `providerPlans`，例如：

```json
{
  "providerPlans": {
    "kimi-coding": "kimi"
  }
}
```

关闭当前 provider 的套餐后保存为 `null`，不会被自动匹配重新启用。

API Key 读取顺序：环境变量 > `~/.pi/agent/auth.json` 中当前 provider 的 `key` 或 OAuth `access` 字段。

查询结果按 TTL（默认 60s，可在 `/stats config` 中调整）缓存到 `quota-cache.json`，避免高频调用触发平台限流。

## 联网搜索

选择 DeepSeek 套餐后自动获得联网搜索能力（默认开启）：模型可直接调用 `web_search` 工具进行实时搜索，结果带来源链接。

- **开关**：`/stats config` → `🔍 联网搜索` → 切换 `启用联网搜索`（默认开启）
- **联动规则（套餐驱动）**：搜索后端由当前套餐决定 —— 选择 DeepSeek 套餐 → 使用 DeepSeek 服务端搜索（`deepseek-v4-flash` + `web_search_20260209`，与官方 [pi-deepseek-search](https://github.com/bxff/pi-deepseek-search) 相同的调用逻辑）；其它套餐暂无搜索后端，工具不注册
- **key 复用**：与配额查询共用同一套 key 解析（环境变量 > auth.json），无需额外配置
- **与 pi-deepseek-search 共存**：两者都会注册同名 `web_search` 工具，pi 按扩展加载顺序取先注册者生效，后注册者被静默忽略。使用本扩展的搜索时建议卸载 pi-deepseek-search（搜索已内嵌，功能等价）

## 日志文件结构

```
~/.pi/agent/extensions/token-stats-logs/
├── raw/                          # 每轮对话原始数据（按日切分）
│   ├── 2026-07-08.jsonl
│   └── 2026-07-09.jsonl
├── hourly/                       # 按小时汇总
│   └── 2026-07-09.jsonl
├── daily/
│   └── daily.jsonl               # 按日汇总（所有日期）
└── quota-cache.json              # 套餐用量查询缓存
```

如果需要直接读 JSONL 做自己的分析：

```bash
# 今天的总输入
jq -s 'map(.input) | add' ~/.pi/agent/extensions/token-stats-logs/raw/$(date -I).jsonl

# 本周每天的缓存命中率
jq -r '"\(.date) \(.avgCacheHitRate)"' \
  ~/.pi/agent/extensions/token-stats-logs/daily/daily.jsonl | tail -7
```

## 配置存储

| 文件 | 作用 |
|------|------|
| `~/.pi/agent/extensions/token-stats/config.json` | provider → 套餐映射 + 刷新 TTL |
| `~/.pi/agent/extensions/token-stats/display-config.json` | 9 个显示项的开关 |
| `~/.pi/agent/extensions/token-stats-logs/quota-cache.json` | 套餐用量查询结果缓存 |

清空这些文件即可恢复默认行为；卸载扩展不会删除日志（重装后历史数据完整保留）。

## 注意事项

- `cacheHitRate` 的分母是 `input + cacheRead + cacheWrite`（含缓存命中部分），pi 内置 `usage` 的同款公式
- 实时速率 `liveTokenSpeed` 优先使用流式 `usage.output` 增量，回退到 `字符数 / 4` 估算；超过 1000 t/s 自动忽略视为异常
- 套餐用量的颜色规则：剩余 ≥50% 绿 / ≥20% 黄 / <20% 红
- 会话恢复（`session_start`）会从历史 assistant 消息重建累计统计，无需重启 pi 就能看到本会话完整账单
- `message_end` 与 `turn_end` 通过 `responseId + provider + model + usage` 复合 key 去重，避免重复累加

## 版本历史

- **v1.5.4** — 修复配额倒计时仅剩分钟时误显示后续 `7d` 标签；修复套餐菜单 Esc 导航和取消选择时误清除原套餐；新增年度按月统计
- **v1.5.3** — 精简配额样式为 `compact`、`with-clock-7d` 和 `nearest-clock-7d`，统一使用 `7d` 周额度标签；默认使用 `with-clock-7d`
- **v1.5.2** — 关闭套餐的 provider 自动模糊匹配，改为必须按当前 provider 手动选择；主菜单调整为状态栏配置、套餐配额配置、统计查询三级入口；新增配额显示样式（默认 `with-clock-7d`，百分比固定为整数）；5h/周额度显示项各自包含对应刷新倒计时，移除独立的"刷新时间"显示项；精简默认状态栏内容并修复倒计时与 ⏱ 之间的多余空格
- **v1.5.1** — `/stats` 无参改为主菜单（今日/小时/周/月统计 + 套餐配额 + 状态栏配置），查询不再需要记参数；状态栏“显示内容”改为勾选组件，ctrl+s 实时保存并留在界面
- **v1.5.0** — 状态栏“显示内容”等勾选界面改用批量勾选组件（对齐内置 /scoped-models 交互）


- **v1.4.0** — 新增联网搜索：`/stats config` 可配置（默认开启），搜索后端跟随套餐（DeepSeek 套餐 → DeepSeek 服务端搜索，内嵌移植 pi-deepseek-search 核心逻辑，带 provider 守卫）

- **v1.3.4** — 修复 DeepSeek 配额启用后余额不显示：余额型显示无 `5h:/W:/⏱` 字段被过滤丢失，空结果时回退显示完整内容
- **v1.3.3** — 修复 `/new`、`/resume`、`/fork`、`/reload` 等 session 替换场景下旧实例配额刷新定时器未清理、访问失效 ctx 导致 pi 崩溃退出（`extension ctx is stale`）的问题：新增 `session_shutdown` 清理处理器，定时器/延迟回调/footer 渲染统一加 `sessionActive` 守卫与异常兜底
- **v1.3.2** — `/stats` 启用套餐时不再误报“未知错误”

## 许可

MIT
