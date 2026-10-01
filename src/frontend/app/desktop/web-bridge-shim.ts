/**
 * Web Bridge Shim — 浏览器环境的 window.desktopApp 替代实现
 *
 * 在 Electron 桌面端, renderer 通过 preload 注入的 window.desktopApp 对象与原生宿主通信。
 * 当 LinguaGacha 以纯 Node + Hono 服务模式运行时, Gateway 同时托管静态前端产物与 /api,
 * 因此前端完全运行在浏览器中, 没有 Electron preload, 也没有 window.desktopApp。
 *
 * 本模块提供一个与 DesktopBridgeApi 类型严格一致的纯 Web 实现, 通过 install_web_bridge_shim()
 * 在 window.desktopApp 缺失时安装到全局, 实现零配置、零副作用的桥接。
 *
 * 设计约束:
 * - 仅在 window.desktopApp 未定义时安装, Electron 环境完全无影响
 * - baseUrl 使用 window.location.origin (同源: Gateway 同时提供静态文件与 API)
 * - 文件选择器通过 React 目录列表返回文件根内的服务端路径
 * - 更新相关方法返回不支持的结果, 服务器模式不提供应用自更新
 */

import type {
  DesktopBackendApiInfo,
  DesktopRendererDiagnosticsPayload,
  DesktopShellInfo,
  DesktopUpdateDownloadProgress,
  DesktopUpdateDownloadRequest,
  DesktopUpdateDownloadResult,
  DesktopUpdateLaunchRequest,
  DesktopUpdateLaunchResult,
  ResolvedThemeMode,
} from "@gui/bridge-types";
// DesktopBridgeApi 与全局名常量由 bridge-api 拥有；bridge-types 只承载载荷类型。
import { DESKTOP_BRIDGE_GLOBAL_NAME, type DesktopBridgeApi } from "@gui/bridge-api";
import { request_server_path_pick } from "./server-path-picker";
import { PROJECT_SOURCE_FORMATS } from "@shared/project-source-formats";
import { api_get } from "@frontend/app/desktop/desktop-api";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const LOG = "[web-bridge-shim]";
const BROWSER_TITLE_BAR_HEIGHT = 40;

