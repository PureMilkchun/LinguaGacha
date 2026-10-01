import fs from "node:fs";
import path from "node:path";

import { GuiBackendBootstrap } from "../backend/bootstrap/gui-backend-bootstrap";
import {
  build_worker_threads_backend_worker_execution_from_desktop_bundle_dir,
  resolve_desktop_bundle_dir_from_module_url,
} from "../backend/worker/worker-execution";
import {
  cancelled_pick_save_path,
  create_direct_proxy_resolver,
  create_unsupported_image_host,
  noop_open_directory,
} from "./host-ports";

/**
 * 纯 Node 服务器入口。
 *
 * 与桌面入口的区别只有宿主能力来源：这里用 host-ports.ts 的桩替代 Electron
 * 主进程，其余装配完全复用 GuiBackendBootstrap，因此 Agent、SSE 与 Gateway
 * 的行为与桌面版一致。
 *
 * 该入口不能复用 `src/cli/cli-runner.ts`：后者从 electron 取
 * `app.getAppPath()` 与 `process.resourcesPath`，在纯 Node 下不可用。
 */

void run_server_entry().catch((error: unknown) => {
  // 启动失败必须让容器日志直接可读，而不是留下未处理拒绝的裸堆栈。
  write_stderr(`[server] startup failed: ${describe_error(error)}`);
  process.exit(1);
});

/** 组装并驻留完整后端；收到终止信号时按共享生命周期逆序释放。 */
async function run_server_entry(): Promise<void> {
  const bundle_dir = resolve_desktop_bundle_dir_from_module_url(import.meta.url);
  // 目录布局：app_root 下同时放置 builtin、workspace、dist 与 dist-electron 产物。
  const app_root = resolve_env_path("LG_APP_ROOT", path.resolve(bundle_dir, ".."));
  const builtin_root = resolve_env_path("LG_BUILTIN_ROOT", path.join(app_root, "builtin"));
  const workspace_runtime_directory = resolve_env_path(
    "LG_WORKSPACE_DIR",
    path.join(app_root, "workspace"),
  );
  const static_root = resolve_static_root(app_root);
  const mobile_layer_root = resolve_mobile_layer_root(app_root);
  const api_port = resolve_env_port("LG_API_PORT");
  const api_host = resolve_env_string("LG_API_HOST");
  const access_token = resolve_env_string("LG_ACCESS_TOKEN");

  const bootstrap = new GuiBackendBootstrap({
    imageHost: create_unsupported_image_host(),
    systemProxyResolver: create_direct_proxy_resolver(),
    openDirectory: noop_open_directory,
    pickSavePath: cancelled_pick_save_path,
    appRoot: app_root,
    builtinRoot: builtin_root,
    workspaceRuntimeDirectory: workspace_runtime_directory,
    logTargets: { console: true, window: false },
    workerExecution:
      build_worker_threads_backend_worker_execution_from_desktop_bundle_dir(bundle_dir),
    ...(static_root === null ? {} : { staticRoot: static_root }),
    ...(mobile_layer_root === null ? {} : { mobileLayerRoot: mobile_layer_root }),
    ...(api_port === null ? {} : { apiPort: api_port }),
    ...(api_host === null ? {} : { apiHost: api_host }),
    ...(access_token === null ? {} : { accessToken: access_token }),
  });

  write_stdout(`[server] appRoot=${app_root}`);
  write_stdout(`[server] builtinRoot=${builtin_root}`);
  write_stdout(`[server] workspaceRuntimeDirectory=${workspace_runtime_directory}`);
  write_stdout(`[server] staticRoot=${static_root ?? "(disabled)"}`);
  write_stdout(`[server] listenHost=${api_host ?? "127.0.0.1 (loopback only)"}`);
  write_stdout(`[server] accessToken=${access_token === null ? "disabled (no auth)" : "enabled"}`);

  // AppMetadataService.read_version() 是严格读取，缺失 version.txt 会在深层抛出
  // 难以定位的 ENOENT；入口先给出明确的布局错误。
  require_path(path.join(app_root, "version.txt"), "version.txt");
  require_path(builtin_root, "builtinRoot");

  install_shutdown_handlers(bootstrap);

  const started = await bootstrap.start();
  write_stdout(`[server] ready ${started.apiBaseUrl}`);
  write_stdout(`[server] health ${started.apiBaseUrl}/api/health`);

  // Gateway 绑定 port: 0，端口对容器编排不可预知。把端口写出来后，健康检查
  // 无需解析 stdout，也就不需要包一层 shell 入口（信号语义随之保持 exec 语义）。
  const port_file = process.env["LG_PORT_FILE"];
  if (port_file !== undefined && port_file !== "") {
    const port = new URL(started.apiBaseUrl).port;
    fs.writeFileSync(path.resolve(port_file), `${port}\n`, "utf8");
    write_stdout(`[server] port file ${port_file} -> ${port}`);
  }
}

