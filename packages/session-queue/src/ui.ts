import * as path from "node:path";
import { KEEP_QUEUE_PRESETS } from "./constants";
import type { QueueEntry } from "./types";
import type { SessionQueueService } from "./core/session-queue";
import { TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { NodeSwitchPreview } from "./core/tree";
import { truncateText } from "./utils/format";
import { samePath } from "./utils/path";

/**
 * 所有 UI 选择都通过“选项下标”映射到业务动作，
 * 不把显示文本用于业务判断。
 */
async function selectIndex(ctx: any, title: string, options: string[]): Promise<number | null> {
  const choice = await ctx.ui.select(title, options);
  if (!choice) return null;
  const index = options.indexOf(choice);
  return index >= 0 ? index : null;
}

// ---------------------------------------------------------------------
// 树形回滚历史菜单
// ---------------------------------------------------------------------

/** 使用 pi 内置会话树组件选择 user 对话，返回会话 entry id。 */
async function selectSessionUserEntry(ctx: any): Promise<string | null> {
  const tree = ctx.sessionManager?.getTree?.() ?? [];
  if (!Array.isArray(tree) || tree.length === 0) return null;
  const currentLeafId = ctx.sessionManager?.getLeafId?.() ?? null;
  return await ctx.ui.custom<string | null>((tui: any, _theme: any, _keybindings: any, done: (value: string | null) => void) => {
    const selector = new TreeSelectorComponent(
      tree,
      currentLeafId,
      Math.max(1, tui.terminal.rows - 2),
      (entryId: string) => {
        done(entryId);
      },
      () => done(null),
      undefined,
      undefined,
      "user-only",
    );
    selector.onCopy = (text) => {
      if (text) ctx.ui.notify("已复制当前对话", "info");
    };
    return selector;
  });
}

/** 一行的变更概要（用于操作面板标题，避免一次性堆全部文件路径）。 */
function summarizePreview(preview: NodeSwitchPreview): string {
  const parts: string[] = [];
  if (preview.restore.length > 0) parts.push(`还原 ${preview.restore.length}`);
  if (preview.create.length > 0) parts.push(`新增 ${preview.create.length}`);
  if (preview.remove.length > 0) parts.push(`删除 ${preview.remove.length}`);
  if (preview.baselineRestored.length > 0) parts.push(`分叉还原 ${preview.baselineRestored.length}`);
  return parts.length > 0 ? parts.join(" · ") : "无文件变更";
}

/** 变化总量（用于“切过去会影响 N 个文件”提示）。 */
function previewTotal(preview: NodeSwitchPreview): number {
  return preview.restore.length + preview.create.length + preview.remove.length;
}

export async function showRollbackUI(ctx: any, service: SessionQueueService): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("rollback 需要交互模式", "error");
    return;
  }
  if (!service.session) {
    ctx.ui.notify("无活跃 session", "error");
    return;
  }
  if (!service.active) {
    ctx.ui.notify("当前工作区未启用，无法回滚", "error");
    return;
  }
  if (service.busy) {
    ctx.ui.notify("正在处理上一轮，请稍候", "warning");
    return;
  }

  const queue = service.loadCurrentQueue();
  const entries = queue?.entries ?? [];
  if (entries.length === 0) {
    ctx.ui.notify("没有可回滚的检查点", "info");
    return;
  }

  // ── 使用 pi 内置 /tree 组件选择目标 user 对话 ──
  const selectedSessionEntryId = await selectSessionUserEntry(ctx);
  if (!selectedSessionEntryId) return;

  // 当前树组件展示所有 user 对话；这里只接受有队列检查点的节点。
  const targetEntry = entries.find(
    (entry) => entry.sessionEntryId === selectedSessionEntryId && !entry.residual,
  );
  if (!targetEntry) {
    ctx.ui.notify("所选对话还没有文件检查点", "info");
    return;
  }

  // await 期间队列可能已变化，重新加载后定位。
  const reloaded = service.loadCurrentQueue();
  if (!reloaded) {
    ctx.ui.notify("队列状态已变化，请重试", "warning");
    return;
  }
  const targetIdx = reloaded.entries.findIndex(
    (entry) => entry.turnIndex === targetEntry!.turnIndex && entry.timestamp === targetEntry!.timestamp,
  );
  if (targetIdx < 0) {
    ctx.ui.notify("目标检查点已不存在，请重新选择", "warning");
    return;
  }

  // ── 操作面板（一屏决策，信息分层） ──
  type ActionKind = "before" | "before-force" | "cancel";
  interface ActionDef {
    label: string;
    kind: ActionKind;
  }

  let done = false;
  while (!done) {
    const previewRes = service.previewNodeTarget(targetIdx, "before");
    if (!previewRes) {
      ctx.ui.notify("队列状态已变化，请重试", "warning");
      return;
    }
    const preview = previewRes.preview;
    const hasConflict = preview.conflicts.length > 0;

    let title =
      `节点 #${targetEntry.turnIndex}「${truncateText(targetEntry.text.replace(/\s+/g, " "), 24)}」\n` +
      `回滚并跳转到该对话发送前：${summarizePreview(preview)}`;
    if (previewTotal(preview) > 0) title += `（共 ${previewTotal(preview)} 个文件）`;
    if (hasConflict) title += `   ⚠ ${preview.conflicts.length} 冲突`;

    // 回滚语义固定为目标 user 对话发送前；有冲突时提供强制覆盖。
    const actions: ActionDef[] = [];
    actions.push({
      label: (hasConflict ? "🛡️ " : "↩️ ") + (hasConflict ? "回滚并跳转（强制覆盖）" : "回滚并跳转"),
      kind: hasConflict ? "before-force" : "before",
    });
    actions.push({ label: "🚫 取消", kind: "cancel" });

    const labels = actions.map((a) => a.label);
    const choiceIndex = await selectIndex(ctx, title, labels);
    if (choiceIndex === null) return;
    const action = actions[choiceIndex]?.kind ?? "cancel";
    if (action === "cancel") return;

    const force = action === "before-force";
    try {
      const execution = await service.rollbackToConversation(targetIdx, ctx, force);
      const parts: string[] = [];
      if (execution.result.restored > 0) parts.push(`还原 ${execution.result.restored}`);
      if (execution.result.deleted > 0) parts.push(`删除 ${execution.result.deleted}`);
      let message = `📌 已回滚并跳转到 #${execution.targetEntry.turnIndex}「${truncateText(execution.targetEntry.text, 26)}」发送前`;
      if (parts.length > 0) message += `：${parts.join("、")}`;
      if (execution.result.skipped.length > 0) message += `（跳过 ${execution.result.skipped.length} 个冲突）`;
      if (execution.result.missingSnapshot.length > 0) message += `（${execution.result.missingSnapshot.length} 个快照丢失）`;
      ctx.ui.setStatus("session-queue", service.getStatusText(`@#${execution.targetEntry.turnIndex}·前`));
      ctx.ui.notify(message, execution.result.skipped.length > 0 || execution.result.missingSnapshot.length > 0 ? "warning" : "success");
      return;
    } catch (err) {
      ctx.ui.notify(`操作失败：${(err as Error).message}`, "error");
      return;
    }
  }
}

