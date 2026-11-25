/**
 * 子插件：提问对话框（ask_user_question）
 *
 * 原插件地址：https://github.com/juicesharp/rpiv-pi
 * 同步基线：7525a5d (@juicesharp/rpiv-ask-user-question) · 协议：MIT
 * 本地改写：移除 rpiv-config / rpiv-i18n 外部依赖，保留结构化提问对话框与自定义输入修复。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAskUserQuestionExtension from "./ask-user-question/index.js";
import type { ToolkitPlugin } from "../types.js";

export const askUserQuestionPlugin: ToolkitPlugin<Record<string, never>> = {
  id: "question",
  name: "提问对话框",
  icon: "💬",
  description: "结构化单选/多选/备注终端提问工具 (ask_user_question)",
  defaultEnabled: true,
  defaultSettings: {},
  requiresReload: true,
  upstream: {
    repo: "https://github.com/juicesharp/rpiv-pi",
    ref: "7525a5d (@juicesharp/rpiv-ask-user-question)",
    license: "MIT",
    notes: "移除 rpiv-config / rpiv-i18n 外部依赖，保留结构化提问对话框与自定义输入修复",
  },

  setup(pi: ExtensionAPI): void {
    registerAskUserQuestionExtension(pi);
  },
};
