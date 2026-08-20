# @liziy/model-provider

统一管理 pi 模型供应商的扩展。内置 MiniMax Local，同时支持通过 `/model-provider` 添加 OpenAI Chat Completions、OpenAI Responses 和 Claude Messages 兼容供应商。

## 功能

- **MiniMax Local**：直接调用 MiniMax API，支持 `service_tier`、`thinking`、`reasoning_split`、`temperature`、`top_p` 和 `max_completion_tokens`。
- **通用供应商**：按供应商名称、API 格式和 API 前缀统一管理多个服务。
- **三种官方 API 格式**：`openai-completions`、`openai-responses`、`anthropic-messages`。
- **统一认证**：普通供应商通过 `/login <供应商名称>` 登录，密钥保存在 pi 的 `auth.json`，不写入扩展配置。
- **模型管理**：支持从 `{baseUrl}/models` 手动刷新模型，也支持手动添加、编辑和删除模型。
- **图片输入**：自动识别模型能力；无法从模型目录判断时默认允许图片输入，也可以单独手动修改。
- **思考级别**：支持按模型配置 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max` 映射。
- **热更新**：添加、编辑或删除供应商与模型后立即重新注册，无需重启 pi。

## 安装

```bash
pi install npm:@liziy/model-provider
```

如果之前安装过旧的 `@liziy/minimax-local`，请先卸载旧包，再安装本包：

```bash
pi uninstall npm:@liziy/minimax-local
pi install npm:@liziy/model-provider
```

## 使用

### MiniMax Local

1. 在 pi 中登录 MiniMax：

   ```text
   /login minimax_local
   ```

2. 使用 `/model` 选择：

   ```text
   minimax_local/MiniMax-M3
   minimax_local/MiniMax-M2.7-highspeed
   ```

3. 使用 `/model-provider` → `MiniMax 配置` 调整服务层级、思考模式、思考拆分、温度、核采样和最大输出长度。

### 通用供应商

1. 执行 `/model-provider` → `Common 供应商` → `添加供应商`。
2. 填写供应商名称、API 格式和 API 前缀。
3. 地址只填写 API 前缀，例如：

   ```text
   https://api.openai.com/v1
   https://api.anthropic.com/v1
   ```

   不要填写 `/models`、`/responses`、`/messages` 或 `/chat/completions`。

4. 执行 `/login <供应商名称>` 完成认证。
5. 在供应商的模型管理中刷新模型，或手动添加模型 id。
6. 使用 `/model` 选择对应的 `供应商名称/模型 id`。

## API 格式

| 格式 | 请求接口 | 适用场景 |
|---|---|---|
| `openai-completions` | `{baseUrl}/chat/completions` | OpenAI Chat Completions 兼容服务 |
| `openai-responses` | `{baseUrl}/responses` | OpenAI Responses 兼容服务 |
| `anthropic-messages` | `{baseUrl}/messages` | Claude Messages 兼容服务 |

普通兼容服务使用 `openai-responses`，不要使用仅适用于 OpenAI 官方 ChatGPT/Codex OAuth 的 `openai-codex-responses`。

## 配置文件

扩展配置保存于：

```text
~/.pi/agent/extensions/model-provider/config.json
```

配置只保存供应商地址、API 格式和模型元数据。API 密钥由 pi 的 `/login` 管理，保存在：

```text
~/.pi/agent/auth.json
```

不要将真实 API 密钥、令牌或个人配置文件提交到代码仓库。

首次加载时，扩展会尝试将旧配置文件：

```text
~/.pi/agent/extensions/minimax-local/config.json
```

迁移到新的配置文件。

## 命令

| 命令 | 说明 |
|---|---|
| `/model-provider` | 管理供应商、模型和 MiniMax 配置 |
| `/minimax` | 进入 MiniMax 配置菜单的兼容别名 |
| `/login <名称>` | 使用 pi 内置认证流程登录供应商 |

## 说明

- 供应商名称同时作为 Provider id 和显示名称。
- common 供应商不在插件配置中保存 API 密钥。
- 模型列表刷新只会在模型管理中手动执行，不会通过后台任务自动恢复已删除模型。
- 模型的 `thinkingLevelMap` 必须根据实际 API 兼容能力配置；映射值会作为对应协议的思考参数发送。
- `openai-codex-responses` 要求 OpenAI 官方 ChatGPT/Codex OAuth JWT，不适用于普通 `sk-...` API 密钥。

## 许可

MIT
