# @liziy/model-provider

统一管理 pi 模型供应商的扩展。内置 Command Code，并支持添加 OpenAI Chat Completions、OpenAI Responses、Claude Messages 兼容供应商。

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
| Command Code | `/login` →「Sign in with an account」→ Command Code |

Command Code 的官方授权页 `/studio/auth/cli` 在中文环境下会因 locale 重定向丢参数而报 `Missing callback or state`，此时改用登录界面里的**粘贴 API 密钥**。

### Command Code 套餐类型

账号套餐决定请求通道，登录成功后自动判定并保存，之后**不再重新判定**：

| 套餐 | 通道 | 请求接口 |
|---|---|---|
| GO | `/alpha/generate`（私有 NDJSON 协议） | 仅此一条 |
| GOAT / Pro / Max / Provider | Provider API（标准协议） | `/provider/v1/chat/completions`，Claude 走 `/provider/v1/messages` |

未判定前默认为 GO。切换套餐（例如从 GO 升级到 GOAT）或判定失败时，到 `管理模型` → 选择 Command Code → **套餐类型** 手动修改；手动选择的值不会被任何刷新或重注册覆盖。

模型走哪个接口由服务端 `/provider/v1/models` 的 `supported_endpoints` 决定，`刷新模型` 时一并保存，无需手工配置。

### 思考等级

`管理模型` → 选择供应商 → **刷新启用模型思考**，实测每个已启用模型真正支持哪些档位，写回配置后 `/settings` 只显示可用档位。

同一操作还会确定思考参数格式，格式不对时参数会被上游忽略，档位也就形同虚设。

选 `minimal` 等于关闭思考：多数模型没有这一档，插件会把实测出的关闭值借位到这里。模型一档都探不通时配置保持原样。

改完重启 pi 生效。

## 说明

- 配置只保存供应商地址、API 格式与模型元数据；API 密钥由 pi 的 `/login` 管理，存在 `~/.pi/agent/auth.json`
- 模型上下文优先取服务端 `/models` 的返回字段，无有效值时默认 `1M`
- 通用供应商的系统提示统一以 `system` 角色发送（多数第三方网关不接受 pi 默认的 `developer` 角色）
- `openai-codex-responses` 仅适用于 OpenAI 官方 ChatGPT/Codex OAuth，普通 `sk-...` 密钥请用 `openai-responses`

## 版本历史

- **0.5.0** — 「刷新启用模型思考」改为直连实测：同时确定思考参数格式，只写支持的档位，可选 minimal 关闭思考
- **0.4.0** — 移除内置 MiniMax Local 供应商（含旧配置迁移）；新增「刷新启用模型」，实测每个已启用模型支持的档位并写入配置，`/settings` 只显示可用档位
- **0.3.0** — 内置供应商更名为 Command Code 并支持 Provider API 通道：登录时自动识别账号套餐（GO 走 `/alpha/generate`，GOAT/Pro/Max/Provider 走 `/provider/v1`），新增「套餐类型」手动切换；模型按服务端 `supported_endpoints` 自动选择 Chat Completions 或 Messages 接口
- **0.2.11** — 修复 Command Code (GO) 回复不流式渲染：补发 `start` 事件，避免增量事件被丢弃；修复工具调用参数可能丢失、用户中断被报成错误、停止原因丢失
- **0.2.10** — 修复内置 Command Code (GO) “刷新模型”误连 MiniMax 地址导致认证失败：改走 `/provider/v1/models`；“配置管理”入口仅对 MiniMax 展示
- **0.2.9** — 修复 Command Code (GO) 正文流式输出异常：事件携带的消息快照改为逐帧拷贝，避免上游密集 delta 被后续内容覆盖
- **0.2.8** — 新增内置供应商 Command Code（GO 套餐）；新增模型自动勾选启用，内置供应商排到最后
- **0.2.7** — 修复 MiniMax 工具与系统提示词丢失、思考回传规范、reasoning_effort 档位
- **0.2.6** — 新增模型刷新与手动新增的模型管理流程

## 许可

MIT