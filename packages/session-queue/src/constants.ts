export const EXTENSION_NAME = "session-queue";
export const QUEUE_DATA_VERSION = 1 as const;
export const CONFIG_VERSION = 2 as const;

export const DEFAULT_KEEP_QUEUE = 10;
export const KEEP_QUEUE_PRESETS = [5, 10, 20, 50] as const;
export const GC_THROTTLE_MS = 5 * 60 * 1000;

export const WRITE_TOOLS = new Set(["edit", "write"]);

/** 哨兵值：表示文件不存在。实际 sha256 几乎不可能撞上全 0。 */
export const EMPTY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export const TURN_0_TEXT = "（会话起点）";
export const RESIDUAL_TEXT = "（未回滚残留）";
export const CURRENT_STATE_TEXT = "当前状态";

export const LOG_PREFIX = "[session-queue]";