/** 浏览器无法退出远程服务, quitApp 触发窗口关闭 (页面卸载)。 */
function browser_quit_app(): Promise<void> {
  window.close();
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Shim 实现
// ---------------------------------------------------------------------------

/**
 * 创建与 DesktopBridgeApi 接口严格一致的纯浏览器实现。
 *
 * 注意: 以下成员的语义在服务器模式下有所收窄,
 * 详见各方法注释。
 */
function create_web_bridge(): DesktopBridgeApi {
  /** 缓存从 /api/health 获取的版本号, 避免重复请求。 */
  let _cached_version: string | null = null;
  /** 该 getter 在渲染期被同步读取；用请求标记避免未解析前每次访问都发一次请求。 */
  let _version_requested = false;

  const shell: DesktopShellInfo = {
    /**
     * 浏览器运行在 Linux 容器中, 平台固定为 linux。
     * 原生 DesktopBridgeApi 中 platform 来自 Electron process.platform,
     * 这里从 user-agent 中解析, 无法解析时回退到 "linux"。
     */
    platform: ((): DesktopShellInfo["platform"] => {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes("win")) return "win32";
      if (ua.includes("mac")) return "darwin";
      if (ua.includes("linux")) return "linux";
      return "linux";
    })(),

    /** 浏览器没有原生 overlay 标题栏控制按钮。 */
    usesTitleBarOverlay: false,

    /**
     * titleBarHeight 控制应用标题栏及侧边栏的顶部偏移，与原生窗口按钮无关。
     * 浏览器也需要保留这一行，否则侧边栏和工作区会覆盖菜单按钮。
     */
    titleBarHeight: BROWSER_TITLE_BAR_HEIGHT,

    /**
     * 浏览器没有原生窗口控制按钮, 设为 "none"
     * 表示 renderer 不需要为左右侧按钮预留安全区。
     */
    titleBarControlSide: "none",

    /** 标题栏起始侧无安全区预留。 */
    titleBarSafeAreaStart: 0,

    /** 标题栏结束侧无安全区预留。 */
    titleBarSafeAreaEnd: 0,
  };

  const api: DesktopBridgeApi = {
    /**
     * appVersion: 从 /api/health 读取服务端版本号。
     * 首次访问时异步获取并缓存; 获取失败时使用占位值 "0.0.0"。
     *
     * 注意: 此属性在 DesktopBridgeApi 中声明为 readonly string,
     * renderer 在组件挂载期同步读取。由于异步获取存在时序问题,
     * 首次渲染可能短暂显示 "0.0.0", 随后更新为真实版本。
     * 若 renderer 依赖版本号做 UI 判断 (如显示更新提示),
     * 可能需要在首次渲染前 await 获取。
     */
    get appVersion(): string {
      if (_cached_version !== null) {
        return _cached_version;
      }

      if (_version_requested) {
        return "0.0.0";
      }
      _version_requested = true;

      // 异步获取版本号, 结果写入缓存并触发 React 重渲染。
      // 必须经 desktop-api 收口（架构检查强制），不能在这里直接 fetch。
      void api_get<{ version?: string }>("/api/health")
        .then((payload) => {
          const version = payload?.version;
          if (typeof version === "string" && version.trim() !== "") {
            _cached_version = version.trim();
            console.log(`${LOG} appVersion resolved: ${_cached_version}`);
          }
        })
        .catch((err: unknown) => {
          console.warn(`${LOG} failed to read /api/health for version:`, err);
        });

      return "0.0.0";
    },

    shell,

    /**
     * backendApi.baseUrl: 使用 window.location.origin (同源)。
     *
     * 原因: 服务器模式下 Gateway 同时托管静态前端产物 (dist/) 和 /api 路由,
     * 前端 JS 与 API 处于同一 origin。因此不需要额外配置, 直接使用浏览器地址栏的 origin 即可。
     *
     * normalize_backend_api_base_url() 只是 trim + 去尾斜杠,
     * window.location.origin 本身不含尾斜杠, 兼容性无问题。
     */
    backendApi: { baseUrl: window.location.origin, browser: true } as DesktopBackendApiInfo,

    /**
     * getPathForFile: Electron 用它从 File 对象获取本地绝对路径;
     * 浏览器无法获取文件的文件系统路径 (安全限制), 返回空字符串。
     *
     * 检查 renderer 调用点: src/frontend/app/desktop/file-drop-paths.ts
     * 该处调用后会判断路径有效性, 空字符串会导致拖拽功能降级但不会崩溃。
     */
    getPathForFile: (_file: File): string => {
      console.warn(
        `${LOG} getPathForFile is not available in browser mode, returning empty string`,
      );
      return "";
    },

    /**
     * setTitleBarTheme: 浏览器没有原生标题栏, 空实现。
     * renderer 在 appearance-provider.tsx 中调用, 不影响功能。
     */
    setTitleBarTheme: (_theme_mode: ResolvedThemeMode): void => {
      // no-op: 浏览器无原生标题栏
    },

    /**
     * requestUserAttention: 使用 Notification API 提醒用户,
     * 不支持时静默降级。
     */
    requestUserAttention: (): void => {
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("LinguaGacha", { body: "操作已完成" });
        } else if ("Notification" in window && Notification.permission !== "denied") {
          // 尝试请求权限 (部分浏览器可能阻止)
          void Notification.requestPermission();
        }
      } catch {
        // 静默降级: 部分浏览器可能不支持 Notification
      }
    },

    /**
     * quitApp: 浏览器无法退出远程服务, 调用 window.close() 关闭当前页面标签。
     * 这是浏览器环境下的最佳近似。
     */
    quitApp: browser_quit_app,

    /**
     * openLogWindow: 桌面端打开独立窗口渲染日志页。
     * 浏览器模式下改为应用内导航: 派发自定义事件, 由 App 层监听并切换路由。
     *
     * 实现方案: CustomEvent("lg:navigate")
     * AppContent 会在 useEffect 中监听此事件, 收到后 set_selected_route("xxx").
     * 若 App 层尚未注册监听器, 则降级为 window.open 打开同源日志页 URL。
     *
     * 日志页 URL: /?window=logs (见 src/frontend/app/index.tsx 的 is_log_window_mode())
     */
    openLogWindow: (): Promise<void> => {
      // 尝试应用内导航 (CustomEvent 由 App 层监听)
      const event = new CustomEvent("lg:navigate", {
        detail: { route: "logs" },
      });
      window.dispatchEvent(event);

      // 备用: 如果 App 层没有监听, 降级为打开新标签页
      // 注: 实际上 index.tsx 的 is_log_window_mode() 会识别 ?window=logs
      // 但这会启动新的 React 应用实例, 仅作为降级方案。
      // 主路径由 App 层的 CustomEvent 监听器处理。
      return Promise.resolve();
    },

    /**
     * onWindowCloseRequest: 主窗口关闭确认由 renderer 展示 UI。
     * 浏览器模式下没有"窗口关闭"概念, 返回 no-op unsubscribe。
     */
    onWindowCloseRequest: (_callback: () => void): (() => void) => {
      return () => {
        // no-op unsubscribe
      };
    },

    /**
     * reportRendererDiagnostics: 浏览器模式下刻意做成空实现。
     *
     * 这个通道在 Electron 里**不是日志出口**,而是喂给 main 进程的「崩溃黑匣子」——
     * 它的唯一用途是给原生进程崩溃日志补上最后的业务触发点
     * (见 renderer-error-reporter.ts: 「main 侧黑匣子只是进程级崩溃诊断增强」)。
     * 浏览器里没有这个黑匣子,因此正确做法是什么也不做。
     *
     * ⚠️ 不要把它接到 /api/diagnostics/renderer-error。
     * 那条路由吃的是**错误报告**(要求带 `error` 字段),而本通道传的是
     * **运行态面包屑**(只有 route/project/task)。接错的后果:
     * 每次路由或任务状态变化都会被后端记成一条
     * `unknown_renderer_error` 的 ERROR —— 页面本身没有任何异常,
     * 服务端日志却被刷满假错误。
     */
    reportRendererDiagnostics: (_payload: DesktopRendererDiagnosticsPayload): void => {
      // no-op: 浏览器没有进程级崩溃黑匣子;面包屑没有对应的落点。
    },

    /**
     * openExternalUrl: 在新标签页中打开外部链接, 添加 noopener 防止反向引用。
     */
    openExternalUrl: async (url: string): Promise<void> => {
      window.open(url, "_blank", "noopener");
    },

    /**
     * downloadUpdate: 服务器模式不提供应用自更新。
     * 返回 fallback_to_release_page, renderer 会打开发布页 URL。
     *
     * DesktopUpdateDownloadResult 类型有两种:
     * - { status: "downloaded", ... }
     * - { status: "fallback_to_release_page", release_url, reason }
     *
     * 选择返回 fallback, 原因标记为 "unsupported_platform"。
     */
    downloadUpdate: async (
      request: DesktopUpdateDownloadRequest,
      _on_progress: (progress: DesktopUpdateDownloadProgress) => void,
    ): Promise<DesktopUpdateDownloadResult> => {
      return {
        status: "fallback_to_release_page",
        release_url: request.release_url,
        reason: "unsupported_platform",
      };
    },

    /**
     * launchUpdate: 服务器模式不提供应用自更新。
     * 抛出明确错误, renderer 的 catch 分支会处理。
     */
    launchUpdate: async (
      _request: DesktopUpdateLaunchRequest,
    ): Promise<DesktopUpdateLaunchResult> => {
      throw new Error("Application updates are not supported in server mode");
    },

    // -----------------------------------------------------------------------
    // 浏览器使用同源文件根的目录列表；Electron 仍保留 preload 原生选择器。
    pickProjectSourceFilePath: () =>
      request_server_path_pick({
        mode: "files",
        multiple: true,
        extensions: PROJECT_SOURCE_FORMATS.map((format) => format.extension),
        initial_folder: "novels",
      }),
    pickProjectSourceDirectoryPath: () =>
      request_server_path_pick({ mode: "directory", initial_folder: "novels" }),
    pickProjectFilePath: () =>
      request_server_path_pick({ mode: "files", extensions: [".lg"], initial_folder: "projects" }),
    pickProjectSavePath: (default_name) =>
      request_server_path_pick({ mode: "save", default_name, initial_folder: "projects" }),
    pickWorkbenchFilePath: () =>
      request_server_path_pick({
        mode: "files",
        multiple: true,
        extensions: PROJECT_SOURCE_FORMATS.map((format) => format.extension),
        initial_folder: "novels",
      }),
    pickFixedProjectDirectory: (default_path) =>
      request_server_path_pick({
        mode: "directory",
        initial_folder: "projects",
        ...(default_path === undefined ? {} : { default_path }),
      }),
    pickGlossaryImportFilePath: () =>
      request_server_path_pick({ mode: "files", extensions: [".csv", ".xlsx", ".xls"] }),
    pickGlossaryExportPath: (default_name) =>
      request_server_path_pick({ mode: "save", default_name }),
    pickPromptImportFilePath: () => request_server_path_pick({ mode: "files" }),
    pickPromptExportFilePath: () =>
      request_server_path_pick({ mode: "save", default_name: "prompt.txt" }),
  };

  return api;
}

