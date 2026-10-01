import path from "node:path";

import { default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";

/**
 * 文件管理的路径囚笼。
 *
 * 这套接口具备**上传与删除**能力，一旦路径校验被绕过就等于容器内任意文件读写，
 * 因此这里的实现必须比"看起来对"更严格。
 *
 * ⚠️ 核心陷阱：仅校验字符串前缀是**不够的**。
 *
 * 本项目在子进程权限模型上有过实测结论：`node --permission` 的路径检查是**词法的**，
 * 不解析符号链接 —— 授权根目录里任何已存在的符号链接都能到达根外目标。
 * 同一个陷阱在这里同样成立：如果根内有一个指向 `/etc` 的软链，只做前缀校验的
 * 实现会认为 `<root>/escape/passwd` 在根内。
 *
 * 因此每个路径都必须经过：
 *   1. 拒绝任何 `..` 路径段（显式失败，不依赖后续判断的边界正确性）
 *   2. 拼接并 resolve 成绝对路径
 *   3. 校验字符串前缀
 *   4. **realpath 解析符号链接后，再次校验**   ← 关键一步
 *
 * 第 4 步对"尚不存在"的目标（如上传落点）也要生效：做法是 realpath 最近的
 * **已存在祖先**，再把剩余段接回去。
 *
 * 磁盘访问一律经 NativeFs 门面（`npm run check` 的后端边界规则强制），
 * 这样跨平台路径策略与测试替换点都统一收敛在 `native-fs.ts` 一处。
 */
export class FileJail {
  private real_root_cache: string | null = null;

  public constructor(private readonly root: string) {}

  public get jail_root(): string {
    return this.root;
  }

  /** 解析并校验一个请求路径，返回可安全使用的绝对路径。 */
  public resolve(requested: unknown): string {
    if (typeof requested !== "string" || requested.trim() === "") {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "path_required" },
      });
    }

    // 1. 显式拒绝 `..`
    if (requested.split(/[/\\]+/u).includes("..")) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "path_traversal_rejected" },
      });
    }

    // 2. 支持根内绝对路径与以根为基准的相对路径两种入参
    const candidate = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(this.root, requested);

    // 3. 字符串前缀校验
    this.assert_inside(candidate, this.root, "path_outside_root");

    // 4. 解析符号链接后再次校验
    const real_candidate = realpath_nearest_existing(candidate);
    this.assert_inside(real_candidate, this.real_root(), "path_escapes_via_symlink");

    return candidate;
  }

  /** 校验待创建的子项名：只接受单层名称。 */
  public assert_safe_child_name(name: unknown): string {
    if (typeof name !== "string" || name.trim() === "") {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "name_required" },
      });
    }
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "name_invalid" },
      });
    }
    if (name.includes("\0")) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "name_invalid" },
      });
    }
    if (Buffer.byteLength(name, "utf8") > 255) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "name_too_long" },
      });
    }
    return name;
  }

  private assert_inside(target: string, base: string, reason: string): void {
    if (target === base || target.startsWith(base + path.sep)) {
      return;
    }
    throw new AppError("request.validation_failed", { public_details: { reason } });
  }

  private real_root(): string {
    if (this.real_root_cache === null) {
      try {
        this.real_root_cache = default_native_fs.real_path(this.root);
      } catch (error) {
        // 根不可用是配置错误：直接抛出，不退化成"看起来安全"
        throw new AppError("file.not_found", {
          cause: error,
          public_details: { reason: "jail_root_unavailable" },
        });
      }
    }
    return this.real_root_cache;
  }
}

/**
 * 解析符号链接，目标不存在也能工作。
 *
 * 逐级向上找到最近的**已存在**祖先并 realpath，再把剩余段拼回。
 * 这样上传落点这类尚不存在的路径也能拿到"解析后"的位置。
 */
function realpath_nearest_existing(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = default_native_fs.real_path(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 只有"不存在"才继续上溯；权限等其他错误必须抛出，
      // 否则可能把一个不可访问的真实越界路径判成安全。
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new AppError("request.validation_failed", {
          public_details: { reason: "path_unresolvable" },
        });
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
