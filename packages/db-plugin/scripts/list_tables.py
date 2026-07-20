#!/usr/bin/env python3
"""
列出指定数据库中的所有表
输入: {"type":"...", "host":"...", "port":..., "username":"...", "password":"...", "database":"..."}
输出: {"success": true, "tables": [{"schema": "public", "name": "users", "type": "TABLE", "description": "用户表"}]}
"""
import time
from db_connector import read_input, output_result, connect


def _list_pg_tables(cur):
    cur.execute("""
        SELECT schemaname, tablename, tableowner, obj_description(c.oid) AS description
        FROM pg_catalog.pg_tables t
        JOIN pg_catalog.pg_class c ON c.relname = t.tablename AND c.relnamespace = (
            SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = t.schemaname
        )
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename
    """)
    return [
        {"schema": row[0], "name": row[1], "type": "TABLE", "description": row[3] or ""}
        for row in cur.fetchall()
    ]


def _list_mysql_tables(cur, database):
    cur.execute("SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s ORDER BY TABLE_NAME", (database,))
    return [
        {"schema": "", "name": row[0], "type": "TABLE" if row[1] == "BASE TABLE" else row[1], "description": row[2] or ""}
        for row in cur.fetchall()
    ]


def _list_oracle_tables(cur):
    cur.execute("SELECT TABLE_NAME, OWNER, COMMENTS FROM ALL_TABLES T LEFT JOIN ALL_TAB_COMMENTS C ON T.TABLE_NAME = C.TABLE_NAME AND T.OWNER = C.OWNER WHERE T.OWNER NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'XDB') ORDER BY T.OWNER, T.TABLE_NAME")
    return [
        {"schema": row[1], "name": row[0], "type": "TABLE", "description": row[2] or ""}
        for row in cur.fetchall()
    ]


def _list_sqlite_tables(cur):
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    return [
        {"schema": "", "name": row[0], "type": "TABLE", "description": ""}
        for row in cur.fetchall()
    ]


def main():
    config = read_input()
    db_type = config.get("type", "postgresql")
    start = time.time()

    try:
        conn = connect(config)
        cur = conn.cursor()

        if db_type == "postgresql":
            tables = _list_pg_tables(cur)
        elif db_type == "mysql":
            tables = _list_mysql_tables(cur, config["database"])
        elif db_type == "oracle":
            tables = _list_oracle_tables(cur)
        elif db_type == "sqlite":
            tables = _list_sqlite_tables(cur)
        else:
            tables = []

        cur.close()
        conn.close()

        duration = round((time.time() - start) * 1000)
        output_result({"success": True, "tables": tables, "count": len(tables), "duration": f"{duration}ms"})

    except Exception as e:
        duration = round((time.time() - start) * 1000)
        output_result({"success": False, "error": str(e), "duration": f"{duration}ms"})


if __name__ == "__main__":
    main()