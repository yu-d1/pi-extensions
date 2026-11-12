import {
  Container,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  fuzzyFilter,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── 数据库启用勾选组件 ────────────────────────────
// 参照模型选择器的交互：搜索框 + 可滚动列表 + 快捷键行。
// ↑↓ 移动、空格切换勾选、^a 全选、^s 保存、esc 取消。

export interface ToggleItem {
  id: string;
  /** 主文本，参与模糊搜索 */
  label: string;
  /** 右侧状态徽标 */
  badge?: string;
  /** 附加说明，仅在选中行下方显示 */
  detail?: string;
  /** 是否为「连接本身」这类特殊项：不参与全选 */

  pinned?: boolean;
}

interface ToggleOptions {
  title: string;
  subtitle: string;
  countLabel: string;
  /** 至少保留一个勾选项，用于「库」这类约束 */
  minSelected?: number;
  /** 副标题下方的提示行 */
  hint?: string;
}

class ToggleSelectorComponent extends Container implements Focusable {
  readonly capturesViewportInput = true;
  private _focused = false;

  /** 焦点状态需传递给内部 Input，否则输入法候选框会出现在错误位置 */
  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  private readonly allItems: ToggleItem[];
  private markedIds: string[];
  private filtered: ToggleItem[] = [];
  private selectedIndex = 0;
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private readonly footerText: Text;
  private readonly maxVisible = 10;
  private isDirty = false;
  private saving = false;
  private saveNote = "";
  /** esc 第一次按下时置位，再次按下才放弃修改并退出 */
  private discardArmed = false;
  private readonly options: ToggleOptions;
  private readonly tui: any;
  private readonly keybindings: any;
  private readonly theme: any;
  private readonly done: (result: { selected: string[]; added: string[] } | null) => void;
  private readonly onSave?: (result: { selected: string[]; added: string[] }) => void | Promise<void>;
  /** 用户在搜索框里手输的新库名 */
  private addedNames: string[] = [];

  constructor(
    tui: any,
    items: ToggleItem[],
    initialMarked: string[],
    options: ToggleOptions,
    keybindings: any,
    theme: any,
    done: (result: { selected: string[]; added: string[] } | null) => void,
    onSave?: (result: { selected: string[]; added: string[] }) => void | Promise<void>,
  ) {
    super();
    this.allItems = items;
    this.markedIds = [...initialMarked];
    this.options = options;
    this.tui = tui;
    this.keybindings = keybindings;
    this.theme = theme;
    this.done = done;
    this.onSave = onSave;

    const border = this.theme.fg("border", "─".repeat(60));
    this.addChild(new Text(border, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(options.title)), 0, 0));
    this.addChild(new Text(this.theme.fg("muted", options.subtitle), 0, 0));
    if (options.hint) {
      this.addChild(new Text(this.theme.fg("dim", options.hint), 0, 0));
    }
    this.addChild(new Spacer(1));

    this.searchInput = new Input({ placeholder: "搜索或输入新库名…" });
    this.searchInput.focused = true;
    this._focused = true;
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.footerText = new Text("", 0, 0);
    this.addChild(this.footerText);
    this.addChild(new Text(border, 0, 0));

    this.refresh();
  }

  private keyLabel(id: string): string {
    try {
      const keys = this.keybindings?.getKeys?.(id);
      return Array.isArray(keys) && keys.length > 0 ? keys.join("/") : "";
    } catch {
      return "";
    }
  }

  /** 勾选部分排在前面，未勾选的保持原顺序 */
  private buildItems(): ToggleItem[] {
    const marked = new Set(this.markedIds);
    // 「连接本身」始终置顶，其余按勾选状态排序
    const pinned = this.allItems.filter((item) => item.pinned);
    const pinnedIds = new Set(pinned.map((i) => i.id));
    const rest = this.allItems.filter((item) => !pinnedIds.has(item.id));
    return [
      ...pinned,
      ...rest.filter((i) => marked.has(i.id)),
      ...rest.filter((i) => !marked.has(i.id)),
    ];
  }

  private refresh() {
    const query = this.searchInput.getValue().trim();
    const base = this.buildItems();
    // 有搜索词时，pinned 项也参与过滤
    this.filtered = query ? fuzzyFilter(base, query, (item) => item.label) : base;
    if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    }
    this.updateList();
    this.updateFooter();
    this.tui?.requestRender?.();
  }

  private updateList() {
    this.listContainer.clear();
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  没有匹配的库"), 0, 0));
      return;
    }

    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filtered.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filtered[i];
      const isSelected = i === this.selectedIndex;
      const marked = this.markedIds.includes(item.id);
      const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const mark = marked ? this.theme.fg("success", "✓ ") : this.theme.fg("dim", "✗ ");
      const label = isSelected ? this.theme.fg("accent", item.label) : item.label;
      const badge = item.badge ? this.theme.fg("muted", `  ${item.badge}`) : "";
      this.listContainer.addChild(new Text(`${prefix}${mark}${label}${badge}`, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filtered.length) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
      );
    }

    const selected = this.filtered[this.selectedIndex];
    if (selected?.detail) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(this.theme.fg("muted", `  ${selected.detail}`), 0, 0));
    }
  }
  private updateFooter() {
    const libCount = this.markedIds.filter((id) => !this.isPinned(id)).length;
    const totalLibs = this.allItems.filter((item) => !item.pinned).length;
    const parts = [
      `${this.keyLabel("tui.select.confirm") || "空格"} 切换`,
      `${this.keyLabel("app.models.enableAll") || "^a"} 全选`,
      `${this.keyLabel("app.models.clearAll") || "^x"} 清空`,
      `${this.keyLabel("app.models.save") || "^s"} 保存`,
      this.discardArmed ? "esc 再按一次放弃修改" : "esc 完成",
      `${this.options.countLabel} ${libCount}/${totalLibs}`,
    ];
    const text = `  ${parts.join(" · ")}${this.saveNote ? ` · ${this.saveNote}` : ""}`;
    this.footerText.setText(
      this.isDirty
        ? this.theme.fg("dim", text) + this.theme.fg("warning", " （未保存）")
        : this.theme.fg("dim", text),
    );
  }

  /** ^s：保存但不关闭界面，可继续调整 */
  private triggerSave() {
    if (this.saving) return;
    const selected = [...this.markedIds];
    const added = [...this.addedNames];

    if (!this.onSave) {
      this.isDirty = false;
      this.saveNote = "已保存";
      this.refresh();
      return;
    }

    this.saving = true;
    this.saveNote = "";
    this.refresh();

    Promise.resolve()
      .then(() => this.onSave!({ selected, added }))
      .then(() => {
        this.saving = false;
        this.isDirty = false;
        this.saveNote = "已保存";
        this.refresh();
      })
      .catch((err) => {
        this.saving = false;
        this.saveNote = `保存失败：${err instanceof Error ? err.message : String(err)}`;
        this.refresh();
      });
  }

  /** esc：未修改直接退出；修改过则先按一次确认放弃，再按退出 */
  private handleEscape() {
    if (this.saving) return;

    // 有搜索词时先清搜索词
    if (this.searchInput.getValue()) {
      this.searchInput.setValue("");
      this.discardArmed = false;
      this.refresh();
      return;
    }

    if (this.isDirty && !this.discardArmed) {
      this.discardArmed = true;
      this.saveNote = "未保存的修改会丢失";
      this.refresh();
      return;
    }

    if (this.isDirty) {
      // 确认放弃
      this.done(null);
      return;
    }

    // 没有未保存修改，视为完成：按当前勾选返回
    this.done({ selected: [...this.markedIds], added: [...this.addedNames] });
  }

  /** 切换一项；若会破坏最小勾选数则拒绝 */
  private toggle(item: ToggleItem): boolean {
    const index = this.markedIds.indexOf(item.id);
    if (index >= 0) {
      const min = this.options.minSelected ?? 0;
      // 「库」类条目（非 pinned）的数量不能低于 minSelected
      const libCount = this.markedIds.filter((id) => !this.isPinned(id)).length;
      if (!item.pinned && libCount - 1 < min) {
        return false;
      }
      this.markedIds.splice(index, 1);
    } else {
      this.markedIds.push(item.id);
    }
    this.isDirty = true;
    return true;
  }

  private isPinned(id: string): boolean {
    return this.allItems.some((item) => item.id === id && item.pinned);
  }

  handleInput(data: string): void {
    const kb = this.keybindings;

    if (kb?.matches?.(data, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.updateList();
      this.tui?.requestRender?.();
      return;
    }

    if (kb?.matches?.(data, "tui.select.down")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      this.tui?.requestRender?.();
      return;
    }

    if (kb?.matches?.(data, "tui.select.confirm") || matchesKey(data, Key.space)) {
      const query = this.searchInput.getValue().trim();
      const item = this.filtered[this.selectedIndex];

      // 搜索词不命中任何条目时，回车将其作为新库名并自动勾选
      if (query && (!item || item.label.toLowerCase() !== query.toLowerCase())) {
        const exists = this.allItems.some((i) => i.label.toLowerCase() === query.toLowerCase());
        if (!exists && !this.addedNames.includes(query)) {
          this.addedNames.push(query);
          this.allItems.push({ id: query, label: query, badge: "新增" });
          this.markedIds.push(query);
          this.isDirty = true;
          this.searchInput.setValue("");
          this.refresh();
          return;
        }
      }

      if (item) {
        if (!this.toggle(item)) {
          this.footerText.setText(this.theme.fg("warning", "  至少要保留一个启用的库"));
          return;
        }
        this.refresh();
      }
      return;
    }

    if (kb?.matches?.(data, "app.models.enableAll")) {
      const targets = this.searchInput.getValue()
        ? this.filtered.filter((i) => !i.pinned).map((i) => i.id)
        : this.allItems.filter((i) => !i.pinned).map((i) => i.id);
      for (const id of targets) {
        if (!this.markedIds.includes(id)) this.markedIds.push(id);
      }
      this.isDirty = true;
      this.refresh();
      return;
    }

    if (kb?.matches?.(data, "app.models.clearAll")) {
      const min = this.options.minSelected ?? 0;
      const pinned = this.allItems.filter((i) => i.pinned).map((i) => i.id);
      // 保留 pinned 项；若要求最少库数，保留第一个已勾选的库
      const firstLib = this.markedIds.find((id) => !pinned.includes(id));
      this.markedIds = [
        ...pinned.filter((id) => this.markedIds.includes(id)),
        ...(min > 0 && firstLib ? [firstLib] : []),
      ];
      this.isDirty = true;
      this.refresh();
      return;
    }

    if (kb?.matches?.(data, "app.models.save")) {
      this.triggerSave();
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      this.handleEscape();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.handleEscape();
      return;
    }

    // 任何输入都会取消「放弃确认」状态
    if (this.discardArmed) {
      this.discardArmed = false;
      this.saveNote = "";
    }

    this.searchInput.handleInput(data);
    this.refresh();
  }
}

