import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { randomBytes } from "node:crypto";

import { AppError } from "../../shared/error";
import { default_native_fs } from "../../native/native-fs";
import type { JsonValue } from "../../domain/json";
import { FileJail } from "./file-jail";
import { ok } from "./api-types";
// 只导入类型：api-routes.ts 会反过来导入本模块，运行时循环依赖必须避免。
import type { ApiRouteContext } from "./api-routes";

/**
 * 文件管理路由。
 *
 * 提供 LinguaGacha 原本没有的能力：在**服务端**浏览目录、上传源文件、整理文件。
 * 桌面端没有这组界面（它用系统文件对话框），因此这组路由只在服务器部署下有意义。
 *
 * 安全边界见 file-jail.ts —— 这里所有路径都必须先过囚笼。
 *
 * 磁盘访问一律经 NativeFs 门面（`npm run check` 的后端边界规则强制），
 * 不直接 import `node:fs`，这样跨平台长路径策略与测试替换点都收敛在一处。
 *
 * 上传刻意采用「单文件 + 原始字节流」而不是 multipart：
 *   - 不需要 multipart 解析器（少一个依赖、少一类漏洞）
 *   - 大文件不经过内存（epub/pdf 可能数百 MB）
 *   - 前端已有的 api_upload 就是发原始字节，两边天然对齐
 */

const TRASH_DIR_NAME = ".trash";
const UPLOAD_TEMP_PREFIX = ".upload-";
const META_FILE_NAME = "meta.json";
const TRASH_ITEM_NAME = "item";
const DEFAULT_MAX_UPLOAD_MB = 2048;

/** 囚笼根：默认 /data，与容器里挂载的小说目录一致。 */
function resolve_files_root(): string {
  const configured = process.env["LG_FILES_ROOT"];
  return path.resolve(
    configured === undefined || configured.trim() === "" ? "/data" : configured.trim(),
  );
}

function resolve_max_upload_bytes(): number {
  const raw = process.env["LG_MAX_UPLOAD_MB"];
  const megabytes = raw === undefined ? DEFAULT_MAX_UPLOAD_MB : Number.parseInt(raw, 10);
  return (
    (Number.isSafeInteger(megabytes) && megabytes > 0 ? megabytes : DEFAULT_MAX_UPLOAD_MB) *
    1024 *
    1024
  );
}

/** 读取状态；不存在或不可访问都返回 null，供"是否存在"这类判断使用。 */
function stat_or_null(target: string): ReturnType<typeof default_native_fs.stat> | null {
  try {
    return default_native_fs.stat(target);
  } catch {
    return null;
  }
}

