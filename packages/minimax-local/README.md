# minimax-local

**让 pi 直接调用 MiniMax API 的自定义 Provider 扩展，完整适配 MiniMax 官方参数——可配置高倍率 priority 服务层级、思考模式、思考拆分。**

MiniMax 的 Chat Completions API 兼容 OpenAI 协议，但有三个 pi 原生不支持的特性：`service_tier`（高倍率）、`thinking`（思考）、`reasoning_split`（思考拆分）。该扩展通过自定义 `streamSimple` 流式实现完整支持这些参数。

## 特性

- **完整适配 MiniMax 官方参数**：`service_tier`（高倍率）/ `thinking`（思考）/ `reasoning_split`（思考拆分）—— pi 原生不支持的三项全部补齐
- **可配置高倍率**：`service_tier` 支持 `priority`（1.5× 价格，跳过排队）和 `standard` 运行时切换
- **两个模型**：MiniMax-M3（文本+图片，1M context）和 MiniMax-M2.7-highspeed（纯文本，204.8K context）
- **流式响应**：完整 SSE 解析，支持 thinking 拆到 `reasoning_content`
- **思考控制**：`thinking.type` 支持 adaptive / disabled 两档
- **思考拆分**：`reasoning_split` 控制 thinking 是否独立字段输出
- **工具调用**：支持 function calling
- **费用计算**：自动统计 token 和费用

## 使用

### 1. 配置 API Key

在 `~/.pi/agent/auth.json` 中添加：

```json
{
  "minimax_local": "你的 MiniMax API Key"
}
```

API Key 在 [MiniMax 平台 → 接口密钥](https://platform.minimaxi.com/user-center/basic-information/interface-key) 获取。

### 2. 选择模型

`/model` 选择 `minimax_local/MiniMax-M3` 或 `minimax_local/MiniMax-M2.7-highspeed`。

### 3. 运行时配置

`/minimax` 提供交互式菜单修改参数：

```
MiniMax 配置
├── 思考模式      当前：auto
├── 服务层级      当前：priority
├── 思考拆分      当前：拆分到独立字段
├── 恢复默认设置
└── 取消
```

| 参数 | 可选值 | 说明 |
|------|--------|------|
| `thinking.type` | auto / adaptive / disabled | 控制 M3 的思考模式 |
| `service_tier` | priority / standard | 请求准入层级，priority 为 1.5× 价格 |
| `reasoning_split` | true / false | 是否将 thinking 拆到 `reasoning_content` |

配置持久化到 `~/.pi/agent/extensions/minimax-local/config.json`，跨会话保留。

## 安装

```bash
pi install npm:@liziy/minimax-local
```

## 命令

| 命令 | 说明 |
|------|------|
| `/minimax` | 打开菜单查看或修改运行时参数 |

## 注意事项

- `service_tier: priority` 价格为 standard 的 1.5 倍，确保优先准入跳过排队
- MiniMax-M2.x 系列 thinking 始终开启，无法关闭
- 图片支持 JPEG / PNG / GIF / WEBP，单张最大 10 MB

## 协议

MIT
