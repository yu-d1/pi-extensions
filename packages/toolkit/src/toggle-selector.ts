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

// ── 启用勾选组件（复用自 ssh-manager）──────────────
// 搜索框 + 可滚动列表 + 快捷键行。
// ↑↓ 移动、空格/回车切换勾选、^a 全选、^x 清空、^s 保存、esc 完成。

export interface ToggleItem {
  id: string;
  /** 主文本，参与模糊搜索 */
  label: string;
  /** 右侧状态徽标 */
  badge?: string;
  /** 附加说明，仅在选中行下方显示 */
  detail?: string;
}

interface ToggleOptions {
  title: string;
  subtitle: string;
  countLabel: string;
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
  private readonly done: (result: string[] | null) => void;
  private readonly onSave?: (selected: string[]) => void | Promise<void>;

  constructor(
    tui: any,
    items: ToggleItem[],
    initialMarked: string[],
    options: ToggleOptions,
    keybindings: any,
    theme: any,
    done: (result: string[] | null) => void,
    onSave?: (selected: string[]) => void | Promise<void>,
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

    this.searchInput = new Input({ placeholder: "搜索插件…" });
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

  /** 已勾选条目排在上方，未勾选条目保持原有顺序 */
  private buildItems(): ToggleItem[] {
    const marked = new Set(this.markedIds);
    return [
      ...this.allItems.filter((item) => marked.has(item.id)),
      ...this.allItems.filter((item) => !marked.has(item.id)),
    ];
  }

  private refresh(): void {
    const query = this.searchInput.getValue().trim();
    const base = this.buildItems();
    this.filtered = query ? fuzzyFilter(base, query, (item) => item.label) : base;
    if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    }
    this.updateList();
    this.updateFooter();
    this.tui?.requestRender?.();
  }

  private updateList(): void {
    this.listContainer.clear();
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  没有匹配的插件"), 0, 0));
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

  private updateFooter(): void {
    const parts = [
      `${this.keyLabel("tui.select.confirm") || "空格"} 切换`,
      `${this.keyLabel("app.models.enableAll") || "^a"} 全选`,
      `${this.keyLabel("app.models.clearAll") || "^x"} 清空`,
      `${this.keyLabel("app.models.save") || "^s"} 保存`,
      this.discardArmed ? "esc 再按一次放弃修改" : "esc 完成",
      `${this.options.countLabel} ${this.markedIds.length}/${this.allItems.length}`,
    ];
    const text = `  ${parts.join(" · ")}${this.saveNote ? ` · ${this.saveNote}` : ""}`;
    this.footerText.setText(
      this.isDirty
        ? this.theme.fg("dim", text) + this.theme.fg("warning", " （未保存）")
        : this.theme.fg("dim", text),
    );
  }

  /** ^s：保存但不关闭界面，可继续调整 */
  private triggerSave(): void {
    if (this.saving) return;
    const selected = [...this.markedIds];

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
      .then(() => this.onSave!(selected))
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
  private handleEscape(): void {
    if (this.saving) return;

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
      this.done(null);
      return;
    }

    this.done([...this.markedIds]);
  }

  private toggle(item: ToggleItem): void {
    const index = this.markedIds.indexOf(item.id);
    if (index >= 0) {
      this.markedIds.splice(index, 1);
    } else {
      this.markedIds.push(item.id);
    }
    this.isDirty = true;
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
      const item = this.filtered[this.selectedIndex];
      if (item) {
        this.toggle(item);
        this.refresh();
      }
      return;
    }

    if (kb?.matches?.(data, "app.models.enableAll")) {
      const targets = this.searchInput.getValue()
        ? this.filtered.map((item) => item.id)
        : this.allItems.map((item) => item.id);
      for (const id of targets) {
        if (!this.markedIds.includes(id)) this.markedIds.push(id);
      }
      this.isDirty = true;
      this.refresh();
      return;
    }

    if (kb?.matches?.(data, "app.models.clearAll")) {
      if (this.searchInput.getValue()) {
        const targets = new Set(this.filtered.map((item) => item.id));
        this.markedIds = this.markedIds.filter((id) => !targets.has(id));
      } else {
        this.markedIds = [];
      }
      this.isDirty = true;
      this.refresh();
      return;
    }

    if (kb?.matches?.(data, "app.models.save")) {
      this.triggerSave();
      return;
    }

    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      this.handleEscape();
      return;
    }

    if (this.discardArmed) {
      this.discardArmed = false;
      this.saveNote = "";
    }

    this.searchInput.handleInput(data);
    this.refresh();
  }
}

/**
 * 以模型选择器风格的界面批量管理插件启用状态。
 *
 * 交互：空格/回车切换、^a 全选、^x 清空、^s 保存但留在界面、esc 完成（有未保存修改时需再按一次放弃）。
 * 放弃未保存修改或非 TUI 环境返回 undefined。
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
    onSave?: (selected: string[]) => void | Promise<void>;
  },
): Promise<string[] | undefined> {
  if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
    return undefined;
  }

  const result = await ctx.ui.custom<string[] | null>(
    (tui: any, theme: any, keybindings: any, done: (value: string[] | null) => void) =>
      new ToggleSelectorComponent(
        tui,
        params.items.map((item) => ({ ...item })),
        params.initialMarked,
        {
          title: params.title,
          subtitle: params.subtitle,
          hint: params.hint,
          countLabel: params.countLabel,
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
