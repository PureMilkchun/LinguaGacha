import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { FilePage } from "./page";
const state = vi.hoisted(() => ({
  get: () => null,
  set: vi.fn(),
  refresh: vi.fn(async () => ({})),
  status: vi.fn(),
  recent: vi.fn(async () => {}),
  batch: vi.fn(async () => {}),
  fetch: vi.fn(async (route: string) =>
    route.endsWith("roots")
      ? { root: "/data" }
      : route.endsWith("list")
        ? { path: "/data", entries: [{ name: "chapter.txt", kind: "file", size: 12 }] }
        : {},
  ),
}));
vi.mock("@frontend/app/session/project-session-ui-state-context", () => ({
  useProjectSessionUiState: () => ({ get_page_ui_state: state.get, set_page_ui_state: state.set }),
}));
vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@frontend/app/desktop/desktop-api", () => ({
  api_fetch: state.fetch,
  api_file_url: (path: string) => `http://localhost${path}`,
}));
vi.mock("@frontend/app/state/use-desktop-state", () => ({
  useDesktopState: () => ({
    refresh_project_snapshot: state.refresh,
    set_project_session_status: state.status,
    refresh_settings: state.recent,
    refresh_batch_translation: state.batch,
  }),
}));
describe("文件页工程创建", () => {
  it("使用目录选择器保存，创建后刷新共享工程状态和最近工程", async () => {
    const bridge = window.desktopApp;
    const pick = vi.fn(async () => ({ canceled: false, paths: ["/data/projects/new-book"] }));
    window.desktopApp = { ...bridge, pickProjectSavePath: pick };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<FilePage is_sidebar_collapsed />);
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>(".file-page__row-main")?.click();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>(".file-page__button--primary")?.click();
      });
      expect(pick).toHaveBeenCalledWith("chapter.lg");
      expect(state.fetch).toHaveBeenCalledWith("/api/session/project/create", {
        path: "/data/projects/new-book.lg",
        source_paths: ["/data/chapter.txt"],
      });
      expect(state.refresh).toHaveBeenCalledOnce();
      expect(state.status).toHaveBeenCalledWith("warming");
      expect(state.fetch).toHaveBeenCalledWith("/api/settings/recent-projects/add", {
        path: "/data/projects/new-book.lg",
        name: "new-book",
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.desktopApp = bridge;
    }
  });
});

it("文件行提供带原始文件名的浏览器下载链接", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<FilePage is_sidebar_collapsed />));
    const link = container.querySelector<HTMLAnchorElement>(".file-page__download");
    expect(link?.textContent).toContain("file_page.action.download");
    expect(link?.download).toBe("chapter.txt");
    expect(new URL(link!.href).searchParams.get("path")).toBe("/data/chapter.txt");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
