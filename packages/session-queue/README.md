# @liziy/session-queue

把 pi 的会话从「树」改为「队列」：每个 turn 自动记录修改的文件，回滚时一键还原。

### 特性

- **JIT 拦截**：工具执行前后拍照存证（0 启动开销）
- **内容寻址**：相同内容只存一次（sha256）
- **脏检查**：拒绝覆盖外部已修改的文件
- **工作区白名单**：按目录启用，默认不记录
- **snapshot GC**：标记-扫描回收，控制磁盘占用
- **bash 追踪**：`rm`/`del`/`mv`/`>`/`>>`（多文件、简单 glob）
- **Session Tree 同步**：导航到旧对话点时队列自动回滚
- **零依赖**

### 安装

```bash
pi install npm:@liziy/session-queue
```

### 命令

| 命令 | 作用 |
|---|---|
| `/rollback` | 唤起主菜单（回滚 / 工作区 / GC / 设置） |
| `/rollback enable` | 启用当前目录的记录 |
| `/rollback disable` | 暂停记录 |
| `/rollback list` | 列出已启用工作区 |
| `/rollback gc` | 手动执行 GC |

### 快速上手

1. `/rollback enable` — 开始记录
2. 正常使用；每个 `turn_end` 写入一个检查点
3. `/rollback` → 选检查点 → 确认 → 文件还原
4. 可选：Session Tree 选旧消息 + 输入新问题 → 队列自动同步

### 状态栏

| 指示 | 含义 |
|---|---|
| （隐藏） | 未启用工作区 |
| `● 记录`（青色） | 仅记录 |
| `● 同步`（绿色） | 记录 + 跟随 Session Tree |

### 回滚语义

- **文件**：取被丢弃 turn 中**最早**那条修改的 `beforeHash` 还原（不是中间快照）
- **队列**：`entries.slice(0, targetIdx)` — 丢弃目标及之后
- **冲突**：被跳过的文件保留为 `residual` entry（可重试）
- **安全**：快照丢失 = 跳过 + 告警，绝不盲目删除

### 存储

```
~/.pi/agent/extensions/session-queue/
├── config.json              # 工作区、followSessionTree
├── queue-{sessionId}.json   # 最近 10 条 entry + changes
└── snapshots/{hash}.content # 内容寻址
```

### 限制

- 仅追踪 `edit` / `write` / 部分 `bash`（`sed -i`、`npm install`、子 shell 不可）
- 10 轮滚动窗口；超出的 turn 不被记录也不可回滚
- 不撤销 pi 的会话树，用 `/tree` 查看完整历史
- 目录的创建/删除无法还原
