# @liziy/plugin-manager

pi 插件管理器 —— 按来源（MCP 服务器 / 扩展 / 技能）一键关闭不需要的能力，节省上下文 token。

## 安装

```bash
pi install npm:@liziy/plugin-manager
```

重启 pi 或 `/reload` 生效。

## 使用

```bash
/plugins    # 打开管理界面勾选启用/禁用
```

底部状态栏显示 `🧩 已启用/总数`。TUI 下为批量勾选组件：

```
→ context7      [MCP] (3 工具, ~1.2K)  ✓
  github        [MCP] (12 工具, ~8.5K) ✓
  vim-mode      [扩展] ✗
  pdf           [技能] ✗
```

- **↑↓** 选择，输入关键词模糊搜索过滤，**enter** 切换勾选
- **ctrl+a** 全选 / **ctrl+x** 清空（有搜索词时只作用于过滤结果）
- **ctrl+s** 保存并留在界面继续调整，**esc** 退出
- 勾选的条目始终排在最上面；非 TUI 模式自动降级为循环单选

## 版本历史

- **0.4.1** — ctrl+s 实时保存并留在界面，修复异步保存后不刷新
- **0.4.0** — 改为勾选式批量管理，搜索过滤直达

## 许可

MIT