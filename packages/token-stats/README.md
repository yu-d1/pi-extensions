# @liziy/token-stats

**pi 的 Token 用量与配额监控扩展** —— footer 实时显示 token 累计、缓存命中率、输出速率、上下文占用，以及 MiniMax / GLM / Kimi / DeepSeek / mimo 套餐配额。每轮对话记录 JSONL，`/stats` 按日/小时/周/月/年回看。零运行时依赖，不上传任何数据。

## 安装

```bash
pi install npm:@liziy/token-stats
```

## 展示效果

```
↑33M ↓395k Σ33M CH79% | ⚡6.65 t/s | 🧠 11.2%/1.0M | 5h: 18% ⏱ 1h 12m W: 62% ⏱ 4d   (minimax_local) MiniMax-M3
```

| 字段 | 含义 |
|---|------|
| `↑33M ↓395k Σ33M` | 累计输入 / 输出 / 总 token |
| `CH79%` | 累计缓存命中率（≥80% 绿、<50% 黄） |
| `⚡6.65 t/s` | 滚动 2 秒窗口输出速率 |
| `🧠 11.2%/1.0M` | 上下文占用% / 上限 |
| `5h: 18% ⏱ 1h 12m` | 5h 窗口剩余% + 倒计时（≥50 绿 / ≥20 黄 / <20 红） |
| `W: 62% ⏱ 4d` | 周配额剩余% + 倒计时 |
| `(minimax_local) MiniMax-M3` | provider + model |

各段用 ` | ` 分隔。

## 使用

**启用套餐**：`/stats` → `套餐配额配置`，为当前 provider 手动选择，footer 立即显示。按 provider 分别记忆，不自动推断。

**状态栏配置**：`/stats config`（菜单右侧直接显示当前值，改完立即生效）

- `显示内容` — 按「用量 / 性能 / 状态 / 元信息」分组勾选，另有会话花费 `$`、首 token 延迟 `TTFT`、会话时长 `T+`
- `显示精度` — 百分比 / token / 速率 / 金额小数位；`自适应` 随量级自动选（1.2k / 12k / 128k），多数情况无需调整
- `上下文样式` / `速率样式` / `套餐样式` — 中文选项 + 效果预览
- `查询间隔` — 套餐刷新间隔（秒，最小 10s）
- `恢复默认` — 显示项、精度、样式一键还原

> footer 按终端宽度自适应：右侧模型名固定，左侧超出预算时按优先级裁剪，速度 / 上下文 / 套餐余量永不丢失。

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

```
Token 统计  |  2026-07-09
──────────────────────────────────────────
对话次数: 42   总token: 1.0M   缓存命中率: 87.4%
新增输入: 128k (平均 3.1k/次)   总输出: 23k   平均速率: 32.5 t/s
```

## 支持的套餐

| 套餐 | 适用 provider（手动选择） | 鉴权 | 显示 |
|------|--------------------------|------|------|
| MiniMax (Coding Plan) | `minimax_local` / `minimax-cn` / `minimax` | `MINIMAX_API_KEY` | 5h + 周 + 倒计时 |
| GLM (智谱) | `zhipu-cn` / `zhipu` / `glm` / `bigmodel` | `GLM_API_KEY` | 5h + 周 + 倒计时 |
| Kimi (Coding Plan) | `moonshot-cn` / `moonshot` / `kimi` | `MOONSHOT_API_KEY` 或 OAuth | 5h + 周 + 倒计时 |
| DeepSeek | `deepseek-cn` / `deepseek` | `DEEPSEEK_API_KEY` | 账户余额（CNY） |
| mimo（小米） | `mimo` | 浏览器登录 Cookie | 账户余额（CNY） |

API Key 读取顺序：环境变量 > `~/.pi/agent/auth.json` 中当前 provider 的 `key` / OAuth `access`。

### mimo 登录说明

mimo 配额只能从控制台网页读取，没有 API Key。首次查询（或 Cookie 临近过期）时会**弹出 Chrome 窗口**打开 mimo 控制台，在窗口内完成登录即可 —— 扩展通过 CDP 读取登录 Cookie 后自动关窗，零 npm 依赖。

- 首次启用弹一次窗口完成登录，之后约每 20 小时自动续期一次，抓到 Cookie 后静默查询
- 中途出错不会强行关窗：窗口保留，你继续登录即可，下次刷新自动复用它
- 需本机有 Chrome / Edge / Chromium，非默认路径可设 `MIMO_CHROME`；排查日志见 `token-stats-logs/mimo-quota.log`

## 文件

```
~/.pi/agent/extensions/token-stats/
├── config.json                 # provider → 套餐映射 + 刷新 TTL
├── display-config.json         # 显示项开关
├── mimo-cookie.txt             # mimo 登录 Cookie
└── mimo-browser-data/          # mimo 专用 Chrome profile
~/.pi/agent/extensions/token-stats-logs/
├── raw/YYYY-MM-DD.jsonl        # 每轮对话原始数据
├── hourly/                     # 按小时汇总
├── daily/daily.jsonl           # 按日汇总（/stats 读取）
├── quota-cache.json            # 配额查询缓存
└── mimo-quota.log              # mimo 登录排查日志
```

清空配置文件即恢复默认；卸载不删日志，重装后历史保留。原始记录可用 `jq` 自行分析。

## 注意事项

- `cacheHitRate` 分母为 `input + cacheRead + cacheWrite`（与 pi 内置 `usage` 同款公式）
- 实时速率优先用流式 `usage.output` 增量，回退 `字符数 / 4` 估算；>1000 t/s 视为异常忽略
- 套餐查询失败一律静默隐藏该段（如 mimo 登录态不可用），不影响其它字段显示

## 版本历史

- **v1.8.1** — 修复 mimo 登录窗口秒退：清理 Chrome 残留的陈旧调试端口、端口探活通过后才使用、中途异常不再杀窗口（保留给用户登录并在下次刷新复用）、Windows 下杀整棵进程树、登录流程单飞锁；登录退避不再被自动 force 重置
- **v1.8.0** — 状态栏配置产品化重构：显示项按用量/性能/状态/元信息分组（新增会话花费、TTFT、会话时长），精度按各部分独立设置，套餐样式新增「倒计时只显示最大单位」，footer 按终端宽度自适应裁剪，显示面板支持搜索与分组
- **v1.7.1** — mimo 浏览器检测补齐 Edge / Chromium / Brave，记忆上次选择，支持 `MIMO_CHROME` 指定
- **v1.7.0** — 新增 mimo（小米）账户余额套餐；套餐选择支持搜索；配额查询按套餐拆分到 `plans/` 模块
- **v1.6.0** — 移除联网搜索；`/stats` 菜单去掉图标
- **v1.5.x** — 新增年度按月统计；精简配额样式；主菜单三级入口；修复杂额显示与菜单导航问题
- **v1.3.x** — 修复 session 替换时定时器未清理导致崩溃、DeepSeek 余额不显示等问题

## 许可

MIT