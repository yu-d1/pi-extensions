/**
 * 子插件注册表
 *
 * 新增自用插件只需 3 步：
 * 1. 在本目录下新建 `<插件名>.ts`，导出一个满足 `ToolkitPlugin` 协议的对象（必填 `upstream` 记录原仓库地址与同步版本）
 * 2. 在下方导入该插件并加入 `PLUGINS` 数组
 * 3. 在 `packages/toolkit/README.md` 的收录表中登记一行说明
 */
import type { ToolkitPlugin } from "../types.js";
import { askUserQuestionPlugin } from "./ask-user-question.js";
import { ponytailPlugin } from "./ponytail.js";
import { todoPlugin } from "./todo.js";

export const PLUGINS: ToolkitPlugin<any>[] = [
  ponytailPlugin,
  todoPlugin,
  askUserQuestionPlugin,
];
