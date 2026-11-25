import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 原插件上游溯源信息，用于后续对比同步更新 */
export interface PluginUpstream {
  /** 原插件仓库地址 */
  repo: string;
  /** 收编或同步时参考的上游版本号或提交号 */
  ref: string;
  /** 原插件开源协议 */
  license?: string;
  /** 本地裁剪与改写要点 */
  notes?: string;
}

/** 分配给单个子插件的隔离配置存储接口 */
export interface PluginStore<TSettings extends Record<string, unknown>> {
  /** 读取当前启用状态 */
  isEnabled(): boolean;
  /** 写入启用状态并持久化到磁盘 */
  setEnabled(enabled: boolean): boolean;
  /** 读取与默认值合并后的插件专属配置 */
  getSettings(): TSettings;
  /** 浅合并更新插件专属配置并持久化 */
  updateSettings(patch: Partial<TSettings>): boolean;
}

/** 子插件标准协议 */
export interface ToolkitPlugin<TSettings extends Record<string, unknown> = Record<string, any>> {
  /** 唯一短标识，用作配置键名、状态栏前缀及命令行子参数 */
  id: string;
  /** 展示名称 */
  name: string;
  /** 可选展示图标 */
  icon?: string;
  /** 一句话用途说明 */
  description: string;
  /** 默认启用状态 */
  defaultEnabled: boolean;
  /** 默认专属配置 */
  defaultSettings: TSettings;
  /** 切换启停后是否需要 /reload 才生效（加载期注册工具的插件需设为 true） */
  requiresReload?: boolean;
  /** 原插件上游溯源信息 */
  upstream: PluginUpstream;
  /** 扩展加载期挂载逻辑 */
  setup(pi: ExtensionAPI, store: PluginStore<TSettings>): void;
  /** 已启用时在「启用」列表中追加展示的短状态标签 */
  getStatusBadge?(store: PluginStore<TSettings>): string | undefined;
  /** 在「配置」列表中展示的当前配置或业务摘要 */
  getConfigSummary?(ctx: ExtensionContext, store: PluginStore<TSettings>): string | undefined;
  /** 在「启用」菜单切换启停后的回调（用于刷新状态栏等） */
  onToggle?(ctx: ExtensionContext, enabled: boolean, store: PluginStore<TSettings>): void;
  /** 自定义二级配置/操作菜单；返回 "close" 时退出外层配置循环菜单 */
  openMenu?(ctx: ExtensionContext, store: PluginStore<TSettings>): Promise<"close" | void>;
  /** 处理 /toolkit <id> [args] 子命令 */
  handleCommand?(args: string, ctx: ExtensionContext, store: PluginStore<TSettings>): Promise<void> | void;
  /** 返回 /toolkit <id> <prefix> 的参数补全建议 */
  getCompletions?(prefix: string): string[];
}