export async function showGlobalConfigUI(ctx: any, service: SessionQueueService): Promise<void> {
  while (true) {
    const cfg = service.getConfig();
    const options = [
      "🔢 每工作区保留队列数: " + cfg.keepQueueCountPerWorkspace,
      "🗑️  删除工作区时清除数据: " + (cfg.clearDataOnRemoveWorkspace ? "是" : "否"),
      "🌳 跟随 Session Tree: " + (cfg.followSessionTree ? "开" : "关"),
      "🔙 返回",
    ];

    const choiceIndex = await selectIndex(ctx, "全局配置", options);
    if (choiceIndex === null || choiceIndex === 3) return;

    if (choiceIndex === 0) {
      const presetOptions = KEEP_QUEUE_PRESETS.map(String);
      const presetIndex = await selectIndex(
        ctx,
        `选择每工作区保留的队列数（当前：${cfg.keepQueueCountPerWorkspace}）`,
        presetOptions,
      );
      if (presetIndex !== null && presetOptions[presetIndex]) {
        const value = Number(presetOptions[presetIndex]);
        service.setKeepQueueCount(value);
        ctx.ui.notify(`✅ 已设置每工作区保留 ${value} 个队列`, "success");
      }
    } else if (choiceIndex === 1) {
      service.setClearDataOnRemoveWorkspace(!cfg.clearDataOnRemoveWorkspace);
      ctx.ui.notify(
        cfg.clearDataOnRemoveWorkspace
          ? "✅ 删除工作区时将清除数据"
          : "✅ 删除工作区时保留数据（仅从列表移除）",
        "info",
      );
    } else if (choiceIndex === 2) {
      const next = !cfg.followSessionTree;
      service.setFollowSessionTree(next);
      ctx.ui.notify(
        next ? "🔗 已开启：Session Tree 导航将自动回滚队列" : "⏸ 已关闭：Session Tree 导航不会自动回滚队列",
        "info",
      );
      ctx.ui.setStatus("session-queue", service.getStatusText());
    }
  }
}

