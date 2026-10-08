/**
 * session-queue 测试入口。
 *
 * 运行：bun run test   （或 npx tsx test/run.ts）
 */
import { runAll } from "./harness";
import { cleanupWorkspaces } from "./fixtures";

import "./tree-sync.test";
import "./branches.test";
import "./file-state.test";
import "./rollback.test";
import "./change-tracker.test";
import "./compat.test";

const failures = await runAll();
cleanupWorkspaces();
if (failures > 0) process.exit(1);
