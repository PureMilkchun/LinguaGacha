import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../shared/error";
import { FileJail } from "./file-jail";

/**
 * 路径囚笼的回归用例。
 *
 * 这是文件管理的安全边界：这套接口具备上传与删除能力，一旦路径校验被绕过
 * 就等于容器内任意文件读写。因此用例必须覆盖**攻击路径**，而不只是正常路径。
 *
 * 重点：符号链接逃逸。只做字符串前缀校验的实现会在这组用例上全部失败 ——
 * 根内一个指向根外的软链，前缀校验认为"在根内"，只有 realpath 才能发现。
 */

/** 建一个隔离沙箱：囚笼根 + 一个根外的"机密"目录。 */
function create_sandbox(): { sandbox: string; root: string; outside: string } {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "file-jail-"));
  const root = path.join(sandbox, "data");
  const outside = path.join(sandbox, "outside");
  fs.mkdirSync(path.join(root, "novels"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
  fs.writeFileSync(path.join(root, "novels", "book.epub"), "content");
  return { sandbox, root, outside };
}

/** 取出 AppError 的公开原因，用于断言"因何被拒"。 */
function reason_of(error: unknown): string | undefined {
  return error instanceof AppError
    ? (error.public_details as { reason?: string } | undefined)?.reason
    : undefined;
}

describe("FileJail", () => {
  let sandbox: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    ({ sandbox, root, outside } = create_sandbox());
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("解析根内相对路径与绝对路径", () => {
    const jail = new FileJail(root);
    expect(jail.resolve("novels/book.epub")).toBe(path.join(root, "novels", "book.epub"));
    expect(jail.resolve(path.join(root, "novels", "book.epub"))).toBe(
      path.join(root, "novels", "book.epub"),
    );
    expect(jail.resolve("novels")).toBe(path.join(root, "novels"));
    // 根本身可解析（列出根目录）
    expect(jail.resolve(root)).toBe(root);
  });

  it("拒绝 `..` 段，即使解析后仍在根内", () => {
    const jail = new FileJail(root);
    // 指向根内的 `..` 也拒绝：让越界意图立刻失败，不依赖后续判断的边界正确性
    expect(() => jail.resolve("novels/../novels/book.epub")).toThrow(AppError);
    expect(() => jail.resolve("../outside/secret.txt")).toThrow(AppError);
    expect(() => jail.resolve("..")).toThrow(AppError);
    // 原因码可区分：便于前端与日志判断这是攻击而非普通坏输入
    try {
      jail.resolve("../outside/secret.txt");
    } catch (error) {
      expect(reason_of(error)).toBe("path_traversal_rejected");
    }
  });

  it("拒绝根外的绝对路径", () => {
    const jail = new FileJail(root);
    expect(() => jail.resolve(path.join(outside, "secret.txt"))).toThrow(AppError);
    expect(() => jail.resolve("/etc/passwd")).toThrow(AppError);
    try {
      jail.resolve(path.join(outside, "secret.txt"));
    } catch (error) {
      expect(reason_of(error)).toBe("path_outside_root");
    }
  });

  it("拒绝符号链接逃逸：根内软链指向根外", () => {
    const jail = new FileJail(root);
    fs.symlinkSync(outside, path.join(root, "novels", "escape"));

    // 前缀校验会认为这是安全的（路径确实以 root 开头），只有 realpath 能发现问题
    expect(() => jail.resolve("novels/escape")).toThrow(AppError);
    expect(() => jail.resolve("novels/escape/secret.txt")).toThrow(AppError);
    try {
      jail.resolve("novels/escape/secret.txt");
    } catch (error) {
      expect(reason_of(error)).toBe("path_escapes_via_symlink");
    }
  });

  it("拒绝经由符号链接的「尚不存在」路径", () => {
    const jail = new FileJail(root);
    fs.symlinkSync(outside, path.join(root, "novels", "escape"));

    // 上传落点尚不存在：必须解析到最近的已存在祖先（软链）后仍能判定越界
    expect(() => jail.resolve("novels/escape/new-file.txt")).toThrow(AppError);
    try {
      jail.resolve("novels/escape/new-file.txt");
    } catch (error) {
      expect(reason_of(error)).toBe("path_escapes_via_symlink");
    }
  });

  it("允许指向根内的符号链接", () => {
    const jail = new FileJail(root);
    fs.symlinkSync(path.join(root, "novels"), path.join(root, "alias"));
    expect(jail.resolve("alias/book.epub")).toBe(path.join(root, "alias", "book.epub"));
  });

  it("允许尚不存在的路径，只要其祖先在根内", () => {
    const jail = new FileJail(root);
    expect(jail.resolve("novels/新书.epub")).toBe(path.join(root, "novels", "新书.epub"));
    expect(jail.resolve("新建目录/子目录")).toBe(path.join(root, "新建目录/子目录"));
  });

  it("空路径与非法类型一律拒绝", () => {
    const jail = new FileJail(root);
    expect(() => jail.resolve("")).toThrow(AppError);
    expect(() => jail.resolve("   ")).toThrow(AppError);
    expect(() => jail.resolve(null)).toThrow(AppError);
    expect(() => jail.resolve(undefined)).toThrow(AppError);
    expect(() => jail.resolve(42)).toThrow(AppError);
  });

  it("根不存在时明确失败，不退化成「看起来安全」", () => {
    const jail = new FileJail(path.join(sandbox, "does-not-exist"));
    expect(() => jail.resolve("x")).toThrow(AppError);
  });

  describe("子项名校验", () => {
    it("接受普通名称（含中文与空格）", () => {
      const jail = new FileJail(root);
      expect(jail.assert_safe_child_name("正常书名.epub")).toBe("正常书名.epub");
      expect(jail.assert_safe_child_name("My Book 第 2 卷.epub")).toBe("My Book 第 2 卷.epub");
    });

    it("拒绝路径分隔符与特殊名", () => {
      const jail = new FileJail(root);
      expect(() => jail.assert_safe_child_name("../evil")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name("a/b")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name("a\\b")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name("..")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name(".")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name("")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name("   ")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name("a\0b")).toThrow(AppError);
      expect(() => jail.assert_safe_child_name(null)).toThrow(AppError);
    });

    it("拒绝超过文件系统上限的名称", () => {
      const jail = new FileJail(root);
      expect(() => jail.assert_safe_child_name("x".repeat(300))).toThrow(AppError);
      // 按 UTF-8 字节数判断，因此多字节字符更早触限
      expect(() => jail.assert_safe_child_name("中".repeat(100))).toThrow(AppError);
    });
  });
});
