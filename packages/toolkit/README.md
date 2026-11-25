# @liziy/toolkit

自用精选插件合集。**本包收录的所有插件均基于社区原版开源插件针对 `pi` 定制精简（魔改）而成**，裁剪了跨客户端冗余代码、外围技能包及零散斜杠命令，统一收口至 `/toolkit` 管理启用状态与配置。

## 收录插件与原仓库地址

| 插件名称（标识） | 原插件包名 | 原仓库地址 | 同步基线与协议 | 定制改写要点 |
|---|---|---|---|---|
| Ponytail (`ponytail`) | `@dietrichgebert/ponytail` | https://github.com/DietrichGebert/ponytail | `v5.3.3` (`ebd8654`) · MIT | 改写为精简中文提示词，移除技能包、衍生命令、跨宿主兼容层及强制测试条款，仅保留三档等级选择 |
| Todo 面板 (`todo`) | `@juicesharp/rpiv-todo` | https://github.com/juicesharp/rpiv-pi | `7525a5d` · MIT | 移除 `rpiv-config` / `rpiv-i18n` 依赖与独立 `/todos` 命令，整合自动续跑与状态核查至 `/toolkit` |
| 提问对话框 (`question`) | `@juicesharp/rpiv-ask-user-question` | https://github.com/juicesharp/rpiv-pi | `7525a5d` · MIT | 移除 `rpiv-config` / `rpiv-i18n` 依赖，保留单选/多选/备注终端提问对话框与输入修复 |

## 安装

```bash
pi install npm:@liziy/toolkit
```

> 若此前单独安装过原版 `ponytail`、`@juicesharp/rpiv-todo` 或 `@juicesharp/rpiv-ask-user-question`，请先卸载避免同名工具与命令冲突。

本地开发安装可直接指定包目录路径，重启 `pi` 或执行 `/reload` 生效。

## 命令

| 命令 | 说明 |
|------|------|
| `/toolkit` | 打开主菜单：选择「启用」（批量勾选插件开关）或「配置」（设置插件等级与待办操作） |
| `/toolkit enable` | 直接进入「启用」批量勾选界面（空格/回车切换、`^a` 全选、`^x` 清空、`^s` 保存、`esc` 完成） |
| `/toolkit config` | 直接进入「配置」界面（调整 Ponytail 等级、管理 Todo 任务） |
| `/toolkit info` | 查看所有内置插件的当前状态、原仓库地址与同步基线版本 |
| `/toolkit ponytail <lite\|full\|ultra\|on\|off>` | 直接切换 Ponytail 等级或启停（支持参数补全） |
| `/toolkit todo [exec\|check\|list\|on\|off]` | 直接执行全部待办、检查状态标注、查看列表或启停 Todo 面板 |

### Ponytail 等级说明

- `lite`：按要求完成实现，结尾附一行更精简的替代方案
- `full`：默认等级，按极简阶梯与最少改动原则执行
- `ultra`：动手前先审视需求合理性，主动质疑并精简多余项

## 配置文件

所有子插件的开关与设置统一保存在 `~/.pi/agent/extensions/toolkit/config.json`，示例：

```json
{
  "version": 1,
  "plugins": {
    "ponytail": {
      "enabled": true,
      "settings": {
        "mode": "full"
      }
    },
    "todo": {
      "enabled": true
    },
    "question": {
      "enabled": true
    }
  }
}
```

## 许可

MIT（内置各子模块保留原仓库 MIT 协议与 `LICENSE` 文件）。
