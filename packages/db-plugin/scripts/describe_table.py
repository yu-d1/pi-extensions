#!/usr/bin/env python3
"""
查看指定表的列定义
输入: {"type":"...", "host":"...", "port":..., "username":"...", "password":"...", "database":"...", "table": "users"}
输出: {"success": true, "columns": [{"name": "id", "type": "int4", "nullable": false, "default": null, "primaryKey": true, "comment": "主键"}]}
"""
import time
from db_connector import read_input, output_result, connect


def _describe_pg_table(cur, table):
    # 解析 schema.table 格式
    parts = table.split(".")
    if len(parts) == 2:
        schema, table_name = parts
    else:
        schema, table_name = "public", table

    cur.execute("""
        SELECT
            a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '') AS default_val,
            COALESCE(ct.contype = 'p', FALSE) AS primary_key,
            COALESCE(cd.description, '') AS comment
        FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        LEFT JOIN pg_catalog.pg_description cd ON a.attrelid = cd.objoid AND a.attnum = cd.objsubid
        LEFT JOIN pg_catalog.pg_constraint ct ON a.attrelid = ct.conrelid
            AND ct.contype = 'p' AND a.attnum = ANY(ct.conkey)
        WHERE a.attrelid = (
            SELECT c.oid FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
            WHERE c.relname = %s AND n.nspname = %s
        ) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
    """, (table_name, schema))

    return [
        {"name": row[0], "type": row[1], "nullable": row[2], "default": row[3] if row[3] else None, "primaryKey": row[4], "comment": row[5]}
        for row in cur.fetchall()
    ]


def _describe_mysql_table(cur, table):
    cur.execute("DESCRIBE `{}`".format(table.replace("`", "``")))
    columns = []
    for row in cur.fetchall():
        columns.append({
            "name": row[0],
            "type": row[1],
            "nullable": row[2] == "YES",
            "default": row[4],
            "primaryKey": row[3] == "PRI",
            "comment": ""
        })
    return columns


def _describe_oracle_table(cur, table):
    cur.execute("""
        SELECT
            COLUMN_NAME,
            DATA_TYPE || CASE WHEN DATA_PRECISION IS NOT NULL THEN '(' || DATA_PRECISION || ',' || DATA_SCALE || ')' WHEN DATA_LENGTH IS NOT NULL AND DATA_TYPE LIKE '%CHAR%' THEN '(' || DATA_LENGTH || ')' ELSE '' END,
            NULLABLE,
            DATA_DEFAULT,
            COLUMN_ID,
            COMMENTS
        FROM ALL_TAB_COLUMNS C
        LEFT JOIN ALL_COL_COMMENTS COM ON C.TABLE_NAME = COM.TABLE_NAME AND C.COLUMN_NAME = COM.COLUMN_NAME AND C.OWNER = COM.OWNER
        WHERE C.TABLE_NAME = %s AND C.OWNER = %s
        ORDER BY C.COLUMN_ID
    """, (table.upper(), "PUBLIC"))
    # 简化处理，实际需解析 schema
    columns = []
    for row in cur.fetchall():
        columns.append({
            "name": row[0],
            "type": row[1],
            "nullable": row[2] == "Y",
            "default": row[3] if row[3] else None,
            "primaryKey": False,
            "comment": row[5] or ""
        })

    # 查主键
    cur.execute("""
        SELECT cc.COLUMN_NAME
        FROM ALL_CONS_COLUMNS cc
        JOIN ALL_CONSTRAINTS c ON cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.OWNER = c.OWNER
        WHERE c.CONSTRAINT_TYPE = 'P' AND c.TABLE_NAME = %s
    """, (table.upper(),))
    pk_set = {row[0] for row in cur.fetchall()}
    for col in columns:
        if col["name"] in pk_set:
            col["primaryKey"] = True

    return columns


def _describe_sqlite_table(cur, table):
    cur.execute("PRAGMA table_info(`{}`)".format(table.replace("`", "``")))
    columns = []
    for row in cur.fetchall():
        columns.append({
            "name": row[1],
            "type": row[2],
            "nullable": not row[3],
            "default": row[4],
            "primaryKey": bool(row[5]),
            "comment": ""
        })
    return columns


def main():
    config = read_input()
    table = config.get("table", "").strip()
    db_type = config.get("type", "postgresql")

    if not table:
        output_result({"success": False, "error": "表名不能为空"})
        return

    start = time.time()

    try:
        conn = connect(config)
        cur = conn.cursor()

        if db_type == "postgresql":
            columns = _describe_pg_table(cur, table)
        elif db_type == "mysql":
            columns = _describe_mysql_table(cur, table)
        elif db_type == "oracle":
            columns = _describe_oracle_table(cur, table)
        elif db_type == "sqlite":
            columns = _describe_sqlite_table(cur, table)
        else:
            columns = []

        cur.close()
        conn.close()

        duration = round((time.time() - start) * 1000)
        output_result({"success": True, "columns": columns, "count": len(columns), "duration": f"{duration}ms"})

    except Exception as e:
        duration = round((time.time() - start) * 1000)
        output_result({"success": False, "error": str(e), "duration": f"{duration}ms"})


if __name__ == "__main__":
    main()