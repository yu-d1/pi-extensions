# @liziy/plan-guard

pi 的 Plan/Act 模式切换扩展，内嵌 Todo 任务面板与提问对话框。**Tab 键**在「计划模式」与「执行模式」间切换，模式变更自动调整工具白名单、系统提示、模型偏好，并在状态栏显示 `[计划模式]`。

## 安装

```bash
pi install npm:@liziy/plan-guard
```

> 内嵌整合了 rpiv-todo 与 rpiv-ask-user-question（MIT）。**请卸载同名扩展** `@juicesharp/rpiv-ask-user-question`、`@juicesharp/rpiv-todo`，避免同名工具重复注册冲突。
>
> **Tab 键冲突**：若 `~/.pi/agent/keybindings.json` 中 `tui.input.tab` 仍为默认的 `tab`，pi 启动会报 `Extension shortcut conflict`。清空该项即可消除警告：
> ```json
> { "tui.input.tab": [] }
> ```
> 修改后 `/reload` 生效。

## 使用

| 操作 | 效果 |
|------|------|
| **Tab 键** | 切换 Plan / Act 模式 |
| `/model` 选模型 | 当前模式会记住该模型，切换时自动恢复 |
| `/todos` | 查看任务面板（`ctrl+shift+t` 折叠） |
| `/plan config` | 开关 Todo 面板 / 提问对话框（切换后 `/reload` 生效） |

**Plan 模式**禁用 `edit`、`write`、删除类 bash 等修改工具，`bash` 仅可执行只读命令（禁止 `rm`、重定向、`sed -i`、`git commit` 等）；可用 read / bash / mcp / ask_user_question 及 chrome 系列工具。

**持久化**：当前模式与模型偏好跨会话保留，重启自动恢复。

## 版本历史

- **2.0.1** — `/plan config` 改为循环菜单，可连续调整
- **2.0.0** — 内嵌 Todo 任务面板与提问对话框，新增 `/plan config` 开关

## 许可

MIT