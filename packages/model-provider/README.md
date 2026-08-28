# @liziy/model-provider

统一管理 pi 模型供应商的扩展。内置 MiniMax Local，同时支持通过 `/model-provider` 添加 OpenAI Chat Completions、OpenAI Responses 和 Claude Messages 兼容供应商。

## 功能

- **MiniMax Local**：直接调用 MiniMax API，支持 `service_tier`、`thinking`、`reasoning_split`、`temperature`、`top_p` 和 `max_completion_tokens`。
- **通用供应商**：按供应商名称、API 格式和 API 前缀统一管理多个服务。
- **三种官方 API 格式**：`openai-completions`、`openai-responses`、`anthropic-messages`。
- **统一认证**：普通供应商通过 `/login <供应商名称>` 登录，密钥保存在 pi 的 `auth.json`，不写入扩展配置。
- **模型管理**：支持从 `{baseUrl}/models` 手动刷新模型，也支持手动添加模型；通过勾选控制模型是否启用，未勾选的模型不在 `/model` 中显示，勾选启用的模型始终排在列表最上面。TUI 模式下与内置 `/scoped-models` 交互一致：↑↓ 选择、enter 切换、ctrl+a 全选、ctrl+x 清空、ctrl+s 保存、esc 取消，支持搜索过滤。
- **连接检查**：新增或编辑供应商时检查 `{baseUrl}/models`；检查失败会返回地址输入并允许修改重试。
- **登录后刷新**：`/login <供应商名称>` 成功输入 API 密钥后，只刷新当前供应商一次；本地编辑或勾选模型不会触发远程刷新。
- **上下文窗口**：优先使用模型目录返回的上下文大小；服务端未返回时默认使用 1M，也可以在模型管理中手动设置。
- **图片输入**：自动识别模型能力；无法从模型目录判断时默认允许图片输入，也可以单独手动修改。
- **思考级别**：通用模型默认启用思考，跟随 `/settings` 的等级发送对应参数；服务端未声明思考能力时自动补全全部等级（含 `xhigh`、`max`），明确返回 `false` 时仅保留 `off`。
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

1. 执行 `/model-provider` → `添加供应商`。
2. 填写供应商名称、API 格式和 API 前缀。
3. 地址只填写 API 前缀，例如：

   ```text
   https://api.openai.com/v1
   https://api.anthropic.com/v1
   ```

   不要填写 `/models`、`/responses`、`/messages` 或 `/chat/completions`。

4. 执行 `/login <供应商名称>` 完成认证。输入 API 密钥并确认后，会自动刷新当前供应商的模型列表。
5. 执行 `/model-provider` → `管理模型` → 选择供应商：↑↓ 选择、enter 切换勾选、输入关键词搜索过滤、ctrl+a 全选、ctrl+x 清空、ctrl+s 保存（保存后留在当前界面，可继续调整；esc 退出）；勾选的模型排在最上面，未勾选的不显示在 `/model` 中。
6. 模型管理可刷新或新增模型，也可批量设置图片输入。
7. “修改上下文窗口”支持 `256k`、`512k`、`1m` 或纯数字。
8. 使用 `/model` 选择对应的 `供应商名称/模型 id`。

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

## 思考等级

pi 的 `/settings` 中思考等级共 7 档：

```text
off       No reasoning
minimal   Very brief reasoning (~1k tokens)
low       Light reasoning (~2k tokens)
medium    Moderate reasoning (~8k tokens)
high      Deep reasoning (~16k tokens)
xhigh     需要模型声明支持的扩展档位
max       需要模型声明支持的扩展档位
```

通用模型实际可用的档位由 pi 按模型的 `thinkingLevelMap` 过滤：

- 模型 `reasoning` 为 `false` 时仅保留 `off`；
- `thinkingLevelMap` 中显式映射（值为字符串）的档位可用，值为 `null` 的档位被排除；
- `xhigh`、`max` 必须存在显式映射才显示，避免服务端不支持对应参数时报错。

扩展的处理策略：

