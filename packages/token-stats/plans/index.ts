/**
 * 内置套餐清单 —— 菜单显示顺序即此顺序。
 * 各套餐实现拆在同目录独立文件，新增套餐只需加一个文件并挂到这里。
 */

import type { TokenPlan } from "./shared";
import { minimaxPlan } from "./minimax";
import { glmPlan } from "./glm";
import { kimiPlan } from "./kimi";
import { deepseekPlan } from "./deepseek";
import { mimoPlan } from "./mimo";

export const BUILTIN_PLANS: TokenPlan[] = [minimaxPlan, glmPlan, kimiPlan, deepseekPlan, mimoPlan];

export { checkLoginPlanPrereq, mimoLog, bindMimoFeedback, resetMimoLoginBackoff } from "./mimo";
export type { PlanFormatContext, QuotaStyle, TokenPlan } from "./shared";