export async function manageWorkspaces(ctx: any, service: SessionQueueService): Promise<boolean> {
  const config = service.getConfig();
  if (config.workspaces.length === 0) {
    ctx.ui.notify("没有已启用的工作区", "info");
    return false;
  }

  const workspaceOptions = config.workspaces.map((ws) => {
    const isCurrent = service.active !== null && samePath(service.active, ws);
    const tag = isCurrent ? "  ← 当前" : "";
    return `${ws}  (${service.getQueueCount(ws)} queue)${tag}`;
  });
  const workspaceBackIndex = workspaceOptions.length;
  const workspaceSelectOptions = [...workspaceOptions, "🔙 返回"];

  const wsIndex = await selectIndex(ctx, `已启用的工作区 (${config.workspaces.length})`, workspaceSelectOptions);
  if (wsIndex === null || wsIndex === workspaceBackIndex) return false;

  const selectedWs = config.workspaces[wsIndex];
  const isCurrent = service.active !== null && samePath(service.active, selectedWs);

  const opOptions = [
    isCurrent ? "⏸️ 停用工作区" : "✅ 启用此工作区",
    "🗑️ 删除工作区",
    "🔙 返回",
  ];
  const opIndex = await selectIndex(ctx, `工作区: ${selectedWs}`, opOptions);
  if (opIndex === null || opIndex === 2) return false;

  if (opIndex === 0) {
    if (isCurrent) {
      service.pauseWorkspace();
      ctx.ui.setStatus("session-queue", undefined);
      ctx.ui.notify(`⏸ 已停用：${selectedWs}（仍在列表中，可重新启用）`, "info");
      return true;
    }

    if (service.active) {
      ctx.ui.notify("已有其他工作区启用中，请先停用", "warning");
      return false;
    }

    // 修复：启用的是用户选中的工作区，而不是 ctx.cwd。
    const enabled = service.enableWorkspace(selectedWs, ctx.cwd);
    ctx.ui.setStatus("session-queue", service.getStatusText());
    ctx.ui.notify(`✅ 已启用：${enabled}`, "success");
    return true;
  }

  // 删除工作区。
  const deleteOptions = ["🗑️ 确认删除", "🚫 取消"];
  const deleteIndex = await selectIndex(ctx, `确认删除工作区：${selectedWs}`, deleteOptions);
  if (deleteIndex !== 0) return false;

  const result = service.removeWorkspace(selectedWs);
  if (!result.removed) {
    ctx.ui.notify("未找到要删除的工作区", "warning");
    return false;
  }
  if (result.wasActive) {
    ctx.ui.setStatus("session-queue", undefined);
  }
  ctx.ui.notify(
    result.clearedData
      ? `🗑️ 已删除并清除数据：${selectedWs}`
      : `🗑️ 已从列表移除（数据保留）：${selectedWs}`,
    "success",
  );
  return false;
}

