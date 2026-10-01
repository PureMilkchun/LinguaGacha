/**
 * LinguaGacha Docker 健康检查脚本。
 *
 * 容器内没有 curl / wget，因此用 Node 原生 http 模块探测 /api/health。
 *
 * 端口来源按优先级：
 *   1. LG_API_PORT —— 服务器部署固定端口时的直接来源
 *   2. /tmp/lg-port —— 服务器入口在 Gateway 就绪后写出的实际端口
 *
 * 两者都不可用时判定为不健康（启动尚未完成或布局错误）。
 */

import { readFileSync } from "node:fs";
import http from "node:http";

const PORT_FILE = "/tmp/lg-port";

const port = resolve_port();
if (port === null) {
  process.exit(1);
}

const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 3000 }, (res) => {
  process.exit(
    res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1,
  );
});

req.on("error", () => process.exit(1));
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});

/** 解析监听端口；固定端口优先，其次读取服务器写出的端口文件。 */
function resolve_port() {
  const configured = process.env["LG_API_PORT"];
  if (configured !== undefined && configured !== "") {
    const port = Number.parseInt(configured, 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  }

  try {
    const port = Number.parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}
