import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionQueueService } from "./core/session-queue";
import { createLogger } from "./logger";
import { ConfigStore } from "./storage/config-store";
import { GcService } from "./storage/gc";
import { StorageLayout } from "./storage/layout";
import { QueueStore } from "./storage/queue-store";
import { SnapshotStore } from "./storage/snapshot-store";
import { runMainMenu } from "./ui";

export default function sessionQueueExtension(pi: ExtensionAPI): void {
  const logger = createLogger();
  const layout = new StorageLayout();
  layout.ensureDirs();

  const configStore = new ConfigStore(layout.configFile, logger);
  const queueStore = new QueueStore(layout, logger);
  const snapshotStore = new SnapshotStore(layout, logger);
  const gcService = new GcService(layout, queueStore, snapshotStore, configStore, logger);
  const service = new SessionQueueService(configStore, queueStore, snapshotStore, gcService, logger);

  // ── session_start ──
  pi.on("session_start", (_event: any, ctx: any) => {
    if (!ctx.hasUI) {
      service.endSession();
      return;
    }
    try {
      service.startSession(ctx);
      ctx.ui.setStatus("session-queue", service.getStatusText());
    } catch (err) {
      logger.error("session_start 初始化失败", err);
      ctx.ui.setStatus("session-queue", undefined);
    }
  });

  // ── turn_end ──
  pi.on("turn_end", (_event: any, ctx: any) => {
    if (!service.active || !ctx.hasUI) return;
    try {
      service.flushTurn(ctx);
    } catch (err) {
      logger.error("turn_end 写入队列失败", err);
      try {
        ctx.ui.notify(`session-queue 记录失败：${(err as Error).message}`, "error");
      } catch {
        // ignore notify failure
      }
    }
  });

  // ── session_tree ──
  pi.on("session_before_tree", (event: any, ctx: any) => {
    if (!service.active || !ctx.hasUI) return;
    service.prepareSessionTreeNavigation(event, ctx);
  });

  pi.on("session_tree", (event: any, ctx: any) => {
    if (!service.active || !ctx.hasUI) return;
    service.handleSessionTreeNavigation(event, ctx);
  });

  // ── JIT 工具拦截 ──
  pi.on("tool_call", (event: any) => {
    try {
      service.handleToolCall(event);
    } catch (err) {
      logger.warn("tool_call 快照失败", err);
    }
  });

  pi.on("tool_result", (event: any) => {
    try {
      service.handleToolResult(event);
    } catch (err) {
      logger.warn("tool_result 快照失败", err);
    }
  });

  // ── /rollback 命令 ──
  pi.registerCommand("rollback", {
    description: "会话队列回滚（单入口菜单）",
    handler: async (_args: any, ctx: any) => {
      try {
          await runMainMenu(pi, ctx, service);
        } catch (err) {
          logger.error("/rollback 命令执行失败", err);
          try {
            ctx.ui.notify(`session-queue 命令失败：${(err as Error).message}`, "error");
          } catch {
            // ignore notify failure
          }
        }
    },
  });
}
