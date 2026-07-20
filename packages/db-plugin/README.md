# @liziy/db-plugin

> 版本 2.0.0 — AI 接入数据库，原生 Node.js 实现

安装后，AI 助手可以直接查询你的数据库——无需手动切换工具、复制粘贴连接信息。

## 它做了什么

- 管理数据库连接（PostgreSQL / MySQL / Oracle）
- 给 LLM 注册了 3 个工具：`query_database`、`list_tables`、`describe_table`
- 当 AI 需要查数据时，会自动使用这些工具，你只需告知它用哪个数据库
- 原生 Node.js 实现（`pg` / `mysql2` / `oracledb`），无需 Python

## 命令

| 命令 | 说明 |
|------|------|
| `/db` | 管理菜单：查看连接 / 新增连接 / 删除连接 / 配置 |
| `/db add` | 快速新增 |
| `/db rm` | 快速删除 |
| `/db ls` | 列出所有连接 |
| `/db config` | 查看/修改全局配置 |

新增时只需提供 JDBC URL（如 `jdbc:postgresql://host:5432/db`），系统会自动解析类型和地址，并测试连接是否可达。

## 配置

通过 `/db config` 修改全局配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| AI 只读模式 | 是 | AI 只能执行 SELECT 查询 |
| 执行确认 | 写操作确认 | 不确认 / 写操作确认 / 每次都确认 |
| 最大行数 | 100 | 查询返回的最大行数 |
| 查询超时 | 30s | 单条 SQL 超时秒数 |

## 安全控制

- **硬限制 DROP TABLE**：即使关闭只读模式，AI 也无法执行 DROP TABLE
- **只读模式**：AI 只能执行 SELECT，禁止 INSERT/UPDATE/DELETE
- **确认策略**：AI 执行写操作时需用户手动确认

## 安装

```bash
pi install npm:@liziy/db-plugin
```

> 依赖 `pg` / `mysql2` / `oracledb` npm 包，`pi install` 会自动安装。

## 更新日志

### 2.0.0

- 从 Python 子进程迁移到原生 Node.js（`pg` / `mysql2` / `oracledb`）
- 移除 Python 依赖，不再需要手动 `pip install`
- 跨平台超时支持（`statement_timeout` / `max_execution_time`）
- 删除 `scripts/` 目录

### 1.0.0

- 初始发布：Python 子进程实现，支持 PostgreSQL / MySQL / Oracle

## 协议

MIT