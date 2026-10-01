import { AppError } from "../shared/error";
import type { AgentImageHost } from "../shared/agent-image";
import type { SystemProxyResolver } from "../backend/network/system-proxy-http-client";

/**
 * 服务器部署的宿主能力桩集合。
 *
 * 桌面宿主用 Electron 主进程实现这些端口（原生对话框、打开目录、Chromium 图片
 * 与打印宿主、系统代理规则）。纯 Node 服务器没有这些能力，因此这里显式提供
 * 语义明确的替代实现，而不是把 Electron 依赖偷偷带进后端。
 *
 * 目标场景是纯小说文本翻译，因此图片与 PDF 相关能力按“缺失”处理：
 * 调用方（Agent 图片附件、PDF 打印）会得到稳定错误码，而不是静默错误结果。
 */

/** 小说文本场景不处理图片附件，命中即返回稳定能力缺失错误。 */
export function create_unsupported_image_host(): AgentImageHost {
  return async () => {
    throw new AppError("runtime.capability_missing", {
      diagnostic_context: { reason: "server_image_host_unavailable" },
    });
  };
}

/**
 * 纯 Node 不读取系统代理规则。
 *
 * Electron 的 session.resolveProxy 是系统代理的唯一来源；服务器部署改用容器
 * 环境自己的网络策略，因此固定返回直连，由上层 transport 按 DIRECT 处理。
 */
export function create_direct_proxy_resolver(): SystemProxyResolver {
  return {
    resolveProxy: async () => "DIRECT",
  };
}

/** 服务器没有“打开输出目录”的原生副作用，导出后不执行任何界面动作。 */
export async function noop_open_directory(_path: string): Promise<void> {
  // 服务器部署没有桌面 shell；导出产物已经落盘，打开目录没有对应动作。
}

/** 服务器没有原生保存对话框；返回 null 表示用户取消，调用方沿用既有取消分支。 */
export async function cancelled_pick_save_path(_defaultName: string): Promise<string | null> {
  return null;
}