export function register_file_routes(context: ApiRouteContext): void {
  const root = resolve_files_root();
  const jail = new FileJail(root);
  const trash_dir = path.join(root, TRASH_DIR_NAME);

  context.postJson("/api/files/roots", () => {
    return { root, trashDir: trash_dir } as unknown as JsonValue;
  });

  context.postJson("/api/files/list", (body) => {
    const target = jail.resolve(body["path"] ?? ".");
    const dirents = default_native_fs.read_dirents(target);

    const entries = [];
    for (const dirent of dirents) {
      // 隐藏项（含回收站）默认不展示，避免用户误操作
      if (dirent.name.startsWith(".") && body["includeHidden"] !== true) {
        continue;
      }
      const stats = stat_or_null(path.join(target, dirent.name));
      if (stats === null) {
        continue;
      }
      entries.push({
        name: dirent.name,
        kind: dirent.isDirectory() ? "dir" : dirent.isSymbolicLink() ? "link" : "file",
        size: dirent.isFile() ? stats.size : null,
        modifiedAt: stats.mtime.toISOString(),
      });
    }

    // 目录在前；同类按名称自然序（数字按数值比较，符合"第2卷 < 第10卷"的直觉）
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
    });

    const relative = path.relative(root, target);
    return {
      path: target,
      relativePath: relative === "" ? "." : relative,
      parent: target === root ? null : path.dirname(target),
      entries,
    } as unknown as JsonValue;
  });

  context.postJson("/api/files/mkdir", (body) => {
    const target = jail.resolve(body["path"]);
    jail.assert_safe_child_name(path.basename(target));

    if (stat_or_null(target) !== null) throw new AppError("file.already_exists");

    /*
     * NativeFs 的 make_dir 是递归语义，而这里刻意**只建一层**：
     * 因此先确认父目录已存在，否则报 parent_missing，不做静默的深目录创建。
     */
    const parent = path.dirname(target);
    if (parent !== target && stat_or_null(parent) === null) {
      throw new AppError("file.not_found", { public_details: { reason: "parent_missing" } });
    }

    default_native_fs.make_dir(target);
    return { path: target } as unknown as JsonValue;
  });

  context.postJson("/api/files/rename", (body) => {
    const from = jail.resolve(body["from"]);
    const to = jail.resolve(body["to"]);
    jail.assert_safe_child_name(path.basename(to));

    // 不覆盖已存在目标：静默丢数据比失败更糟
    if (stat_or_null(to) !== null) throw new AppError("file.already_exists");

    default_native_fs.rename(from, to);
    return { from, to } as unknown as JsonValue;
  });

  /** 删除 = 移入回收站。手机误触概率高，因此不提供直接删除。 */
  context.postJson("/api/files/delete", async (body) => {
    const requested = body["paths"];
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "paths_required" },
      });
    }

    const moved = [];
    for (const item of requested) {
      const target = jail.resolve(item);
      if (target === root) {
        throw new AppError("request.validation_failed", {
          public_details: { reason: "cannot_delete_root" },
        });
      }
      // 回收站自身不可再被删除，否则形成递归
      if (target === trash_dir || target.startsWith(trash_dir + path.sep)) {
        throw new AppError("request.validation_failed", {
          public_details: { reason: "trash_protected" },
        });
      }
      moved.push(await move_to_trash(target, trash_dir));
    }
    return { moved } as unknown as JsonValue;
  });

  context.postJson("/api/files/trash/list", async () => {
    default_native_fs.make_dir(trash_dir);
    const dirents = default_native_fs.read_dirents(trash_dir);
    const items = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const meta = await read_trash_meta(path.join(trash_dir, dirent.name));
      if (meta !== null) items.push(meta); // 搬运中断的残骸没有 meta，不展示
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return { items, trashDir: trash_dir } as unknown as JsonValue;
  });

  context.postJson("/api/files/trash/restore", async (body) => {
    const ids = body["ids"];
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "ids_required" },
      });
    }
    const restored: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const raw_id of ids) {
      const id = String(raw_id);
      try {
        const entry_dir = path.join(trash_dir, path.basename(id));
        const meta = await read_trash_meta(entry_dir);
        if (meta === null) {
          failed.push({ id, reason: "entry_missing" });
          continue;
        }
        // 恢复目标仍须在囚笼内（配置可能已变更）
        const target = jail.resolve(meta.originalPath);
        if (stat_or_null(target) !== null) {
          failed.push({ id, reason: "target_exists" });
          continue;
        }
        default_native_fs.make_dir(path.dirname(target));
        default_native_fs.rename(path.join(entry_dir, TRASH_ITEM_NAME), target);
        await default_native_fs.remove_async(entry_dir, { recursive: true, force: true });
        restored.push(meta.originalPath);
      } catch (error) {
        failed.push({ id, reason: error instanceof AppError ? error.code : "restore_failed" });
      }
    }
    return { restored, failed } as unknown as JsonValue;
  });

  /** 彻底删除：显式确认后才执行，不可恢复。 */
  context.postJson("/api/files/trash/purge", async (body) => {
    if (body["all"] === true) {
      await default_native_fs.remove_async(trash_dir, { recursive: true, force: true });
      default_native_fs.make_dir(trash_dir);
      return { purged: "all" } as unknown as JsonValue;
    }
    const ids = body["ids"];
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "ids_required" },
      });
    }
    const purged: string[] = [];
    for (const raw_id of ids) {
      // id 来自请求体，必须确认它只是目录名而不是路径
      const safe_id = path.basename(String(raw_id));
      if (safe_id !== String(raw_id) || safe_id === "." || safe_id === "..") continue;
      await default_native_fs.remove_async(path.join(trash_dir, safe_id), {
        recursive: true,
        force: true,
      });
      purged.push(safe_id);
    }
    return { purged } as unknown as JsonValue;
  });

  /* ── 字节流路由 ── */

  context.request("POST", "/api/files/upload", async (request) => {
    const url = new URL(request.url);
    const name = jail.assert_safe_child_name(url.searchParams.get("name"));
    const directory = jail.resolve(url.searchParams.get("path") ?? ".");
    const target = path.join(directory, name);
    jail.resolve(target);

    const overwrite = url.searchParams.get("overwrite") === "1";
    if (!overwrite && stat_or_null(target) !== null) throw new AppError("file.already_exists");

    const temporary = path.join(
      directory,
      `${UPLOAD_TEMP_PREFIX}${randomBytes(8).toString("hex")}.part`,
    );
    const limit = resolve_max_upload_bytes();
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limit) {
          callback(
            new AppError("file.io_failed", { public_details: { reason: "upload_too_large" } }),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      const source =
        request.body === null ? Readable.from([]) : Readable.fromWeb(request.body as never);
      await pipeline(source, limiter, default_native_fs.create_write_stream(temporary));
      default_native_fs.rename(temporary, target);
    } catch (error) {
      await default_native_fs.remove_async(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    const stats = default_native_fs.stat(target);
    return Response.json(ok({ path: target, name, size: stats.size } as unknown as JsonValue));
  });

  context.request("GET", "/api/files/download", (request) => {
    const url = new URL(request.url);
    const target = jail.resolve(url.searchParams.get("path"));
    const stats = default_native_fs.stat(target);
    if (!stats.isFile()) {
      throw new AppError("request.validation_failed", { public_details: { reason: "not_a_file" } });
    }
    const filename = path.basename(target);
    return new Response(
      Readable.toWeb(default_native_fs.create_read_stream(target)) as ReadableStream<Uint8Array>,
      {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stats.size),
          // filename* 用 UTF-8 编码，保证中文名在手机浏览器上不乱码
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      },
    );
  });
}

