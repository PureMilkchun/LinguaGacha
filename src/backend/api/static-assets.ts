import path from "node:path";

import type { Hono } from "hono";

import { default_native_fs } from "../../native/native-fs";

const API_PATH_PREFIX = "/api/"; // 未命中的 API 路径继续交给既有 catch-all，保持统一的 route_not_found 响应
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const INDEX_FILE_NAME = "index.html";

// 静态产物只包含构建输出，内容类型表固定覆盖渲染器实际会请求的后缀。
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": HTML_CONTENT_TYPE,
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** 移动端适配层的挂载配置；不传则本层完全不生效，行为与桌面一致。 */
export type MobileLayerOptions = {
  /** 适配层源文件目录（含 mobile.css 与 mobile.js）。 */
  root: string;
  /** 对外 URL 前缀，默认 `/__lg-mobile`。 */
  urlPrefix?: string;
};

const DEFAULT_MOBILE_PREFIX = "/__lg-mobile";
const MOBILE_FILES: Readonly<Record<string, string>> = {
  "mobile.css": "text/css; charset=utf-8",
  "mobile.js": "text/javascript; charset=utf-8",
};

/**
 * 把渲染器构建产物挂到 Gateway 上；服务器部署需要它，桌面部署不使用该入口。
 *
 * 只处理未被公开 API 路由命中的请求，因此不会遮蔽 `/api/*`。
 * 未命中磁盘文件的非 API GET 回退到 index.html，使前端路由可以深链接。
 *
 * 传入 `mobileLayer` 时额外做两件事（都在服务端完成，**前端源码零改动**）：
 *   1. 托管适配层的 css/js
 *   2. 在每个 HTML 响应里注入对应的 link/script
 *
 * 之所以选服务端注入而不是改前端的 index.html：注入点只有这一个文件，
 * 上游更新时几乎不会冲突；而改前端会在每次上游改 index.html 时产生 rebase 成本。
 */
export function register_static_assets(
  app: Hono,
  static_root: string,
  mobile_layer?: MobileLayerOptions,
): void {
  const resolved_root = path.resolve(static_root);
  const index_path = path.join(resolved_root, INDEX_FILE_NAME);
  const mobile = resolve_mobile_layer(mobile_layer);

  // 适配层资源先于 catch-all 注册，避免被 SPA 兜底吞掉
  if (mobile !== null) {
    for (const [file_name, content_type] of Object.entries(MOBILE_FILES)) {
      const file_path = path.join(mobile.root, file_name);
      app.get(`${mobile.url_prefix}/${file_name}`, async () => {
        const content = await read_file_or_null(file_path);
        if (content === null) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(content, {
          headers: {
            "Content-Type": content_type,
            // 适配层随镜像发布，但没有内容哈希，因此要求每次校验
            "Cache-Control": "no-cache",
          },
        });
      });
    }
  }

  app.get("*", async (context, next) => {
    const request_path = context.req.path;
    if (request_path.startsWith(API_PATH_PREFIX)) {
      // 公开路由已在前面注册；走到这里说明路径不存在，交回 catch-all 产生标准错误信封。
      await next();
      return;
    }

    const decoded_path = safe_decode_path(request_path);
    if (decoded_path === null) {
      await next();
      return;
    }

    const file_path = resolve_within_root(resolved_root, decoded_path);
    if (file_path === null) {
      await next();
      return;
    }

    const asset = await read_file_or_null(file_path);
    if (asset !== null) {
      // 只有 HTML 需要注入；其余资源原样返回
      if (file_path.endsWith(".html") && mobile !== null) {
        return html_response(inject_mobile_layer(decode_text(asset), mobile));
      }
      return new Response(asset, { headers: { "Content-Type": resolve_content_type(file_path) } });
    }

    // 目录或未知路径按 SPA 处理；缺少入口文件时交回 catch-all，避免返回空响应。
    const index = await read_file_or_null(index_path);
    if (index === null) {
      await next();
      return;
    }
    // 未启用适配层时原样返回字节，保持与不注入时逐字节一致
    if (mobile === null) {
      return new Response(index, { headers: { "Content-Type": HTML_CONTENT_TYPE } });
    }
    return html_response(inject_mobile_layer(decode_text(index), mobile));
  });
}

/** 归一化适配层配置；目录不存在时直接停用，避免注入出 404 资源。 */
function resolve_mobile_layer(options: MobileLayerOptions | undefined): {
  root: string;
  url_prefix: string;
} | null {
  if (options === undefined || options.root.trim() === "") {
    return null;
  }
  const prefix = (options.urlPrefix ?? DEFAULT_MOBILE_PREFIX).replace(/\/+$/u, "");
  return { root: path.resolve(options.root), url_prefix: prefix };
}

function html_response(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": HTML_CONTENT_TYPE,
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * 在 `</head>` 前注入适配层的样式与脚本。
 *
 * 脚本用同步 script（不是 module）：应用的包是 module，天然 defer，
 * 浏览器可视高度可在首屏布局前准备；导航状态由应用自身管理。
 */
function inject_mobile_layer(html: string, mobile: { url_prefix: string }): string {
  const tags =
    `<link rel="stylesheet" href="${mobile.url_prefix}/mobile.css">` +
    `<script src="${mobile.url_prefix}/mobile.js"></script>`;
  const head_end = html.indexOf("</head>");
  if (head_end < 0) {
    // 没有 head 的 HTML 不猜测结构，原样返回避免破坏页面
    return html;
  }
  return `${html.slice(0, head_end)}${tags}${html.slice(head_end)}`;
}

function decode_text(bytes: Uint8Array<ArrayBuffer>): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** 非法百分号转义按未命中处理，不做异常文本回显。 */
function safe_decode_path(request_path: string): string | null {
  try {
    return decodeURIComponent(request_path);
  } catch {
    return null;
  }
}

/** 解析并确认目标仍位于静态根内，阻止 `..` 与绝对路径逃逸。 */
function resolve_within_root(root: string, decoded_path: string): string | null {
  const relative = decoded_path.replace(/^\/+/u, "");
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }
  return candidate;
}

/** 只返回普通文件，目录与不可读路径都按未命中处理。 */
async function read_file_or_null(file_path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    if (!default_native_fs.stat(file_path).isFile()) {
      return null;
    }
    const bytes = default_native_fs.read_file(file_path);
    // 返回同一块内存上的 Uint8Array 视图：BodyInit 要求 ArrayBuffer 支撑的视图，
    // 而 NativeFs 给出的 Buffer 底层是 ArrayBufferLike，因此显式收窄并零拷贝复用。
    return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
}

/** 未知后缀按二进制流返回，避免把字体或图片误判为 HTML。 */
function resolve_content_type(file_path: string): string {
  return CONTENT_TYPES[path.extname(file_path).toLowerCase()] ?? "application/octet-stream";
}
