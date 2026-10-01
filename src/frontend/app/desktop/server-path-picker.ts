import type { DesktopPathPickResult } from "@gui/bridge-types";

export type ServerPathPickOptions = Readonly<{
  mode: "files" | "directory" | "save";
  multiple?: boolean;
  extensions?: readonly string[];
  initial_folder?: "novels" | "projects";
  default_name?: string;
  default_path?: string;
}>;
export type ServerPathPickRequest = Readonly<{ id: number; options: ServerPathPickOptions }>;

let pending: ServerPathPickRequest | null = null;
let resolve_pending: ((result: DesktopPathPickResult) => void) | null = null;
let next_id = 0;
const listeners = new Set<() => void>();
const CANCELED: DesktopPathPickResult = { canceled: true, paths: [] };

export function get_server_path_pick(): ServerPathPickRequest | null {
  return pending;
}
export function subscribe_server_path_pick(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 桥接只提出选择请求；React 宿主负责列表与交互，结果仍是服务端路径。 */
export function request_server_path_pick(
  options: ServerPathPickOptions,
): Promise<DesktopPathPickResult> {
  resolve_pending?.(CANCELED);
  return new Promise((resolve) => {
    pending = { id: ++next_id, options };
    resolve_pending = resolve;
    listeners.forEach((listener) => listener());
  });
}

/** 旧弹窗异步返回时不能结束后发起的请求。 */
export function finish_server_path_pick(id: number, result: DesktopPathPickResult): void {
  if (pending?.id !== id) return;
  const resolve = resolve_pending;
  pending = null;
  resolve_pending = null;
  listeners.forEach((listener) => listener());
  resolve?.(result);
}
