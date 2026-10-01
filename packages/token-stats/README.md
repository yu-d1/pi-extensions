# @liziy/token-stats

**pi 的 Token 用量与配额监控扩展** —— footer 实时显示本轮 token 累计、缓存命中率、输出速率、上下文占用，以及 MiniMax / GLM / Kimi / DeepSeek 套餐配额，跑到一半不再被限流中断。每轮对话记录 JSONL，`/stats` 按日/小时/周/月/年回看。零运行时依赖，纯 Node.js `fs`，不上传任何数据。

## 安装

```bash
pi install npm:@liziy/token-stats
```

## 展示效果

流式输出中：

```
↑1.2k ↓820 Σ2.0k CH45% | ⚡720 t @ 6.65 t/s | 🧠 1.2%/1.0M          (minimax_local) MiniMax-M3
```

套餐用量告警：

```
↑33M ↓395k Σ33M CH79% | ⚡6.65 t/s | 🧠 11.2%/1.0M | 5h: 18% ⏱ 1h 12m W: 62% ⏱ 4d   (minimax_local) MiniMax-M3
```

| 字段 | 含义 |
|---|------|
| `↑33M ↓395k Σ33M` | 累计输入 / 输出 / 总 token |
| `CH79%` | 累计缓存命中率（≥80% 绿、<50% 黄） |
| `⚡720 t @ 6.65 t/s` | 已输出 720 tokens / 滚动 2 秒窗口速率 |
| `🧠 11.2%/1.0M` | 上下文占用% / 上限 |
| `5h: 18% ⏱ 1h 12m` | 5h 窗口剩余% + 倒计时（≥50 绿 / ≥20 黄 / <20 红） |
| `W: 62% ⏱ 4d` | 周配额剩余% + 倒计时 |
| `(minimax_local) MiniMax-M3` | provider + model |

各段用 ` | ` 分隔，显示哪些段由 `/stats config` 决定。

## 使用

**启用套餐用量**：`/stats` → `套餐配额配置`，为当前 provider 手动选择套餐，footer 立即显示 5h/周/倒计时。按 provider 分别记忆，不自动推断；关闭后保存为 `null`。

**自定义显示**：`/stats config`（菜单项右侧直接显示当前值，改完立即生效）

- `显示内容` — 按「用量 / 性能 / 状态 / 元信息」分组勾选 footer 显示项，右侧给出当前精度下的效果示例；可用新指标：会话花费 `$`、首 token 延迟 `TTFT`、会话时长 `T+`（TUI 勾选组件：↑↓ 选择、输入搜索、enter 切换、ctrl+a 全选、ctrl+x 清空、ctrl+s 保存；非 TUI 降级为循环单选）
- `显示精度` — 百分比小数位（0/1/2）、token 精度（自适应/整数/1 位小数）、速率小数位、金额小数位；`自适应` 会随量级自动选精度（1.2k / 12k / 128k），大多数情况无需调整
- `上下文样式` / `速率样式` / `套餐样式` — 中文选项 + 效果预览，改完立即重绘
- `查询间隔` — 套餐接口刷新间隔（秒，最小 10s），结果缓存到 `quota-cache.json`
- `恢复默认` — 显示项、精度、样式一键还原

> footer 按终端宽度自适应：右侧模型名固定，左侧超出预算时按优先级裁剪（会话时长 → TTFT → 思考强度 → 产出段），速度 / 上下文 / 套餐余量永不丢失。

**统计查询**：

```bash
/stats                       # 主菜单
/stats day [YYYY-MM-DD]      # 日统计（today 等价）
/stats hour [YYYY-MM-DD]     # 小时分布
/stats week                  # 最近 7 天
/stats month [YYYY-MM]       # 月度
/stats year [YYYY]           # 年度按月
/stats config                # 状态栏配置
```

输出示例：

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

## 支持的套餐

| 套餐 | 适用 provider（手动选择） | 鉴权 | 显示 |
|------|-----------------------------|------|------|
| MiniMax (Coding Plan) | `minimax_local` / `minimax-cn` / `minimax` | `MINIMAX_API_KEY` | 5h + 周 + 倒计时 |
| GLM (智谱) | `zhipu-cn` / `zhipu` / `glm` / `bigmodel` | `GLM_API_KEY` | 5h + 周 + 倒计时 |
| Kimi (Coding Plan) | `moonshot-cn` / `moonshot` / `kimi` | `MOONSHOT_API_KEY` 或 OAuth | 5h + 周 + 倒计时 |
| DeepSeek | `deepseek-cn` / `deepseek` | `DEEPSEEK_API_KEY` | 账户余额（CNY） |

API Key 读取顺序：环境变量 > `~/.pi/agent/auth.json` 中当前 provider 的 `key` / OAuth `access`。

## 文件

```
~/.pi/agent/extensions/token-stats/
├── config.json             # provider → 套餐映射 + 刷新 TTL
└── display-config.json     # 显示项开关
~/.pi/agent/extensions/token-stats-logs/
├── raw/YYYY-MM-DD.jsonl    # 每轮对话原始数据
├── hourly/                 # 按小时汇总
├── daily/daily.jsonl       # 按日汇总（/stats 读取）
└── quota-cache.json        # 配额查询缓存
```

清空配置文件即恢复默认；卸载不删日志，重装后历史保留。原始记录含 `ts`、`model`、`input`、`output`、`cacheRead/Write`、`tokensPerSec`、`cacheHitRate`、`cost` 等字段，可用 `jq` 自行分析。

## 注意事项

- `cacheHitRate` 分母为 `input + cacheRead + cacheWrite`（与 pi 内置 `usage` 同款公式）
- 实时速率优先用流式 `usage.output` 增量，回退 `字符数 / 4` 估算；>1000 t/s 视为异常忽略
- `session_start` 从历史消息重建累计，`message_end` / `turn_end` 按复合 key 去重防重复累加

## 版本历史

- **v1.8.0** — 状态栏配置产品化重构：显示项按用量/性能/状态/元信息分组（新增会话花费、TTFT、会话时长），精度按各部分独立设置（上下文/缓存命中/套餐余量/token/速率/花费/余额），套餐样式新增「倒计时只显示最大单位」，footer 按终端宽度自适应裁剪，占位符统一 `--`，显示面板支持搜索与分组、排序固定
- **v1.7.1** — mimo 浏览器检测补齐 Edge / Chromium / Brave（Windows 预装 Edge 可用），记忆上次选择，支持 `MIMO_CHROME` 手动指定
- **v1.7.0** — 新增 mimo（小米）账户余额套餐（Chrome/CDP 静默续期，零依赖）；套餐选择支持搜索且选中即关闭弹窗；配额查询按套餐拆分到 `plans/` 模块
- **v1.6.0** — 移除联网搜索；`/stats` 菜单去掉图标
- **v1.5.x** — 新增年度按月统计；精简配额样式（默认 `with-clock-7d`）；主菜单三级入口；修复杂额显示与菜单导航问题
- **v1.5.0** — 显示内容改用批量勾选组件；`/stats` 无参进入主菜单
- **v1.4.0** — 曾新增联网搜索（v1.6.0 已移除）
- **v1.3.x** — 修复 session 替换时定时器未清理导致崩溃、DeepSeek 余额不显示等问题

## 许可

MIT