/**
 * 以模型选择器风格的界面编辑连接的启用状态。
 * 返回最终勾选的条目 id 列表；用户取消时返回 undefined。
 */
export interface ToggleResult {
  /** 勾选的条目 id */
  selected: string[];
  /** 用户在搜索框里新增的库名 */
  added: string[];
}

/**
 * 以模型选择器风格的界面编辑连接的启用状态。
 *
 * 交互：空格切换、^a 全选、^x 清空、^s 保存但留在界面、esc 完成（有未保存修改时需再按一次放弃）。
 * 取消时返回 undefined。
 */
export async function pickEnabledItems(
  ctx: ExtensionContext,
  params: {
    title: string;
    subtitle: string;
    hint?: string;
    countLabel: string;
    items: ToggleItem[];
    initialMarked: string[];
    minSelected?: number;
    /** ^s 时调用，返回后组件留在界面并显示「已保存」 */
    onSave?: (result: ToggleResult) => void | Promise<void>;
  },
): Promise<ToggleResult | undefined> {
  if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
    return undefined;
  }

  const result = await ctx.ui.custom<ToggleResult | null>(
    (tui: any, theme: any, keybindings: any, done: (value: ToggleResult | null) => void) =>
      new ToggleSelectorComponent(
        tui,
        params.items.map((item) => ({ ...item })),
        params.initialMarked,
        {
          title: params.title,
          subtitle: params.subtitle,
          hint: params.hint,
          countLabel: params.countLabel,
          minSelected: params.minSelected,
        },
        keybindings,
        theme,
        done,
        params.onSave,
      ),
    { blocked: { kind: "question", message: params.title } },
  );

  return result ?? undefined;
}
