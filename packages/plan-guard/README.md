# @liziy/plan-guard

> ⚠️ **兼容性修复**：本扩展通过 `pi.registerShortcut("tab", ...)` 抢占 Tab 键用于模式切换。若 `~/.pi/agent/keybindings.json` 中 `tui.input.tab` 仍保留默认绑定（`tab`），pi 启动时会检测到 `tui.input.tab`（内置）⇄ 扩展的快捷键冲突，并显示不兼容警告：
>
> ```
> Extension shortcut conflict: 'tab' is built-in shortcut for tui.input.tab and .../plan-guard. Using .../plan-guard.
> ```
>
> **修复方式**：在 `keybindings.json` 中清空 `tui.input.tab` 即可消除警告：
>
> ```json
> { "tui.input.tab": [] }
> ```
>
> 修改后重启 pi 或执行 `/reload` 即可生效。也可在 pi 会话中让 AI 助手直接帮你写入该配置。

**pi 的 Plan/Act 模式切换扩展，内嵌 Todo 任务面板与提问对话框。**

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
- **📋 Todo 任务面板**（默认开启）—— todo 工具 + `/todos` 命令 + 输入框上方的实时任务面板，任务随会话持久化（/reload、压缩后仍可恢复），`ctrl+shift+t` 折叠/展开面板
- **💬 提问对话框**（默认开启）—— 增强版 `ask_user_question` 工具：多问题 Tab 页签、选项带描述与 markdown 预览、`Type something.` 自定义回答、notes 备注

## 安装

```bash
pi install npm:@liziy/plan-guard
```

> 本扩展内嵌整合了 [rpiv-todo](https://github.com/juicesharp/rpiv-mono) 与 [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono)（MIT 许可，源码位于 `ask-user-question/`、`todo/` 子目录）。**请卸载同名扩展 `@juicesharp/rpiv-ask-user-question`、`@juicesharp/rpiv-todo`**，避免工具重复注册冲突（两者都注册同名 `todo` / `ask_user_question` 工具）。

## 使用

| 操作 | 效果 |
|------|------|
| **Tab 键** | 切换 Plan / Act 模式 |
| `/model` 选模型 | 当前模式会记住该模型 |
| **/plan config** | 配置整合子扩展的开关（Todo 面板 / 提问对话框） |
| 重启会话 | 自动恢复上次模式 + 模型 |

### /plan config 子扩展开关

```
/plan config
```

进入配置菜单：

```
📋 Todo 任务面板  (✅ 开启)
💬 提问对话框    (✅ 开启)
🔙 返回
```

选择对应项即可切换开关，配置保存在 `~/.pi/agent/extensions/plan-guard/config.json`（缺失时默认全部开启）。

**注册决策在扩展加载期完成**：切换开关后执行 `/reload` 生效。关闭的子扩展不再注册同名工具 → pi 内置的 `todo` / `ask_user_question` 自然生效。

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

## 更新日志

### v2.0.0

- **整合**：内嵌 rpiv-todo（todo 工具 + `/todos` 命令 + 实时任务面板，`ctrl+shift+t` 折叠）与 rpiv-ask-user-question（增强版提问对话框：多问题页签、preview、notes），卸载 `@juicesharp/rpiv-ask-user-question`、`@juicesharp/rpiv-todo` 后由本扩展独立提供
- **新增**：`/plan config` 配置菜单 —— Todo 任务面板 / 提问对话框开关（默认全开），配置存 `~/.pi/agent/extensions/plan-guard/config.json`，切换后 `/reload` 生效
- **依赖**：rpiv-config 配置工具内联为 `rpiv-config.ts`（MIT），仅保留 typebox 运行时依赖

### v1.0.5

- **修复**：`model_select` 跳过 `source: "restore"` 事件——pi 会话恢复时自动恢复上次模型，不再将其误写进当前模式的模型偏好，避免 `planModelId`/`actModelId` 被污染
- **修复**：`session_start` 恢复模式的同时，同步恢复该模式对应的偏好模型（此前只恢复模式不恢复模型）
- **修复**：Plan 模式下拦截 `rm`/`rmdir` 删除命令（命令位置匹配，`grep "rm"`、`echo rm` 不会误判），其余 bash 命令仍由提示词约束
- **改进**：切换模型前先比较当前模型，相同则跳过无意义的 `setModel` 调用
- **改进**：目标模型不存在或无 API key 时给出错误提示，不再静默失败
- **改进**：模型偏好仅在值变化时持久化，减少会话记录膨胀
