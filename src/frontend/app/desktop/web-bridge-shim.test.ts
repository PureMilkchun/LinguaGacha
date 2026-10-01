import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { install_web_bridge_shim } from "./web-bridge-shim";

vi.mock("@frontend/app/desktop/desktop-api", () => ({ api_get: vi.fn() }));

const original_bridge = Object.getOwnPropertyDescriptor(window, "desktopApp");

beforeEach(() => {
  Reflect.deleteProperty(window, "desktopApp");
  vi.spyOn(window, "addEventListener").mockImplementation(() => undefined);
});

afterEach(() => {
  if (original_bridge) Object.defineProperty(window, "desktopApp", original_bridge);
  else Reflect.deleteProperty(window, "desktopApp");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("浏览器标题栏契约", () => {
  it("为应用菜单保留标题栏高度，不预留原生窗口按钮区域", () => {
    install_web_bridge_shim();
    expect(window.desktopApp.shell).toMatchObject({
      titleBarHeight: 40,
      usesTitleBarOverlay: false,
      titleBarControlSide: "none",
      titleBarSafeAreaStart: 0,
      titleBarSafeAreaEnd: 0,
    });
  });
});

describe("浏览器桥接的 UUID 兼容", () => {
  it("HTTP 环境缺少 randomUUID 时使用随机字节生成 v4 UUID", () => {
    const random_bytes = vi.fn((bytes: Uint8Array) => {
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues: random_bytes });
    install_web_bridge_shim();
    expect(crypto.randomUUID()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(random_bytes).toHaveBeenCalledOnce();
    expect(random_bytes.mock.calls[0]?.[0].byteLength).toBe(16);
  });

  it("已有原生 randomUUID 时保留原实现", () => {
    const native_uuid = vi.fn(() => "native UUID");
    vi.stubGlobal("crypto", { randomUUID: native_uuid });
    install_web_bridge_shim();
    expect(crypto.randomUUID).toBe(native_uuid);
  });

  it("已有 Electron 桥接时不安装浏览器 UUID 兼容", () => {
    Object.defineProperty(window, "desktopApp", { configurable: true, value: {} });
    const browser_crypto = { getRandomValues: vi.fn() };
    vi.stubGlobal("crypto", browser_crypto);
    install_web_bridge_shim();
    expect("randomUUID" in browser_crypto).toBe(false);
  });
});
