# @liziy/db-plugin

pi 的数据库管理扩展。安装后，AI 助手可以直接查询你的数据库——无需手动切换工具、复制粘贴连接信息。

## 它做了什么

- 管理数据库连接（PostgreSQL / MySQL / Oracle）
- 给 LLM 注册了 3 个工具：`query_database`、`list_tables`、`describe_table`
- 当 AI 需要查数据时，会自动使用这些工具，你只需告知它用哪个数据库

## 命令

| 命令 | 说明 |
|------|------|
| `/db` | 管理菜单：查看连接 / 新增连接 / 删除连接 |
| `/db add` | 快速新增 |
| `/db rm` | 快速删除 |
| `/db ls` | 列出所有连接 |

新增时只需提供 JDBC URL（如 `jdbc:postgresql://host:5432/db`），系统会自动解析类型和地址，并测试连接是否可达。

## 安装前准备

需要 Python 3.8+，并按需安装数据库驱动：

```bash
pip install psycopg2-binary   # PostgreSQL
pip install pymysql            # MySQL
pip install oracledb           # Oracle
```

## 安装

```bash
pi install npm:@liziy/db-plugin
```

## 协议

MIT