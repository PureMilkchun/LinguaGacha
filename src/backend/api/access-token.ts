import { timingSafeEqual } from "node:crypto";

import type { Context, Next } from "hono";

/**
 * 可选的共享令牌访问控制。
 *
 * 背景：这个后端在设计上是"只监听回环的单机服务"，公开 API **没有任何鉴权**，
 * 而它的能力边界包含任意路径读写与 Agent 子进程执行。一旦把监听地址放开到
 * 局域网或公网，等于把这些能力交给任何能访问该地址的人。
 *
 * 因此当部署方设置了访问令牌时，这里给 `/api/*` 加一道最小但有效的门：
 *
 *   1. 首次访问 `/?token=XXX`：校验通过后下发 HttpOnly Cookie，并 302 到去掉
 *      token 的同一 URL，避免令牌停留在地址栏与浏览器历史里。
 *   2. 之后所有同源请求（fetch 默认 credentials: same-origin，EventSource 同理）
 *      自动携带该 Cookie，**前端无需任何改动**。
 *   3. 非浏览器调用方可以改用 `Authorization: Bearer XXX`。
 *   4. `/api/health` 恒定放行——容器 HEALTHCHECK 在容器内裸调用它，拿不到 Cookie。
 *
 * 这只是访问门槛，不替代传输层加密：仍应配合 Cloudflare Access 或 VPN 使用。
 */

const ACCESS_COOKIE_NAME = "lg_access";
const HEALTH_PATH = "/api/health";
const BEARER_PREFIX = /^Bearer\s+/iu;

/** 构造令牌校验中间件；调用方只在确实配置了令牌时注册。 */
export function create_access_token_middleware(
  expected_token: string,
): (context: Context, next: Next) => Promise<Response | void> {
  return async (context, next) => {
    // 预检请求不带 Cookie，必须先放行，否则跨源请求会直接失败。
    if (context.req.method === "OPTIONS") {
      return next();
    }

    const request_url = new URL(context.req.url);

    // 首次带 token 访问：校验、下发 Cookie、把 token 从 URL 上摘掉。
    const provided = request_url.searchParams.get("token");
    if (provided !== null) {
      if (!matches_token(provided, expected_token)) {
        return context.text("Forbidden", 403);
      }
      request_url.searchParams.delete("token");
      const location = `${request_url.pathname}${request_url.search}`;
      return new Response(null, {
        headers: {
          Location: location,
          "Set-Cookie": build_access_cookie(expected_token),
        },
        status: 302,
      });
    }

    // 健康检查由容器内部裸调用，没有 Cookie 通道。
    if (request_url.pathname === HEALTH_PATH) {
      return next();
    }

    const cookie_token = read_cookie(context.req.header("cookie"), ACCESS_COOKIE_NAME);
    if (cookie_token !== null && matches_token(cookie_token, expected_token)) {
      return next();
    }

    const authorization = context.req.header("authorization") ?? "";
    if (authorization.length > 0) {
      const bearer_token = authorization.replace(BEARER_PREFIX, "");
      if (bearer_token !== authorization && matches_token(bearer_token, expected_token)) {
        return next();
      }
    }

    return context.text("Unauthorized", 401);
  };
}

/** 常量时间比较，避免通过响应时间逐字节猜测令牌。 */
function matches_token(candidate: string, expected: string): boolean {
  const candidate_bytes = Buffer.from(candidate, "utf8");
  const expected_bytes = Buffer.from(expected, "utf8");
  if (candidate_bytes.length !== expected_bytes.length) {
    return false;
  }
  return timingSafeEqual(candidate_bytes, expected_bytes);
}

/**
 * Cookie 只对同源请求生效。
 *
 * 不加 Secure 是因为局域网/纯 HTTP 部署下带 Secure 的 Cookie 会被浏览器丢弃；
 * 一旦经 Cloudflare Tunnel 用 HTTPS 暴露，应由外层再加 Secure。
 */
function build_access_cookie(token: string): string {
  return [
    `${ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000", // 30 天，避免每次打开都要重新带 token
  ].join("; ");
}

/** 从 Cookie 头里取单个键；缺失或空值返回 null。 */
function read_cookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === "") {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : decodeURIComponent(value);
  }
  return null;
}
