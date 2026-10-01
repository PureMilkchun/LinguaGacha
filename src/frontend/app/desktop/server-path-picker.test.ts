import { afterEach, describe, expect, it } from "vitest";
import {
  finish_server_path_pick,
  get_server_path_pick,
  request_server_path_pick,
} from "./server-path-picker";

afterEach(() => {
  const request = get_server_path_pick();
  if (request) finish_server_path_pick(request.id, { canceled: true, paths: [] });
});
describe("服务端文件选择请求", () => {
  it("选择结果返回原始服务端路径，路径中的逗号不会被拆分", async () => {
    const result = request_server_path_pick({ mode: "files" });
    const request = get_server_path_pick()!;
    finish_server_path_pick(request.id, { canceled: false, paths: ["/data/novels/chapter,1.txt"] });
    expect(await result).toEqual({ canceled: false, paths: ["/data/novels/chapter,1.txt"] });
    expect(get_server_path_pick()).toBeNull();
  });
  it("替换请求会取消旧选择，旧弹窗不能结束新请求", async () => {
    const first = request_server_path_pick({ mode: "files" });
    const old = get_server_path_pick()!;
    const second = request_server_path_pick({ mode: "directory" });
    const current = get_server_path_pick()!;
    expect(await first).toEqual({ canceled: true, paths: [] });
    finish_server_path_pick(old.id, { canceled: false, paths: ["/data/old.txt"] });
    expect(get_server_path_pick()?.id).toBe(current.id);
    finish_server_path_pick(current.id, { canceled: true, paths: [] });
    expect(await second).toEqual({ canceled: true, paths: [] });
  });
});
