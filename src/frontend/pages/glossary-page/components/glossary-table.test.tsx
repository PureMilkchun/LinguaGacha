import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GlossaryTable } from "./glossary-table";
import { TooltipProvider } from "@frontend/shadcn/tooltip";
import type { GlossarySortState } from "@frontend/pages/glossary-page/types";

const viewport = vi.hoisted(() => ({ narrow: true }));
vi.mock("@frontend/widgets/interactions/use-is-narrow-viewport", () => ({
  use_is_narrow_viewport: () => viewport.narrow,
}));
vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-virtual", async (original) => {
  const actual = await original<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) =>
      actual.useVirtualizer({
        ...options,
        observeElementRect: (_instance, callback) => callback({ width: 390, height: 600 }),
      }),
  };
});
let container: HTMLDivElement;
let root: Root;
const edit = vi.fn(),
  selection = vi.fn(),
  sort = vi.fn();
beforeEach(() => {
  viewport.narrow = true;
  localStorage.removeItem("lg-glossary-columns");
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(sort_state: GlossarySortState = null) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GlossaryTable
          entries={[
            {
              entry_id: "term-1",
              source_index: 0,
              entry: {
                entry_id: "term-1",
                src: "Theodore Nott",
                dst: "西奥多·诺特",
                info: "男主角的完整人物描述",
                case_sensitive: false,
              },
            },
          ]}
          sort_state={sort_state}
          readonly={false}
          reorder_disabled={false}
          hit_sort_available
          selected_entry_ids={[]}
          active_entry_id={null}
          anchor_entry_id={null}
          restore_scroll_entry_id={null}
          hit_badge_by_entry_id={{}}
          on_sort_change={sort}
          on_selection_change={selection}
          on_open_edit={edit}
          on_toggle_case_sensitive={async () => {}}
          on_reorder={async () => {}}
          on_query_entry_source={async () => {}}
          on_search_entry_relations={() => {}}
        />
      </TooltipProvider>,
    ),
  );
}
it("手机默认为传统三列表格，原文译文描述仍可选择与编辑", async () => {
  await render();
  expect(container.querySelectorAll("thead th")).toHaveLength(3);
  expect(container.querySelector(".glossary-page__summary")).toBeNull();
  const cell = container.querySelector<HTMLElement>(".glossary-page__table-source-cell")!;
  expect(cell.textContent).toBe("Theodore Nott");
  await act(async () => cell.click());
  expect(selection.mock.calls.at(-1)?.[0].selected_row_ids).toEqual(["term-1"]);
  await act(async () => cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(edit).toHaveBeenCalledWith("term-1");
});
it.each([
  [null, { column_id: "dst", direction: "ascending" }],
  [
    { column_id: "dst", direction: "ascending" },
    { column_id: "dst", direction: "descending" },
  ],
  [{ column_id: "dst", direction: "descending" }, null],
] as const)("译文列头保持三态排序：%s", async (state, expected) => {
  await render(state);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".glossary-page__table-translation-head button")!
      .click(),
  );
  expect(sort).toHaveBeenCalledExactlyOnceWith(expected);
});
it("用户开启命中列并持久化，下次打开保留选择", async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>(".glossary-page__columns-trigger")!.click(),
  );
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ).find((el) => el.textContent?.includes("quality_rule_editor.fields.hit"))!;
  expect(option).not.toBeUndefined();
  await act(async () => option.click());
  expect(container.querySelectorAll("thead th")).toHaveLength(4);
  expect(JSON.parse(localStorage.getItem("lg-glossary-columns")!)).toEqual([
    "src",
    "dst",
    "info",
    "hit",
  ]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.querySelectorAll("thead th")).toHaveLength(4);
});
it("只剩一列时不能关闭最后一列，无效偏好回退三列", async () => {
  localStorage.setItem("lg-glossary-columns", JSON.stringify(["src"]));
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>(".glossary-page__columns-trigger")!.click(),
  );
  const first = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ).find((el) => el.textContent?.includes("quality_rule_editor.fields.source"))!;
  expect(first.hasAttribute("data-disabled")).toBe(true);
  await act(async () => first.click());
  expect(container.querySelectorAll("thead th")).toHaveLength(1);
  await act(async () => root.unmount());
  root = createRoot(container);
  localStorage.setItem("lg-glossary-columns", JSON.stringify(["invalid"]));
  await render();
  expect(container.querySelectorAll("thead th")).toHaveLength(3);
});
it("桌面同样默认三列并使用普通表格", async () => {
  viewport.narrow = false;
  await render();
  expect(container.querySelectorAll("thead th")).toHaveLength(3);
  expect(container.querySelector(".glossary-page__table-translation-cell")?.textContent).toBe(
    "西奥多·诺特",
  );
});