type TrashMeta = {
  id: string;
  originalPath: string;
  name: string;
  kind: "file" | "dir";
  size: number | null;
  deletedAt: string;
};

/** 递归求目录大小；失败返回 null，不影响删除主流程。 */
function measure(target: string): number | null {
  try {
    const stats = default_native_fs.stat(target);
    if (stats.isFile()) return stats.size;
    let total = 0;
    for (const entry of default_native_fs.read_dirents(target)) {
      total += measure(path.join(target, entry.name)) ?? 0;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * 把条目与元数据一起移入回收站。
 *
 * 每个条目一个目录，便于同时容纳文件与目录：
 *   <trash>/<id>/meta.json   原始路径、名称、类型、删除时间
 *   <trash>/<id>/item        被移入的实际内容
 */
async function move_to_trash(target: string, trash_dir: string): Promise<TrashMeta> {
  default_native_fs.make_dir(trash_dir);

  const now = new Date();
  const stamp =
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}` +
    `-${[now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join("")}`;
  const id = `${stamp}-${randomBytes(3).toString("hex")}`;

  const entry_dir = path.join(trash_dir, id);
  default_native_fs.make_dir(entry_dir);

  const stats = default_native_fs.lstat(target);
  const meta: TrashMeta = {
    id,
    originalPath: target,
    name: path.basename(target),
    kind: stats.isDirectory() ? "dir" : "file",
    size: measure(target),
    deletedAt: new Date().toISOString(),
  };

  // 先搬内容再写 meta：若搬运失败，条目目录里没有 meta，列表会忽略它
  default_native_fs.rename(target, path.join(entry_dir, TRASH_ITEM_NAME));
  await default_native_fs.write_file(
    path.join(entry_dir, META_FILE_NAME),
    JSON.stringify(meta, null, 2),
  );
  return meta;
}

/** 读取单个条目的元数据；损坏或缺 meta 的条目按不可用处理。 */
async function read_trash_meta(entry_dir: string): Promise<TrashMeta | null> {
  try {
    const raw = default_native_fs.read_text_file(path.join(entry_dir, META_FILE_NAME));
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["originalPath"] !== "string") return null;
    const name =
      typeof record["name"] === "string" ? record["name"] : path.basename(record["originalPath"]);
    return {
      id: record["id"],
      originalPath: record["originalPath"],
      name,
      kind: record["kind"] === "dir" ? "dir" : "file",
      size: typeof record["size"] === "number" ? record["size"] : null,
      deletedAt: typeof record["deletedAt"] === "string" ? record["deletedAt"] : "",
    };
  } catch {
    return null;
  }
}
