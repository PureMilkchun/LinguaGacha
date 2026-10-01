import { describe, expect, it } from "vitest";
import {
  is_agent_markdown_path,
  is_agent_text_path,
  resolve_agent_workspace_href,
} from "./agent-workspace-file";

describe("工作区文档链接", () => {
  it("相对当前文档归一目录，只解码一次并保留标题片段", () => {
    expect(
      resolve_agent_workspace_href("../结果%20%23%2523.MD#结论", "work/reports/check.md"),
    ).toBe("work/%E7%BB%93%E6%9E%9C%20%23%2523.MD#结论");
    expect(resolve_agent_workspace_href("#结论", "work/check.md")).toBe("work/check.md#结论");
    expect(is_agent_markdown_path("work/%E6%8A%A5%E5%91%8A.MARKDOWN#结论")).toBe(true);
    expect(is_agent_markdown_path("work/report.pdf")).toBe(false);
  });
  it.each([
    "../../outside.md",
    "/outside.md",
    "C:/report.md",
    "%2e%2e/%2e%2e/outside.md",
    "%00.md",
    "bad%ZZ.md",
  ])("拒绝越界和损坏路径 %s", (href) => {
    expect(() => resolve_agent_workspace_href(href, "work/report.md")).toThrow();
  });
});

it.each([
  "work/report.TXT",
  "work/data.json#summary",
  "work/表%20格.csv",
  "work/data.tsv",
  "work/task.log",
])("普通文本有明确预览能力 %s", (path) => {
  expect(is_agent_text_path(path)).toBe(true);
});
it.each(["work/report.pdf", "work/data.bin", "bad%ZZ.txt"])(
  "二进制或损坏路径不进入文本预览 %s",
  (path) => {
    expect(is_agent_text_path(path)).toBe(false);
  },
);