export async function runMainMenu(_pi: any, ctx: any, service: SessionQueueService): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("rollback 需要交互模式", "error");
    return;
  }

  while (true) {
    const queue = service.loadCurrentQueue();
    const entries = queue?.entries ?? [];
    const queueSize = entries.length;
    const current = (queue?.currentIndex ?? -1) >= 0 ? entries[queue!.currentIndex] : undefined;

    const title = current
      ? `会话队列回滚（当前 ▶ #${current.turnIndex}「${truncateText(current.text.replace(/\s+/g, " "), 20)}」）`
      : "会话队列回滚";

    const actions: { label: string; run: () => Promise<boolean> }[] = [
      {
        label: "📋 " + `回滚历史（树形）  (${Math.max(0, queueSize - 1)} 个检查点)`,
        run: async () => {
          await showRollbackUI(ctx, service);
          return false;
        },
      },
    ];

    actions.push({
      label: "📂 管理工作区",
      run: async () => manageWorkspaces(ctx, service),
    });
    actions.push({
      label: "⚙️  全局配置",
      run: async () => {
        await showGlobalConfigUI(ctx, service);
        return false;
      },
    });
    actions.push({
      label: "🗑️  清空当前队列",
      run: async () => {
        if (!service.session || !service.active) {
          ctx.ui.notify("无活跃 session 或工作区未启用", "info");
          return false;
        }
        if (queueSize === 0) {
          ctx.ui.notify("队列已经为空", "info");
          return false;
        }
        try {
          service.clearCurrentQueue();
          const gc = service.runGc();
          ctx.ui.notify(
            `✅ 队列已清空，回收 ${gc.snapDeleted} 个孤儿快照${gc.queueDeleted ? `，清理 ${gc.queueDeleted} 个旧 queue 文件` : ""}`,
            "success",
          );
        } catch (err) {
          ctx.ui.notify(`清空队列失败：${(err as Error).message}`, "error");
        }
        return false;
      },
    });
    actions.push({
      label: "♻️  回收孤儿快照",
      run: async () => {
        try {
          const gc = service.runGc();
          const corrupt = gc.corruptQueueSkipped > 0 ? `；跳过 ${gc.corruptQueueSkipped} 个损坏 queue` : "";
          ctx.ui.notify(
            `🧹 扫描 ${gc.snapScanned} 个快照，删除 ${gc.snapDeleted} 个孤儿，存活 ${gc.live} 个` +
              (gc.queueDeleted ? `；清理 ${gc.queueDeleted} 个旧 queue 文件，保留 ${gc.queueKept} 个` : "") +
              corrupt,
            "success",
          );
        } catch (err) {
          ctx.ui.notify(`GC 失败：${(err as Error).message}`, "error");
        }
        return false;
      },
    });
    actions.push({ label: "🚪 退出菜单", run: async () => true });

    if (!service.active) {
      actions.splice(1, 0, {
        label: "✅ 启用当前工作区",
        run: async () => {
          service.enableWorkspace(ctx.cwd, ctx.cwd);
          ctx.ui.setStatus("session-queue", service.getStatusText());
          ctx.ui.notify(`✅ 已启用变更记录：${service.active}`, "success");
          return true;
        },
      });
    }

    const labels = actions.map((a) => a.label);
    const choiceIndex = await selectIndex(ctx, title, labels);
    if (choiceIndex === null) return;
    const shouldExit = await actions[choiceIndex]?.run();
    if (shouldExit) return;
  }
}

function relativeOrSelf(workspace: string, filePath: string): string {
  return path.relative(workspace, filePath) || filePath;
}
