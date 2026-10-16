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

> **mimo** 需从控制台网页读取，没有 API Key。首次启用会弹出 Chrome 窗口，在窗口内扫码登录即可，扩展自动读取 Cookie 并优雅关闭窗口。登录一次后小米 SSO 凭据会保存约 30 天，此后续期由无头模式静默完成（约每天一次），不会再弹窗。需本机有 Chrome / Edge / Chromium。

**2. 配置状态栏**：`/stats config`，可勾选显示项、调整精度与样式，改完立即生效。

**3. 查看统计**：

```bash
/stats                       # 主菜单
/stats day [YYYY-MM-DD]      # 日统计
/stats hour [YYYY-MM-DD]     # 小时分布
/stats week|month|year       # 周 / 月 / 年
```

## 版本历史

- **v1.8.5** — 修复 mimo 静默续期从未真正生效：续期时会主动访问 SSO 登录直链重新换票（此前只打开控制台首页，页面看到库里的旧票就不再跳登录流程，等再久也换不到新票）；续期成功判定从「有凭据」改为「凭据确实换了新的」；新增 24h 主动换票，不再只等 401 才发现失效
- **v1.8.4** — mimo 免登录：登录一次后凭据保留约 30 天，续期改用无头模式静默完成；关闭窗口改为优雅退出（不再强杀）以保留 SSO 凭据
- **v1.8.3** — 新增 Command Code (GO 套餐) 配额；套餐样式新增「月度余额」两种（余额仅 GO 套餐显示，其他套餐自动省略）
- **v1.8.1** — 修复 mimo 登录窗口秒退与登录退避被自动刷新重置
- **v1.8.0** — 状态栏配置产品化重构：显示项分组、精度独立设置、footer 按终端宽度自适应

## 许可

MIT