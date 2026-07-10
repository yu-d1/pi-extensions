# @liziy/plan-guard

**pi 的 Plan/Act 模式切换扩展。**

通过 Tab 键快速在「计划模式」(Plan mode) 和「执行模式」(Act mode) 之间切换，模式变更会自动调整：

- **工具白名单** —— Plan 模式仅暴露只读工具（read、bash 只读命令、MCP 等）
- **系统提示** —— Plan 模式提示模型只做规划不执行修改；Act 模式提示模型直接执行
- **模型切换** —— 分别为 Plan 和 Act 记录偏好模型，切换时自动恢复
- **状态栏** —— Plan 模式会在状态栏显示 `[计划模式]` 标签

## 特性

- **Tab 键切换** —— 无需输入命令，键盘即时切换
- **持久化** —— 当前模式 + 模型偏好通过 `pi.appendEntry` 跨会话保留
- **工具白名单** —— Plan 模式禁用 `edit`、`write`、删除类 bash 等修改工具
- **模型分离** —— Plan 用思考深的模型（如 Claude/GPT），Act 用便宜的模型，自动切换

## 安装

```bash
pi install npm:@liziy/plan-guard
```

## 使用

| 操作 | 效果 |
|------|------|
| **Tab 键** | 切换 Plan / Act 模式 |
| `/model` 选模型 | 当前模式会记住该模型 |
| 重启会话 | 自动恢复上次模式 + 模型 |

### Plan 模式可用工具

```
read, bash, mcp, ask_user_question,
chrome_snapshot, chrome_evaluate, chrome_screenshot,
chrome_tab, chrome_navigate, chrome_wait_for,
chrome_list_console_messages, chrome_list_network_requests,
chrome_get_network_request
```

`bash` 在 Plan 模式下也仅可执行只读命令（禁止 `rm`、重定向、`sed -i`、`git commit` 等修改操作）。

## 协议

MIT
