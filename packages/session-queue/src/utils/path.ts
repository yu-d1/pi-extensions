import * as path from "node:path";

/**
 * Windows 文件系统不区分大小写，统一用小写 + path.normalize 作为比较 key。
 * 实际读写仍使用 original path。
 */
export function comparablePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? path.normalize(resolved).toLowerCase() : path.normalize(resolved);
}

export function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/**
 * 判断 target 是否位于 workspace 内（包含 workspace 本身）。
 * 使用 path.relative 边界判断，替换旧实现的“盘符首字母 + startsWith”。
 */
export function isInsideWorkspace(targetPath: string, workspace: string): boolean {
  const target = path.resolve(targetPath);
  const ws = path.resolve(workspace);
  const targetKey = comparablePath(target);
  const wsKey = comparablePath(ws);

  if (targetKey === wsKey) return true;
  const rel = path.relative(wsKey, targetKey);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * 把工具输入里的路径解析成绝对路径。
 * 相对路径基于 bash/edit 实际执行目录，而不是扩展进程的 process.cwd()。
 */
export function resolveWorkspacePath(raw: string, workspace: string, toolCwd?: string): string {
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const base = toolCwd && toolCwd.trim() ? path.resolve(toolCwd) : path.resolve(workspace);
  return path.resolve(base, raw);
}

/** 保证工作区路径以规范化绝对路径存储。 */
export function normalizeWorkspace(workspace: string): string {
  return path.resolve(workspace);
}