/** 只有静态产物实际存在时才托管，避免把未构建的开发态误判为可用入口。 */
/**
 * 解析移动端适配层目录。
 *
 * 默认指向随镜像一起发布的 `builtin/mobile-layer`；目录不存在时返回 null，
 * 因此旧镜像或未打包该目录时行为与不加适配层完全一致。
 */
function resolve_mobile_layer_root(app_root: string): string | null {
  const configured = process.env["LG_MOBILE_LAYER_ROOT"];
  const candidate =
    configured === undefined || configured.trim() === ""
      ? path.join(app_root, "builtin", "mobile-layer")
      : configured.trim();
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function resolve_static_root(app_root: string): string | null {
  const configured = process.env["LG_STATIC_ROOT"];
  if (configured !== undefined && configured !== "") {
    return path.resolve(configured);
  }
  const candidate = path.join(app_root, "dist");
  return fs.existsSync(path.join(candidate, "index.html")) ? candidate : null;
}

/**
 * 启动前把目录布局错误暴露成可读信息。
 *
 * 桌面版由 Electron 保证这些路径存在；容器里它们来自镜像布局与卷挂载，
 * 出错时应当立刻说明缺了什么，而不是让调用方在几百行之后收到 ENOENT。
 */
function require_path(target: string, label: string): void {
  if (!fs.existsSync(target)) {
    throw new Error(
      `[server] required path missing: ${label} -> ${target} (check LG_APP_ROOT / LG_BUILTIN_ROOT and image layout)`,
    );
  }
}

/** 相对路径按进程工作目录解析（Node 惯例）；容器内建议始终传绝对路径。 */
function resolve_env_path(name: string, fallback: string): string {
  const value = process.env[name];
  return path.resolve(value === undefined || value === "" ? fallback : value);
}

/** 读取可选的非空环境变量；空字符串按未设置处理。 */
function resolve_env_string(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

/**
 * 解析固定监听端口。
 *
 * 桌面部署依赖 Gateway 随机分配端口（port: 0）；服务器部署必须固定端口，
 * 否则容器外的 tunnel ingress 规则无法知道该把公网域名指向哪个端口。
 * 缺省返回 null，保持随机端口行为不变。
 */
function resolve_env_port(name: string): number | null {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return null;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[server] ${name} must be an integer between 1 and 65535, got: ${value}`);
  }
  return port;
}

/** 终止信号复用同一 stop 路径，重复信号直接忽略。 */
function install_shutdown_handlers(bootstrap: GuiBackendBootstrap): void {
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    write_stdout(`[server] ${signal} received, shutting down`);
    void bootstrap
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        write_stderr(`[server] shutdown failed: ${describe_error(error)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

/** 入口失败必须留下可见原因，否则容器只会看到静默退出。 */
function describe_error(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

/** 直接写 fd，避免日志系统尚未就绪时丢失入口事实。 */
function write_stdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 入口错误走 stderr，与普通诊断日志分离。 */
function write_stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}
