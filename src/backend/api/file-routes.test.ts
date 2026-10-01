import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolve_app_error_http_status } from "../../shared/error";
import { api_error_envelope, normalize_api_error } from "./api-error";
import { register_api_request, register_post_json_route } from "./api-request";
import type { ApiRouteContext } from "./api-routes";
import { register_file_routes } from "./file-routes";

/**
 * 文件管理的 HTTP 回归用例。
 *
 * 只装配被验证的路由本身（真实 Hono 应用 + 真实错误映射 + 真实路由助手），
 * 不拉整个 Gateway —— 文件路由不依赖 BackendServices，因此不需要那套重脚手架，
 * 但错误信封与状态码走的仍是生产路径。
 *
 * 用 `app.request()` 走真实请求边界（与 api-request.test.ts 一致），不起真实端口。
 */

type Harness = {
  app: Hono;
  root: string;
  sandbox: string;
  outside: string;
};

/** 每个用例一个隔离沙箱与一个只注册文件路由的 Hono 应用。 */
function create_harness(options: { max_upload_mb?: number } = {}): Harness {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "file-routes-"));
  const root = path.join(sandbox, "data");
  const outside = path.join(sandbox, "outside");
  fs.mkdirSync(path.join(root, "novels"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");

  // register_file_routes 在注册时读取环境，因此每个用例前重设
  process.env["LG_FILES_ROOT"] = root;
  if (options.max_upload_mb === undefined) {
    delete process.env["LG_MAX_UPLOAD_MB"];
  } else {
    process.env["LG_MAX_UPLOAD_MB"] = String(options.max_upload_mb);
  }

  const app = new Hono();
  const respond_error = (error: unknown, _route_path: string, _request_id: string): Response => {
    const normalized = normalize_api_error(error);
    return Response.json(api_error_envelope(normalized), {
      status: resolve_app_error_http_status(normalized),
    });
  };

  // 只提供文件路由需要的两个传输适配器，其余字段不参与本组用例
  const context = {
    app,
    postJson: (path_name: string, handler: never) =>
      register_post_json_route(app, path_name, handler, respond_error),
    request: (method: "GET" | "POST", path_name: string, handler: never) =>
      register_api_request(app, method, path_name, handler, respond_error),
  } as unknown as ApiRouteContext;

  register_file_routes(context);
  return { app, root, sandbox, outside };
}

/** 提交 JSON 命令并返回已解析的信封。 */
async function post(
  app: Hono,
  path_name: string,
  body: Record<string, unknown> = {},
): Promise<{
  status: number;
  ok: boolean;
  data: never;
  error: { code: string; details?: { reason?: string } };
}> {
  const response = await app.request(path_name, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as never as {
    ok: boolean;
    data: never;
    error: { code: string; details?: { reason?: string } };
  };
  return { status: response.status, ...payload };
}

/** 上传原始字节（与前端 api_upload 相同的形状）。 */
async function upload(app: Hono, query: string, bytes: Uint8Array): Promise<Response> {
  // app.request 在同步/异步两种实现间返回联合类型，这里统一收成 Promise
  return await app.request(`/api/files/upload?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    // Uint8Array 的底层缓冲区类型在 lib.dom 里被收窄，与 BodyInit 的期望不一致
    body: bytes as unknown as BodyInit,
  });
}

describe("文件管理路由", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = create_harness();
  });

  afterEach(() => {
    fs.rmSync(harness.sandbox, { recursive: true, force: true });
    delete process.env["LG_FILES_ROOT"];
    delete process.env["LG_MAX_UPLOAD_MB"];
  });

  describe("roots / list", () => {
    it("返回囚笼根与回收站位置", async () => {
      const result = await post(harness.app, "/api/files/roots");
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({
        root: harness.root,
        trashDir: path.join(harness.root, ".trash"),
      });
    });

    it("目录排在文件之前，同类按自然序", async () => {
      fs.mkdirSync(path.join(harness.root, "第10卷"));
      fs.mkdirSync(path.join(harness.root, "第2卷"));
      fs.writeFileSync(path.join(harness.root, "b.txt"), "b");
      fs.writeFileSync(path.join(harness.root, "a.txt"), "a");

      const result = await post(harness.app, "/api/files/list", { path: "novels" });
      expect(result.ok).toBe(true);
      // novels 为空目录
      expect(result.data).toMatchObject({ relativePath: "novels", entries: [] });

      const root_list = await post(harness.app, "/api/files/list", {});
      const entries = (
        root_list.data as unknown as { entries: Array<{ name: string; kind: string }> }
      ).entries;

      // 断言真正的意图，而不是写死全量列表（脚手架本身还会建一个 novels 目录）：
      // 1) 所有目录排在所有文件之前
      const last_dir = entries.findLastIndex((entry) => entry.kind === "dir");
      const first_file = entries.findIndex((entry) => entry.kind === "file");
      expect(last_dir).toBeLessThan(first_file);

      // 2) 数字按数值比较，第2卷 在第10卷 之前（而非字典序的第10卷在前）
      const dir_names = entries.filter((entry) => entry.kind === "dir").map((entry) => entry.name);
      expect(dir_names.indexOf("第2卷")).toBeLessThan(dir_names.indexOf("第10卷"));

      // 3) 文件按名称排序
      expect(entries.filter((entry) => entry.kind === "file").map((entry) => entry.name)).toEqual([
        "a.txt",
        "b.txt",
      ]);
    });

    it("默认不展示隐藏项（回收站），includeHidden 可显式列出", async () => {
      fs.mkdirSync(path.join(harness.root, ".trash"), { recursive: true });
      fs.mkdirSync(path.join(harness.root, ".hidden-dir"), { recursive: true });

      const read_names = async (body: Record<string, unknown>): Promise<string[]> => {
        const result = await post(harness.app, "/api/files/list", body);
        return (result.data as unknown as { entries: Array<{ name: string }> }).entries.map(
          (entry) => entry.name,
        );
      };

      const visible = await read_names({});
      expect(visible).not.toContain(".trash");
      expect(visible).not.toContain(".hidden-dir");

      const all = await read_names({ includeHidden: true });
      expect(all).toContain(".trash");
      expect(all).toContain(".hidden-dir");
    });
  });

  describe("mkdir", () => {
    it("创建一层目录", async () => {
      const result = await post(harness.app, "/api/files/mkdir", { path: "novels/新目录" });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(harness.root, "novels", "新目录"))).toBe(true);
    });

    it("目标已存在时报 already_exists", async () => {
      fs.mkdirSync(path.join(harness.root, "novels", "已有"));
      const result = await post(harness.app, "/api/files/mkdir", { path: "novels/已有" });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("file.already_exists");
      expect(result.status).toBe(409);
    });

    it("父目录缺失时报 parent_missing，不静默创建深目录", async () => {
      const result = await post(harness.app, "/api/files/mkdir", { path: "无父/子" });
      expect(result.ok).toBe(false);
      expect(result.error.details?.reason).toBe("parent_missing");
      // 关键：确认没有把中间层建出来
      expect(fs.existsSync(path.join(harness.root, "无父"))).toBe(false);
    });
  });

  describe("rename", () => {
    it("重命名文件", async () => {
      fs.writeFileSync(path.join(harness.root, "novels", "旧.txt"), "x");
      const result = await post(harness.app, "/api/files/rename", {
        from: "novels/旧.txt",
        to: "novels/新.txt",
      });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(harness.root, "novels", "新.txt"))).toBe(true);
      expect(fs.existsSync(path.join(harness.root, "novels", "旧.txt"))).toBe(false);
    });

    it("目标已存在时拒绝，不覆盖（静默丢数据比失败更糟）", async () => {
      fs.writeFileSync(path.join(harness.root, "novels", "a.txt"), "a");
      fs.writeFileSync(path.join(harness.root, "novels", "b.txt"), "b");
      const result = await post(harness.app, "/api/files/rename", {
        from: "novels/a.txt",
        to: "novels/b.txt",
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("file.already_exists");
      expect(fs.readFileSync(path.join(harness.root, "novels", "b.txt"), "utf8")).toBe("b");
    });
  });

  describe("上传与下载", () => {
    it("上传原始字节后能原样下载", async () => {
      const bytes = new Uint8Array(64 * 1024);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 256;

      const uploaded = await upload(harness.app, "path=novels&name=book.epub", bytes);
      expect(uploaded.status).toBe(200);
      expect(fs.readFileSync(path.join(harness.root, "novels", "book.epub"))).toEqual(
        Buffer.from(bytes),
      );

      const downloaded = await harness.app.request(
        `/api/files/download?path=${encodeURIComponent("novels/book.epub")}`,
      );
      expect(downloaded.status).toBe(200);
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    });

    it("上传设置 UTF-8 文件名回执，中文名不乱码", async () => {
      const response = await upload(
        harness.app,
        `path=novels&name=${encodeURIComponent("中文 名.epub")}`,
        new Uint8Array([1]),
      );
      expect(response.status).toBe(200);
      expect(fs.existsSync(path.join(harness.root, "novels", "中文 名.epub"))).toBe(true);
    });

    it("同名上传默认拒绝，overwrite=1 时覆盖", async () => {
      await upload(harness.app, "path=novels&name=a.txt", new Uint8Array([1]));
      const conflict = await upload(harness.app, "path=novels&name=a.txt", new Uint8Array([2]));
      expect(conflict.status).toBe(409);
      expect(fs.readFileSync(path.join(harness.root, "novels", "a.txt"))).toEqual(Buffer.from([1]));

      const overwritten = await upload(
        harness.app,
        "path=novels&name=a.txt&overwrite=1",
        new Uint8Array([2]),
      );
      expect(overwritten.status).toBe(200);
      expect(fs.readFileSync(path.join(harness.root, "novels", "a.txt"))).toEqual(Buffer.from([2]));
    });

    it("超出上限的上传被拒，且不留下临时文件", async () => {
      fs.rmSync(harness.sandbox, { recursive: true, force: true });
      harness = create_harness({ max_upload_mb: 1 });
      const too_large = new Uint8Array(1024 * 1024 + 10);
      const response = await upload(harness.app, "path=novels&name=big.bin", too_large);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(fs.existsSync(path.join(harness.root, "novels", "big.bin"))).toBe(false);
      // 临时文件必须被清理，否则失败上传会累积垃圾
      expect(fs.readdirSync(path.join(harness.root, "novels"))).toHaveLength(0);
    });

    it("文件名含路径分隔符被拒", async () => {
      const response = await upload(
        harness.app,
        `path=novels&name=${encodeURIComponent("../evil.txt")}`,
        new Uint8Array([1]),
      );
      expect(response.status).toBe(400);
      expect(fs.existsSync(path.join(harness.sandbox, "evil.txt"))).toBe(false);
    });

    it("下载目录被拒", async () => {
      const response = await harness.app.request(
        `/api/files/download?path=${encodeURIComponent("novels")}`,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("回收站", () => {
    it("删除是移入回收站，可恢复", async () => {
      fs.writeFileSync(path.join(harness.root, "novels", "gone.txt"), "x");

      const deleted = await post(harness.app, "/api/files/delete", { paths: ["novels/gone.txt"] });
      expect(deleted.ok).toBe(true);
      expect(fs.existsSync(path.join(harness.root, "novels", "gone.txt"))).toBe(false);

      const listed = await post(harness.app, "/api/files/trash/list");
      const items = (
        listed.data as unknown as {
          items: Array<{ id: string; name: string; kind: string; size: number | null }>;
        }
      ).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: "gone.txt", kind: "file", size: 1 });

      const restored = await post(harness.app, "/api/files/trash/restore", { ids: [items[0]!.id] });
      expect(restored.ok).toBe(true);
      expect(fs.readFileSync(path.join(harness.root, "novels", "gone.txt"), "utf8")).toBe("x");
      // 恢复后回收站条目应被清掉
      const after = await post(harness.app, "/api/files/trash/list");
      expect((after.data as unknown as { items: unknown[] }).items).toHaveLength(0);
    });

    it("目录整体进回收站并保留大小", async () => {
      fs.mkdirSync(path.join(harness.root, "novels", "整卷"));
      fs.writeFileSync(path.join(harness.root, "novels", "整卷", "a.txt"), "aaaa");
      const deleted = await post(harness.app, "/api/files/delete", { paths: ["novels/整卷"] });
      expect(deleted.ok).toBe(true);
      const listed = await post(harness.app, "/api/files/trash/list");
      const items = (
        listed.data as unknown as { items: Array<{ kind: string; size: number | null }> }
      ).items;
      expect(items[0]).toMatchObject({ kind: "dir", size: 4 });
    });

    it("原位置已被占用时恢复失败并给出原因，不覆盖", async () => {
      fs.writeFileSync(path.join(harness.root, "novels", "x.txt"), "old");
      await post(harness.app, "/api/files/delete", { paths: ["novels/x.txt"] });
      fs.writeFileSync(path.join(harness.root, "novels", "x.txt"), "new");

      const listed = await post(harness.app, "/api/files/trash/list");
      const id = (listed.data as unknown as { items: Array<{ id: string }> }).items[0]!.id;
      const restored = await post(harness.app, "/api/files/trash/restore", { ids: [id] });
      expect(restored.ok).toBe(true);
      expect(
        (restored.data as unknown as { failed: Array<{ reason: string }> }).failed[0]?.reason,
      ).toBe("target_exists");
      expect(fs.readFileSync(path.join(harness.root, "novels", "x.txt"), "utf8")).toBe("new");
    });

    it("彻底删除不可恢复", async () => {
      fs.writeFileSync(path.join(harness.root, "novels", "y.txt"), "y");
      await post(harness.app, "/api/files/delete", { paths: ["novels/y.txt"] });
      const listed = await post(harness.app, "/api/files/trash/list");
      const id = (listed.data as unknown as { items: Array<{ id: string }> }).items[0]!.id;

      const purged = await post(harness.app, "/api/files/trash/purge", { ids: [id] });
      expect(purged.ok).toBe(true);
      const after = await post(harness.app, "/api/files/trash/list");
      expect((after.data as unknown as { items: unknown[] }).items).toHaveLength(0);
    });

    it("清空回收站", async () => {
      fs.writeFileSync(path.join(harness.root, "novels", "z1.txt"), "1");
      fs.writeFileSync(path.join(harness.root, "novels", "z2.txt"), "2");
      await post(harness.app, "/api/files/delete", { paths: ["novels/z1.txt", "novels/z2.txt"] });
      const cleared = await post(harness.app, "/api/files/trash/purge", { all: true });
      expect(cleared.ok).toBe(true);
      const after = await post(harness.app, "/api/files/trash/list");
      expect((after.data as unknown as { items: unknown[] }).items).toHaveLength(0);
    });

    it("拒绝删除囚笼根与回收站自身", async () => {
      const root_delete = await post(harness.app, "/api/files/delete", { paths: [harness.root] });
      expect(root_delete.error.details?.reason).toBe("cannot_delete_root");

      const trash_delete = await post(harness.app, "/api/files/delete", {
        paths: [path.join(harness.root, ".trash")],
      });
      expect(trash_delete.error.details?.reason).toBe("trash_protected");
    });

    it("空 paths / ids 被拒", async () => {
      expect((await post(harness.app, "/api/files/delete", { paths: [] })).error.code).toBe(
        "request.validation_failed",
      );
      expect((await post(harness.app, "/api/files/trash/restore", { ids: [] })).error.code).toBe(
        "request.validation_failed",
      );
      expect((await post(harness.app, "/api/files/trash/purge", {})).error.code).toBe(
        "request.validation_failed",
      );
    });
  });

  describe("🔴 路径囚笼（HTTP 边界）", () => {
    it("相对的 `..` 越界被拒", async () => {
      const result = await post(harness.app, "/api/files/list", { path: "../../outside" });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result.error.details?.reason).toBe("path_traversal_rejected");
    });

    it("根外绝对路径被拒", async () => {
      const result = await post(harness.app, "/api/files/list", { path: harness.outside });
      expect(result.ok).toBe(false);
      expect(result.error.details?.reason).toBe("path_outside_root");

      const etc = await post(harness.app, "/api/files/list", { path: "/etc" });
      expect(etc.ok).toBe(false);
      expect(etc.error.details?.reason).toBe("path_outside_root");
    });

    it("根内软链指向根外时被拒（前缀校验会漏掉这条）", async () => {
      fs.symlinkSync(harness.outside, path.join(harness.root, "novels", "escape"));

      const directory = await post(harness.app, "/api/files/list", { path: "novels/escape" });
      expect(directory.ok).toBe(false);
      expect(directory.error.details?.reason).toBe("path_escapes_via_symlink");

      const through = await post(harness.app, "/api/files/list", {
        path: "novels/escape/secret.txt",
      });
      expect(through.ok).toBe(false);
      expect(through.error.details?.reason).toBe("path_escapes_via_symlink");

      // 下载同样必须被拦住
      const download = await harness.app.request(
        `/api/files/download?path=${encodeURIComponent("novels/escape/secret.txt")}`,
      );
      expect(download.status).toBeGreaterThanOrEqual(400);
      // 根外文件必须完好
      expect(fs.readFileSync(path.join(harness.outside, "secret.txt"), "utf8")).toBe("top secret");
    });

    it("经软链的上传落点同样被拒", async () => {
      fs.symlinkSync(harness.outside, path.join(harness.root, "novels", "escape"));
      const response = await upload(
        harness.app,
        "path=novels/escape&name=new.txt",
        new Uint8Array([1]),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(fs.existsSync(path.join(harness.outside, "new.txt"))).toBe(false);
    });
  });
});
