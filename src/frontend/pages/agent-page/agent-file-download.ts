import { api_file_url } from "@frontend/app/desktop/desktop-api";

/** 文件路径仍由服务端按当前会话解析，URL 只承载参数，不拼接宿主磁盘地址。 */
export function agent_file_download_url(path: string, session_id: string): string {
  const query = new URLSearchParams({ path, sessionId: session_id });
  return api_file_url(`/api/agent/workspace/download?${query}`);
}

/** 同源 attachment 响应流交给浏览器，避免先把整个成果文件读进内存。 */
export function download_agent_file(path: string, session_id: string): void {
  const link = document.createElement("a");
  link.href = agent_file_download_url(path, session_id);
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}
