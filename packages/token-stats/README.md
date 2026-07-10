# @liziy/token-stats

**pi 的 Token 用量与配额监控扩展 —— 让你随时看到 5h 窗口还剩多少、缓存命中率有没有省到钱、模型现在跑多快，跑到一半不再被限流中断。**

在 pi 的 footer 实时显示本轮 token 累计、缓存命中率、滚动窗口输出速率、上下文占用，以及 MiniMax / GLM / Kimi / DeepSeek 的套餐用量；每轮对话自动记录到 JSONL，可用 `/stats` 按日/小时/周/月回看。

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
↑33M ↓395k Σ33M CH79% | ⚡6.65 t/s | 🧠 11.2%/1.0M | 5h: 18% W: 62% ⏱ 1h 12m   (minimax_local) MiniMax-M3
```

### 字段说明

| 段 | 字段 | 含义 |
|---|------|------|
| 1 | `↑33M ↓395k Σ33M` | 累计输入 / 输出 / 总 token |
| 1 | `CH79%` | 累计缓存命中率（≥80% 绿、≥50% 默认、<50% 黄） |
| 2 | `⚡720 t @ 6.65 t/s` | 已输出 720 tokens / 滚动 2 秒窗口 6.65 t/s |
| 3 | `🧠 11.2%/1.0M` | 当前上下文占用% / 上限 |
| 4 | `5h: 18%` | 5 小时窗口剩余百分比（颜色：≥50 绿 / ≥20 黄 / <20 红） |
| 4 | `W: 62%` | 周配额剩余百分比 |
| 4 | `⏱ 1h 12m` | 距下次刷新的倒计时 |
| 5 | `(minimax_local) MiniMax-M3` | provider + model |

每段用 ` | ` 分隔，显示哪些段可通过 `/stats config` 配置。

## 安装

```bash
pi install npm:@liziy/token-stats
```

## 5 分钟上手

### 1. 启用套餐用量

切到任意模型后输入 `/stats`，从菜单选择一个套餐（MiniMax / GLM / Kimi / DeepSeek），footer 立刻多出 5h/周/倒计时三段。

> 套餐用量按 provider 维度记忆，下次切回同一个 provider 自动恢复。

### 2. 自定义显示项

```
/stats config
  ┌─ 配置 ──────────────┐
  │ 显示内容             │
  │ 刷新时间  (当前 60s) │
  └─────────────────────┘
```

**显示内容** —— 选择 footer 中要显示哪些段：

```
┌─ 选择要切换显示的项目 ─┐
│ ✅ 输入               │   ← 累计输入 token
│ ✅ 输出               │
│ ⬜ 总token            │   ← 关闭 Σ 一段
│ ✅ 缓存命中           │   ← CH%
│ ✅ 速度               │   ← ⚡ 实时速率
│ ✅ 容量               │   ← 🧠 上下文占用
│ ✅ 5h额度             │
│ ✅ 周额度             │
│ ✅ 刷新时间           │   ← ⏱ 倒计时
│ 🔙 完成               │
└───────────────────────┘
```

**刷新时间** —— 设置配额查询间隔（秒，最小 10s）：

```
输入刷新间隔（秒） [60] > 30
→ 刷新时间已设为 30 秒
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

```bash
/stats                       # 首次运行进入套餐配置向导
/stats today                 # 等价于 day，今天的统计
/stats day                   # 今天的统计
/stats day 2026-07-07        # 指定日期
/stats hour                  # 今天的小时分布
/stats hour 2026-07-07       # 指定日期的小时分布
/stats week                  # 最近 7 天汇总
/stats month                 # 当月汇总
/stats month 2026-07         # 指定月份
/stats config                # 配置：显示项 / 刷新间隔
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

| 套餐 | 触发 provider | 鉴权 | 显示 |
|------|--------------|------|------|
| MiniMax (Coding Plan) | `minimax_local` / `minimax-cn` / `minimax` | `MINIMAX_API_KEY` | 5h 窗口 + 周 + 倒计时 |
| GLM (智谱) | `zhipu-cn` / `zhipu` / `glm` / `bigmodel` | `GLM_API_KEY` | 5h 窗口 + 周 + 倒计时 |
| Kimi (Coding Plan) | `moonshot-cn` / `moonshot` / `kimi` | `MOONSHOT_API_KEY` | 5h 窗口 + 周 + 倒计时 |
| DeepSeek | `deepseek-cn` / `deepseek` | `DEEPSEEK_API_KEY` | 账户余额（CNY） |

API Key 读取顺序：环境变量 > `~/.pi/agent/auth.json` 中对应 provider 的 `key` 字段。

查询结果按 TTL（默认 60s，可在 `/stats config` 中调整）缓存到 `quota-cache.json`，避免高频调用触发平台限流。

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

## 协议

MIT
