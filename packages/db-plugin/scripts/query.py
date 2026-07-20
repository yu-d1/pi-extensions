#!/usr/bin/env python3
"""
执行 SQL 查询
输入: {"type":"...", "host":"...", "port":..., "username":"...", "password":"...",
       "database":"...", "sql":"...", "readonly": true, "max_rows": 100, "timeout": 30}
输出: {"success": true, "columns": ["id", "name"], "rows": [[1, "xxx"]], "rowCount": 2, "duration": "15ms"}
"""
import time
import re
import signal

from db_connector import read_input, output_result, connect


class TimeoutError(Exception):
    pass


def _timeout_handler(signum, frame):
    raise TimeoutError("查询超时")


# 非查询语句（DDL/DML）关键词
_NON_QUERY_PATTERN = re.compile(
    r"^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|LOAD|MERGE|EXEC|EXECUTE|CALL)",
    re.IGNORECASE
)


def _split_statements(sql):
    """按分号拆分多条 SQL，返回语句列表（考虑字符串字面量）"""
    stmts = []
    current = []
    in_string = False
    string_char = None
    i = 0
    while i < len(sql):
        ch = sql[i]
        if in_string:
            current.append(ch)
            if ch == string_char and (i == 0 or sql[i-1] != '\\'):
                in_string = False
                string_char = None
        elif ch in ("'", '"'):
            current.append(ch)
            in_string = True
            string_char = ch
        elif ch == ';':
            stmt = ''.join(current).strip()
            if stmt:
                stmts.append(stmt)
            current = []
        else:
            current.append(ch)
        i += 1
    stmt = ''.join(current).strip()
    if stmt:
        stmts.append(stmt)
    return stmts


def main():
    config = read_input()
    sql = config.get("sql", "").strip()
    readonly = config.get("readonly", True)
    max_rows = config.get("max_rows", 100)
    timeout = config.get("timeout", 30)

    if not sql:
        output_result({"success": False, "error": "SQL 语句不能为空"})
        return

    # 拆分为多条语句，逐条执行
    statements = _split_statements(sql)

    if not statements:
        output_result({"success": False, "error": "没有有效的 SQL 语句"})
        return

    # 只读模式下检查所有语句
    if readonly:
        for stmt in statements:
            if _NON_QUERY_PATTERN.match(stmt):
                output_result({
                    "success": False,
                    "error": f"只读模式下不允许执行非查询语句: {stmt[:80]}"
                })
                return

    start = time.time()

    try:
        # 设置超时（仅 Unix 有效，Windows 无 signal.alarm）
        if hasattr(signal, 'SIGALRM'):
            signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(timeout)

        conn = connect(config)
        cur = conn.cursor()

        last_result = {
            "columns": [],
            "rows": [],
            "rowCount": 0
        }

        for stmt in statements:
            cur.execute(stmt)

            if cur.description:
                # 查询语句 — 返回结果集
                columns = [desc[0] for desc in cur.description]
                rows = [list(row) for row in cur.fetchmany(max_rows)]
                last_result = {
                    "columns": columns,
                    "rows": rows,
                    "rowCount": len(rows)
                }
            else:
                # DDL/DML 语句 — 记录影响行数
                rc = cur.rowcount if cur.rowcount >= 0 else 0
                last_result = {
                    "columns": [],
                    "rows": [],
                    "rowCount": rc
                }

        conn.commit()
        cur.close()
        conn.close()

        # 取消超时
        if hasattr(signal, 'SIGALRM'):
            signal.alarm(0)

        duration = round((time.time() - start) * 1000)
        output_result({
            "success": True,
            **last_result,
            "duration": f"{duration}ms"
        })

    except TimeoutError:
        duration = round((time.time() - start) * 1000)
        output_result({
            "success": False,
            "error": f"查询超时（超过 {timeout} 秒）",
            "duration": f"{duration}ms"
        })
    except Exception as e:
        duration = round((time.time() - start) * 1000)
        output_result({
            "success": False,
            "error": str(e),
            "duration": f"{duration}ms"
        })
    finally:
        if hasattr(signal, 'SIGALRM'):
            signal.alarm(0)


if __name__ == "__main__":
    main()