1. 服务端 `/models` 明确返回 `reasoning: false`（或 `supports_reasoning: false` 等）→ 模型仅保留 `off`，尊重服务端声明；
2. 其余情况（返回 `true` 或未返回任何能力声明）→ 自动补全全部 7 档映射（`off` → `"none"`，其余恒等），`/settings` 中即可配置所有等级；
3. 请求时按档位发送对应参数（`reasoning_effort` / `reasoning.effort`），选择 `off` 时发送 `"none"`。内置 MiniMax 不受此影响，使用自己的 thinking 逻辑。

如需手动调整某模型的档位映射，可编辑 `~/.pi/agent/extensions/model-provider/config.json` 中的 `thinkingLevelMap`，例如：

```json
{
  "id": "my-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": "none",
    "xhigh": "high",
    "max": "high"
  }
}
```

修改后重启 pi 即可生效。

## 模型上下文

模型上下文窗口的处理顺序如下：

1. 优先使用服务端 `/models` 返回的上下文字段，例如 `contextWindow`、`context_window`、`context_length` 或 `max_context_length`。
2. 服务端没有返回有效上下文时，默认使用 `1M（1,000,000）`。
3. 可以进入 `/model-provider` → `Common 供应商` → `管理模型` → `修改上下文窗口` 手动覆盖。
4. 手动新增模型默认使用 `1M` 上下文。

手动设置支持以下格式：

```text
256k
512k
1m
1000000
```

## 命令

| 命令 | 说明 |
|---|---|
| `/model-provider` | 管理供应商、模型和 MiniMax 配置 |
| `/minimax` | 进入 MiniMax 配置菜单的兼容别名 |
| `/login <名称>` | 使用 pi 内置认证流程登录供应商 |

## 说明

- 供应商名称同时作为 Provider id 和显示名称。
- 未勾选启用的模型仍保存在配置文件中，只是不在 `/model` 选择器中显示；刷新模型不会丢失勾选状态。
- common 供应商不在插件配置中保存 API 密钥。
- 模型列表刷新只会在模型管理中手动执行，或者在 `/login <供应商名称>` 成功后自动刷新刚登录的供应商；不会通过后台任务刷新其他供应商，也不会因删除、编辑模型而访问远程接口。
- 新增或编辑供应商时会检查 `{baseUrl}/models`。网络失败、地址错误或返回格式无法识别时，会停留在地址输入步骤，修改后可以继续重试。
- 模型的 `thinkingLevelMap` 映射值会作为对应协议的思考参数发送；服务端未声明能力时扩展自动补全全部档位，如需自定义映射或关闭某档位，可编辑 `config.json`（值为 `null` 的档位在 `/settings` 中不可见）。
- `openai-codex-responses` 要求 OpenAI 官方 ChatGPT/Codex OAuth JWT，不适用于普通 `sk-...` API 密钥。

## 版本历史

### 0.2.3

- 思考等级自动补全：`/models` 能获取到能力声明时按声明处理（明确返回 `false` 的模型仅保留 `off`）；未声明时自动补全全部思考等级（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`），`/settings` 可配置全部档位
- 修复 `normalizeStore` 丢弃 `thinkingLevelMap` 的问题，重启后配置不丢失

- **v0.2.2** — 通用模型同步思考等级，支持发送 `reasoning_effort`。

### 0.2.1

- `/model-provider` 菜单扁平化：移除“Common 供应商”中间层，添加/编辑/删除供应商与 MiniMax 配置一级直达
- 管理模型：选择供应商后进入操作循环，返回可连续切换供应商；勾选组件 ctrl+s 保存后留在当前界面（footer 显示已保存）
- 修复异步保存后界面不刷新的问题（一直显示“保存中...”）
- API 格式选择与通知文案精简

### 0.2.0

- 模型管理改为勾选式（对齐内置 /scoped-models 交互：搜索过滤、enter 切换、ctrl+a 全选、ctrl+x 清空、ctrl+s 保存）
- 新增/刷新拉取的模型默认不勾选，未勾选的不显示在 `/model`；图片读取支持批量勾选；移除“删除模型”

## 许可

MIT