// ---------------------------------------------------------------------------
// 安装入口
// ---------------------------------------------------------------------------

/**
 * 在 window.desktopApp 缺失时安装浏览器桥接 shim。
 *
 * 调用时机: 在 src/frontend/index.tsx 的最顶部 (早于 React 渲染) 调用。
 *
 * - Electron 环境: window.desktopApp 已由 preload 注入, 此函数立即返回, 无副作用。
 * - 浏览器/服务器模式: 创建纯 Web 实现并挂载到 window, renderer 无感知切换。
 */
export function install_web_bridge_shim(): void {
  if (typeof window === "undefined") {
    return;
  }

  // 零配置: 仅在 window.desktopApp 不存在时安装
  if ((window as unknown as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL_NAME] !== undefined) {
    console.log(`${LOG} window.desktopApp already exists (Electron), skipping shim installation`);
    return;
  }

  install_browser_random_uuid();

  console.log(`${LOG} installing web bridge shim for browser/server mode`);

  const bridge = create_web_bridge();
  (window as unknown as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL_NAME] = bridge;

  // 同时挂载 App 内导航监听器 (openLogWindow 的应用内路由方案)
  install_app_navigation_listener();
}

/**
 * 局域网 HTTP 页面没有 Crypto.randomUUID；getRandomValues 仍可提供随机字节。
 * 在浏览器桥接启动时补齐 RFC 4122 v4 格式，供附件及其他渲染器 ID 使用。
 */
