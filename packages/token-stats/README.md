# @liziy/token-stats

pi 的 Token 用量与配额监控扩展。footer 实时显示 token 累计、缓存命中率、输出速率、上下文占用与套餐配额，`/stats` 可按日/小时/周/月/年回看。零运行时依赖，不上传任何数据。

## 安装

```bash
pi install npm:@liziy/token-stats
```

## 使用

**1. 启用套餐配额**：`/stats` → `套餐配额配置`，为当前 provider 选择对应套餐，footer 立即显示。

| 套餐 | 适用 provider | 凭据 |
|------|--------------|------|
| MiniMax (Coding Plan) | `minimax_local` / `minimax-cn` / `minimax` | `MINIMAX_API_KEY` |
| GLM (智谱) | `zhipu-cn` / `zhipu` / `glm` / `bigmodel` | `GLM_API_KEY` |
| Kimi (Coding Plan) | `moonshot-cn` / `moonshot` / `kimi` | `MOONSHOT_API_KEY` 或 OAuth |
| DeepSeek | `deepseek-cn` / `deepseek` | `DEEPSEEK_API_KEY` |
| mimo（小米） | `mimo` | 浏览器登录（见下） |
| Command Code (GO 套餐) | `commandcodego` | pi `/login` 登录 |

凭据读取顺序：环境变量 > `~/.pi/agent/auth.json` 中当前 provider 的 `key` / OAuth `access`。

> **mimo** 需从控制台网页读取，没有 API Key。启用后会弹出 Chrome 窗口，在窗口内登录即可，扩展自动读取 Cookie 并关窗。需本机有 Chrome / Edge / Chromium。

**2. 配置状态栏**：`/stats config`，可勾选显示项、调整精度与样式，改完立即生效。

**3. 查看统计**：

```bash
/stats                       # 主菜单
/stats day [YYYY-MM-DD]      # 日统计
/stats hour [YYYY-MM-DD]     # 小时分布
/stats week|month|year       # 周 / 月 / 年
```

## 版本历史

- **v1.8.3** — 新增 Command Code (GO 套餐) 配额；套餐样式新增「月度余额」两种（余额仅 GO 套餐显示，其他套餐自动省略）
- **v1.8.1** — 修复 mimo 登录窗口秒退与登录退避被自动刷新重置
- **v1.8.0** — 状态栏配置产品化重构：显示项分组、精度独立设置、footer 按终端宽度自适应

## 许可

MIT