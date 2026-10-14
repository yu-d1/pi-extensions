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
| `/todos` | Todo 菜单：执行全部待办 / 检查状态标注 / 查看列表 |
| `/todos exec` `/todos check` `/todos list` | 直达对应动作，跳过菜单 |
| `/plan config` | 开关 Todo 面板 / 提问对话框（切换后 `/reload` 生效） |

**Plan 模式**禁用 `edit`、`write`、删除类 bash 等修改工具，`bash` 仅可执行只读命令（禁止 `rm`、重定向、`sed -i`、`git commit` 等）；可用 read / bash / mcp / ask_user_question 及 chrome 系列工具。

**持久化**：当前模式与模型偏好跨会话保留，重启自动恢复。

## 版本历史

- **2.1.2** — 模型偏好修复：`/model` 只记用户显式选择，不再被切模式的自动切换覆盖；首次进入未配置的模式时把当前模型记为该模式偏好；旧的仅含 `mode` 的会话快照不再清空已配置的偏好
- **2.1.1** — 修复提问对话框在输入模式（自定义回答 / 备注）下崩溃：残留的 i18n 调用未随依赖移除一起清理
- **2.1.0** — `/todos` 改为菜单：执行全部待办（自动续跑至全部完成）、检查状态标注（让模型核对已完成未标记项）、查看列表；直接入口 `/todos exec|check|list`；todo `action` 增加必填提示与调用示例；移除内嵌 rpiv-config / rpiv-i18n 依赖
- **2.0.1** — `/plan config` 改为循环菜单，可连续调整
- **2.0.0** — 内嵌 Todo 任务面板与提问对话框，新增 `/plan config` 开关

## 许可

MIT