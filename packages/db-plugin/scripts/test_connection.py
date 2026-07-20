#!/usr/bin/env python3
"""
测试数据库连接
输入: {"type":"...", "host":"...", "port":..., "username":"...", "password":"...", "database":"..."}
输出: {"success": true, "version": "PostgreSQL 16.2", "latency": "3ms"}
"""
import sys
import time
from db_connector import read_input, output_result, connect


def main():
    config = read_input()
    start = time.time()

    try:
        conn = connect(config)
        cur = conn.cursor()

        # 获取数据库版本
        db_type = config.get("type", "postgresql")
        if db_type == "postgresql":
            cur.execute("SELECT version()")
            version = cur.fetchone()[0].split(",")[0].strip()
        elif db_type == "mysql":
            cur.execute("SELECT version()")
            version = cur.fetchone()[0]
        elif db_type == "oracle":
            cur.execute("SELECT version FROM v$instance")
            version = cur.fetchone()[0]
        elif db_type == "sqlite":
            cur.execute("SELECT sqlite_version()")
            version = cur.fetchone()[0]
        else:
            version = "unknown"

        cur.close()
        conn.close()

        latency = round((time.time() - start) * 1000)
        output_result({"success": True, "version": str(version), "latency": f"{latency}ms"})

    except Exception as e:
        latency = round((time.time() - start) * 1000)
        output_result({"success": False, "error": str(e), "latency": f"{latency}ms"})


if __name__ == "__main__":
    main()