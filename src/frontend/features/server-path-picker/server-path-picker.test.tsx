import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerPathPickerHost } from "./server-path-picker";
import {
  finish_server_path_pick,
  get_server_path_pick,
  request_server_path_pick,
  type ServerPathPickOptions,
} from "@frontend/app/desktop/server-path-picker";

vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@frontend/widgets/app-page-dialog", () => ({
  AppPageDialog: (props: {
    children: import("react").ReactNode;
    footer: import("react").ReactNode;
  }) => (
    <div>
      {props.children}
      {props.footer}
    </div>
  ),
}));
vi.mock("@frontend/app/desktop/desktop-api", () => ({
  api_fetch: async (route: string, body: { path?: string }) =>
    route.endsWith("roots")
      ? { root: "/data" }
      : {
          path: body.path,
          parent: body.path === "/data" ? null : "/data",
          entries:
            body.path === "/data"
              ? [
                  { name: "novels", kind: "dir" },
                  { name: "book.lg", kind: "file" },
                  { name: "chapter,1.txt", kind: "file" },
                  { name: "chapter2.txt", kind: "file" },
                  { name: "escape", kind: "link" },
                ]
              : [{ name: "inner.txt", kind: "file" }],
        },
}));
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    const pending = get_server_path_pick();
    if (pending) finish_server_path_pick(pending.id, { canceled: true, paths: [] });
  });
  container?.remove();
  root = null;
  container = null;
});
async function mount(options: ServerPathPickOptions) {
  const result = request_server_path_pick(options);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ServerPathPickerHost />);
  });
  return { result };
}
async function click(text: string) {
  const button = Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  );
  if (!button) throw new Error(`缺少按钮 ${text}`);
  await act(async () => {
    button.click();
  });
}
describe("服务端目录选择弹窗", () => {
  it("过滤工程文件并直接返回 .lg 路径", async () => {
    const { result } = await mount({ mode: "files", extensions: [".lg"] });
    expect(container?.textContent).toContain("book.lg");
    expect(container?.textContent).not.toContain("chapter,1.txt");
    expect(container?.textContent).not.toContain("escape");
    await click("book.lg");
    await click("app.action.confirm (1)");
    expect(await result).toEqual({ canceled: false, paths: ["/data/book.lg"] });
  });
  it("进入文件夹仍保留跨目录多选结果", async () => {
    const { result } = await mount({ mode: "files", multiple: true, extensions: [".txt"] });
    await click("chapter,1.txt");
    await click("novels");
    await click("inner.txt");
    await click("app.action.confirm (2)");
    expect(await result).toEqual({
      canceled: false,
      paths: ["/data/chapter,1.txt", "/data/novels/inner.txt"],
    });
  });
  it("取消不提交路径，保存只组合当前目录和文件名", async () => {
    const canceled = await mount({ mode: "files" });
    await click("app.action.cancel");
    expect(await canceled.result).toEqual({ canceled: true, paths: [] });
  });
  it("保存使用默认文件名，目录选择使用当前路径", async () => {
    const { result } = await mount({ mode: "save", default_name: "new-project.lg" });
    await click("novels");
    await click("app.action.save");
    expect(await result).toEqual({ canceled: false, paths: ["/data/novels/new-project.lg"] });
  });
});
