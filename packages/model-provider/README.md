# @liziy/model-provider

统一管理 pi 模型供应商的扩展。内置 MiniMax Local 与 Command Code（GO 套餐），并支持添加 OpenAI Chat Completions、OpenAI Responses、Claude Messages 兼容供应商。

## 安装

```bash
pi install npm:@liziy/model-provider
```

## 使用

### 添加通用供应商

1. `/model-provider` → `添加供应商`，填写名称、API 格式、API 前缀
2. 地址只填 API 前缀（`https://api.openai.com/v1`），**不要**带 `/models`、`/responses`、`/messages` 等路径
3. `/login <供应商名称>` 认证，输入密钥后自动刷新该供应商的模型列表
4. `/model-provider` → `管理模型` → 选择供应商，勾选启用后即可在 `/model` 中选用

管理模型内支持：刷新 / 新增 / 删除模型、批量设置图片输入、修改上下文窗口（支持 `256k`、`512k`、`1m` 或纯数字）。手动新增的模型**自动勾选启用**；「刷新模型」批量拉取的新模型保持未勾选，需自行勾选。

**API 格式选择**：

| 格式 | 请求接口 | 适用 |
|---|---|---|
| `openai-completions` | `{baseUrl}/chat/completions` | Chat Completions 兼容服务 |
| `openai-responses` | `{baseUrl}/responses` | Responses 兼容服务 |
| `anthropic-messages` | `{baseUrl}/messages` | Claude Messages 兼容服务 |

### 登录内置供应商

| 供应商 | 方式 |
|--------|------|
| MiniMax Local | `/login minimax_local`，参数经 `管理模型` → `配置管理` 调整 |
| Command Code (GO) | `/login` →「Sign in with an account」→ Command Code |

Command Code 的官方授权页 `/studio/auth/cli` 在中文环境下会因 locale 重定向丢参数而报 `Missing callback or state`，此时改用登录界面里的**粘贴 API 密钥**。

### 思考等级

`/settings` 的思考档位由模型的 `thinkingLevelMap` 过滤：服务端明确返回 `reasoning: false` 时只保留 `off`；其余情况自动补全全部档位。`xhigh`、`max` 必须有显式映射才显示。

需要自定义时编辑 `~/.pi/agent/extensions/model-provider/config.json`：

```json
{ "id": "my-model", "reasoning": true,
  "thinkingLevelMap": { "off": "none", "xhigh": "high", "max": "high" } }
```

值为 `null` 的档位在 `/settings` 中不可见，重启 pi 生效。

## 说明

- 配置只保存供应商地址、API 格式与模型元数据；API 密钥由 pi 的 `/login` 管理，存在 `~/.pi/agent/auth.json`
- 模型上下文优先取服务端 `/models` 的返回字段，无有效值时默认 `1M`
- 通用供应商的系统提示统一以 `system` 角色发送（多数第三方网关不接受 pi 默认的 `developer` 角色）
- `openai-codex-responses` 仅适用于 OpenAI 官方 ChatGPT/Codex OAuth，普通 `sk-...` 密钥请用 `openai-responses`

## 版本历史

- **0.2.8** — 新增内置供应商 Command Code（GO 套餐）；新增模型自动勾选启用，内置供应商排到最后
- **0.2.7** — 修复 MiniMax 工具与系统提示词丢失、思考回传规范、reasoning_effort 档位
- **0.2.6** — 新增模型刷新与手动新增的模型管理流程

## 许可

MIT