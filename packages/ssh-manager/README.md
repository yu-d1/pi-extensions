# @liziy/ssh-manager

pi 的 SSH 连接扩展。AI 可通过 `ssh_exec` / `ssh_list_servers` 工具远程执行命令，受权限控制。

## 安装

```bash
pi install npm:@liziy/ssh-manager
```

> 依赖 `ssh2` npm 包，`pi install` 会自动安装。

## 使用

| 命令 | 作用 |
|------|------|
| `/ssh` | 导航菜单（查看 / 新增 / 编辑 / 删除 / 配置） |
| `/ssh add` | 新增连接，依次填写 IP、说明、用户名、端口、密码或密钥路径、连接名称 |
| `/ssh edit` | 编辑已有连接（顶部回显当前值，留空保持不变） |
| `/ssh rm` / `/ssh ls` | 删除 / 查看连接 |
| `/ssh config` | 查看或修改全局配置 |

添加时自动探测 `~/.ssh/` 下的密钥并测试连通性。

**配置**（`/ssh config`）：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| AI 只读模式 | 是 | 只允许 ls / cat / ps 等读命令 |
| 执行确认 | 写操作确认 | 不确认 / 写操作确认 / 每次都确认 |
| 命令超时 | 30s | 单条命令超时秒数 |

**安全约束**：`rm -rf /`、`shutdown`、`reboot`、`dd`、`mkfs` 等危险命令直接禁止；只读模式下仅放行读命令；连接配置存于 `~/.pi/agent/ssh-configs.json`。

## 版本历史

- **1.1.1** — 删除连接前新增确认，防止误删
- **1.1.0** — 新增 AI 工具（`ssh_exec` / `ssh_list_servers`）、导航菜单与安全控制

## 许可

MIT