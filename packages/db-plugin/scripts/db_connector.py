"""
数据库连接工厂 — 根据 type 自动选择对应驱动
支持: postgresql, mysql, oracle, sqlite
"""

import sys
import json


def connect(config):
    """根据 config.type 返回数据库连接对象"""
    db_type = config.get("type", "postgresql")

    if db_type == "postgresql":
        import psycopg2
        return psycopg2.connect(
            host=config["host"],
            port=config.get("port", 5432),
            user=config["username"],
            password=config["password"],
            dbname=config["database"]
        )
    elif db_type == "mysql":
        import pymysql
        return pymysql.connect(
            host=config["host"],
            port=config.get("port", 3306),
            user=config["username"],
            password=config["password"],
            database=config["database"],
            charset="utf8mb4"
        )
    elif db_type == "oracle":
        import oracledb
        return oracledb.connect(
            host=config["host"],
            port=config.get("port", 1521),
            user=config["username"],
            password=config["password"],
            service_name=config.get("extraParams", {}).get("serviceName", config["database"])
        )
    elif db_type == "sqlite":
        import sqlite3
        return sqlite3.connect(config["database"])
    else:
        raise ValueError(f"不支持的数据库类型: {db_type}")


def read_input():
    """从 stdin 读取 JSON 输入"""
    raw = sys.stdin.read()
    return json.loads(raw)


def output_result(data):
    """输出 JSON 结果到 stdout"""
    print(json.dumps(data, ensure_ascii=False, default=str))
    sys.stdout.flush()