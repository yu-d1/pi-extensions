# pi-extensions

Pi 扩展 monorepo — 由 [@liziy](https://www.npmjs.com/~liziy) 维护。

## 包列表

| 包名 | 描述 |
|------|------|
| [@liziy/token-stats](./packages/token-stats) | Token 用量与配额监控扩展 — Footer 实时显示 5h/周配额剩余、缓存命中率、输出速率；JSONL 记录 + /stats 多维查询 |
| [@liziy/plan-guard](./packages/plan-guard) | Plan/Act 模式切换扩展 — Tab 键切换计划与执行模式，自动调整工具白名单和系统提示 |
| [@liziy/plugin-manager](./packages/plugin-manager) | MCP/扩展/技能 启用状态管理 — 按 source 自动发现工具集合，关闭不需要的能力以节省上下文 token |
| [@liziy/ssh-manager](./packages/ssh-manager) | SSH 连接管理扩展 — 添加/编辑/删除 SSH 配置，选择后显示连接信息和 ssh config 片段 |
| [@liziy/minimax-local](./packages/minimax-local) | MiniMax 自定义 Provider 扩展 — 让 pi 直接调用 MiniMax API，完整适配官方参数 |
| [@liziy/session-queue](./packages/session-queue) | Session 队列扩展 — 线性 session 队列，文件变更回滚，snapshot GC，Session Tree 自动同步 |

## 安装

使用 pi 命令直接安装：

```bash
pi install npm:@liziy/token-stats
pi install npm:@liziy/plan-guard
pi install npm:@liziy/plugin-manager
pi install npm:@liziy/ssh-manager
pi install npm:@liziy/minimax-local
pi install npm:@liziy/session-queue
```

## 开发

```bash
# 安装依赖
pnpm install

# 在某个包下开发
pnpm --filter @liziy/token-stats dev

# 全部构建
pnpm -r run build
```

## 目录结构

```
pi-extensions/
├── packages/
│   ├── token-stats/
│   ├── plan-guard/
│   ├── plugin-manager/
│   ├── ssh-manager/
│   ├── minimax-local/
│   └── session-queue/
├── pnpm-workspace.yaml
├── package.json
├── .gitignore
└── README.md
```

## License

MIT