function install_browser_random_uuid(): void {
  if (typeof crypto.randomUUID === "function") return;

  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: (): ReturnType<Crypto["randomUUID"]> => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const version_mask = 0x40;
      const variant_mask = 0x80;
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | version_mask;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | variant_mask;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<
        Crypto["randomUUID"]
      >;
    },
  });
}

// ---------------------------------------------------------------------------
// App 内导航: openLogWindow 的应用内路由方案
// ---------------------------------------------------------------------------

/**
 * 监听 lg:navigate CustomEvent, 由 App 层的 AppContent 处理路由跳转。
 *
 * 在 shim 安装时同步注册监听器。由于 React 组件挂载时才会注册对应的
 * useEffect 监听, 这里先将事件暂存, 等 React 就绪后由 AppContent 消费。
 *
 * 最小侵入方案: 在 index.tsx 中, shim 导入后, App 组件的 useEffect
 * 会监听 "lg:navigate" 事件并调用 set_selected_route。
 *
 * 实际路由跳转逻辑由 AppContent (src/frontend/app/index.tsx) 实现,
 * 这里只负责事件派发的接收和日志。
 */
function install_app_navigation_listener(): void {
  window.addEventListener("lg:navigate", ((event: CustomEvent) => {
    const route = event.detail?.route;
    if (typeof route === "string") {
      console.log(`${LOG} lg:navigate received, route: ${route}`);
      // 事件已派发, 等待 AppContent 中的 useEffect 消费
    }
  }) as EventListener);
}
