import { Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import { useProjectSessionUiState } from "@frontend/app/session/project-session-ui-state-context";
import { useDesktopState } from "@frontend/app/state/use-desktop-state";
import type { JsonRecord } from "@domain/json";
import { useI18n } from "@frontend/app/locale/locale-context";
import { api_fetch, api_file_url } from "@frontend/app/desktop/desktop-api";
import type { ScreenComponentProps } from "@frontend/app/navigation/types";

import "@frontend/pages/file-page/file-page.css";

/**
 * 文件管理页。
 *
 * 定位：补上桌面端没有的能力 —— 在**服务端**浏览目录、上传源文件、整理文件。
 * 桌面端用系统文件对话框选路径，服务器部署下没有那个通道，所以这页只在
 * 服务器部署下有意义（`/api/files/*` 与它同属新增能力）。
 *
 * 移动端优先：本页是自己的代码，因此**直接按窄屏写**，不依赖移动端适配层补丁。
 * 触摸目标 ≥44px、操作固定在拇指可达处、不依赖 hover。
 */

type FileEntry = {
  name: string;
  kind: "dir" | "file" | "link";
  size: number | null;
  modifiedAt: string;
};

type ListResult = {
  path: string;
  relativePath: string;
  parent: string | null;
  entries: FileEntry[];
};

type TrashItem = {
  id: string;
  originalPath: string;
  name: string;
  kind: "dir" | "file";
  size: number | null;
  deletedAt: string;
};

type RootsResult = { root: string; trashDir: string };

type UploadTask = {
  id: number;
  name: string;
  sent: number;
  total: number;
  status: "uploading" | "done" | "error";
  message: string;
};

/** 人类可读的文件大小。 */
function format_size(bytes: number | null): string {
  if (bytes === null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

function join_path(directory: string, name: string): string {
  return `${directory.replace(/\/+$/u, "")}/${name}`;
}

export function FilePage(_props: ScreenComponentProps): JSX.Element {
  const { t } = useI18n();
  const { get_page_ui_state, set_page_ui_state } = useProjectSessionUiState();
  const initial_directory = useRef(
    get_page_ui_state<{ path: string }>("file-browser")?.path ?? null,
  );
  const {
    refresh_project_snapshot,
    set_project_session_status,
    refresh_settings,
    refresh_batch_translation,
  } = useDesktopState();

  const [root, setRoot] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, set_selected] = useState<ReadonlySet<string>>(new Set());
  const [uploads, set_uploads] = useState<UploadTask[]>([]);
  const [tab, set_tab] = useState<"files" | "trash">("files");
  const [trash, set_trash] = useState<TrashItem[]>([]);
  const [busy, set_busy] = useState(false);
  const [notice, set_notice] = useState<string | null>(null);
  const file_input = useRef<HTMLInputElement | null>(null);
  const next_upload_id = useRef(1);

  const report = useCallback((message: string) => {
    set_notice(message);
    window.setTimeout(
      () => set_notice((current_notice) => (current_notice === message ? null : current_notice)),
      2600,
    );
  }, []);

  const load_list = useCallback(
    async (target: string | null) => {
      const result = await api_fetch<ListResult>(
        "/api/files/list",
        target === null ? {} : { path: target },
      );
      setCurrent(result.path);
      set_page_ui_state("file-browser", { path: result.path });
      setEntries(result.entries);
      set_selected(new Set());
    },
    [set_page_ui_state],
  );

  // 首次加载：取囚笼根，再列它
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const roots = await api_fetch<RootsResult>("/api/files/roots");
        if (cancelled) return;
        setRoot(roots.root);
        await load_list(initial_directory.current ?? roots.root);
      } catch (error) {
        if (!cancelled) report(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load_list, report]);

  const load_trash = useCallback(async () => {
    const result = await api_fetch<{ items: TrashItem[] }>("/api/files/trash/list");
    set_trash(result.items);
  }, []);

  useEffect(() => {
    if (tab !== "trash") return;
    void load_trash().catch((error: unknown) => {
      report(error instanceof Error ? error.message : String(error));
    });
  }, [tab, load_trash, report]);

  /**
   * 上传用 XMLHttpRequest：fetch 没有上传进度事件，
   * 而手机上"传了没反应"是最容易让人以为卡死的体验。
   */
  const upload_file = useCallback(
    (file: File, directory: string) => {
      const id = next_upload_id.current++;
      set_uploads((tasks) => [
        ...tasks,
        { id, name: file.name, sent: 0, total: file.size, status: "uploading", message: "" },
      ]);

      const request = new XMLHttpRequest();
      request.open(
        "POST",
        api_file_url(
          `/api/files/upload?path=${encodeURIComponent(directory)}&name=${encodeURIComponent(file.name)}`,
        ),
      );
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        set_uploads((tasks) =>
          tasks.map((task) =>
            task.id === id ? { ...task, sent: event.loaded, total: event.total } : task,
          ),
        );
      });
      const settle = (status: UploadTask["status"], message: string): void => {
        set_uploads((tasks) =>
          tasks.map((task) => (task.id === id ? { ...task, status, message } : task)),
        );
        window.setTimeout(() => {
          set_uploads((tasks) => tasks.filter((task) => task.id !== id));
          void load_list(directory).catch(() => undefined);
        }, 1200);
      };
      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) settle("done", "");
        else {
          let message = `HTTP ${request.status}`;
          try {
            message =
              (JSON.parse(request.responseText) as { error?: { code?: string } }).error?.code ??
              message;
          } catch {
            /* 保持 HTTP 状态码 */
          }
          settle("error", message);
        }
      });
      request.addEventListener("error", () => settle("error", "network"));
      request.send(file);
    },
    [load_list],
  );

  const selected_files = useMemo(() => [...selected], [selected]);

  const create_project = useCallback(async () => {
    if (current === null || selected_files.length === 0) return;
    const first = selected_files[0] ?? "";
    const suggested = (first.split("/").at(-1) ?? "").replace(/\.[^.]+$/u, "");
    const picked = await window.desktopApp.pickProjectSavePath(`${suggested}.lg`);
    if (picked.canceled || !picked.paths[0]) return;

    const project_path = picked.paths[0].endsWith(".lg")
      ? picked.paths[0]
      : `${picked.paths[0]}.lg`;
    set_busy(true);
    try {
      // 保存目录由用户在文件根中选择。
      await api_fetch<JsonRecord>("/api/session/project/create", {
        path: project_path,
        source_paths: selected_files,
      });
      set_project_session_status("warming");
      await refresh_project_snapshot();
      await api_fetch("/api/settings/recent-projects/add", {
        path: project_path,
        name: (project_path.split("/").at(-1) ?? suggested).replace(/\.lg$/iu, ""),
      });
      await Promise.all([refresh_settings(), refresh_batch_translation()]);
      report(t("file_page.notice.project_created"));
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      set_busy(false);
    }
  }, [
    current,
    selected_files,
    report,
    t,
    refresh_project_snapshot,
    set_project_session_status,
    refresh_settings,
    refresh_batch_translation,
  ]);

  const make_directory = useCallback(async () => {
    if (current === null) return;
    const name = window.prompt(t("file_page.prompt.new_folder"));
    if (name === null || name.trim() === "") return;
    try {
      await api_fetch("/api/files/mkdir", { path: join_path(current, name.trim()) });
      await load_list(current);
      report(t("file_page.notice.folder_created"));
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  }, [current, load_list, report, t]);

  const remove_entry = useCallback(
    async (target: string) => {
      if (current === null) return;
      try {
        await api_fetch("/api/files/delete", { paths: [target] });
        await load_list(current);
        report(t("file_page.notice.moved_to_trash"));
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    },
    [current, load_list, report, t],
  );

  const rename_entry = useCallback(
    async (entry: FileEntry) => {
      if (current === null) return;
      const next = window.prompt(t("file_page.prompt.rename"), entry.name);
      if (next === null || next.trim() === "" || next === entry.name) return;
      try {
        await api_fetch("/api/files/rename", {
          from: join_path(current, entry.name),
          to: join_path(current, next.trim()),
        });
        await load_list(current);
        report(t("file_page.notice.renamed"));
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    },
    [current, load_list, report, t],
  );

  function toggle_selection(full_path: string): void {
    set_selected((previous) => {
      const next = new Set(previous);
      if (next.has(full_path)) next.delete(full_path);
      else next.add(full_path);
      return next;
    });
  }

  const visible = tab === "files" ? entries : [];

  return (
    <div className="file-page page-shell page-shell--full">
      <div className="file-page__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          className="file-page__tab"
          onClick={() => set_tab("files")}
        >
          {t("file_page.tab.files")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "trash"}
          className="file-page__tab"
          onClick={() => set_tab("trash")}
        >
          {t("file_page.tab.trash")}
        </button>
      </div>

      {tab === "files" ? (
        <>
          <div className="file-page__pathbar">
            <button
              type="button"
              className="file-page__icon-button"
              aria-label={t("file_page.action.up")}
              disabled={current === null || current === root}
              onClick={() => {
                if (current === null || root === null) return;
                const parent = current.replace(/\/[^/]+\/?$/u, "");
                void load_list(parent === "" ? root : parent);
              }}
            >
              ↑
            </button>
            <div className="file-page__path" title={current ?? ""}>
              {current ?? "…"}
            </div>
            <button
              type="button"
              className="file-page__icon-button"
              aria-label={t("file_page.action.new_folder")}
              onClick={() => void make_directory()}
            >
              ＋
            </button>
          </div>

          {uploads.length > 0 ? (
            <div className="file-page__uploads">
              {uploads.map((task) => {
                const percent = task.total > 0 ? Math.round((task.sent / task.total) * 100) : 0;
                return (
                  <div key={task.id} className="file-page__upload">
                    <div className="file-page__upload-head">
                      <span className="file-page__upload-name">{task.name}</span>
                      <span>
                        {task.status === "done"
                          ? t("file_page.upload.done")
                          : task.status === "error"
                            ? t("file_page.upload.failed")
                            : `${percent}%`}
                      </span>
                    </div>
                    <div className="file-page__upload-bar">
                      <div className="file-page__upload-fill" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {visible.length === 0 ? (
            <div className="file-page__empty">
              <div className="file-page__empty-icon" aria-hidden="true">
                📂
              </div>
              <div>{t("file_page.empty.files")}</div>
            </div>
          ) : (
            <ul className="file-page__list">
              {visible.map((entry) => {
                const full = current === null ? entry.name : join_path(current, entry.name);
                const is_selected = selected.has(full);
                return (
                  <li key={entry.name} className="file-page__row" data-selected={is_selected}>
                    <button
                      type="button"
                      className="file-page__row-main"
                      onClick={() => {
                        if (entry.kind === "dir") void load_list(full);
                        else toggle_selection(full);
                      }}
                    >
                      <span className="file-page__row-icon" aria-hidden="true">
                        {entry.kind === "dir" ? "📁" : entry.kind === "link" ? "🔗" : "📄"}
                      </span>
                      <span className="file-page__row-body">
                        <span className="file-page__row-name">{entry.name}</span>
                        <span className="file-page__row-meta">
                          {entry.kind === "dir"
                            ? t("file_page.kind.directory")
                            : format_size(entry.size)}
                          {is_selected ? ` · ${t("file_page.state.selected")}` : ""}
                        </span>
                      </span>
                    </button>
                    {entry.kind === "file" ? (
                      <a
                        className="file-page__download"
                        href={api_file_url(`/api/files/download?path=${encodeURIComponent(full)}`)}
                        download={entry.name}
                      >
                        <Download aria-hidden="true" />
                        <span>{t("file_page.action.download")}</span>
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="file-page__icon-button"
                      aria-label={t("file_page.action.rename")}
                      onClick={() => void rename_entry(entry)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="file-page__icon-button"
                      aria-label={t("file_page.action.delete")}
                      onClick={() => void remove_entry(full)}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="file-page__actions">
            <input
              ref={file_input}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                if (current === null) return;
                for (const file of files) upload_file(file, current);
              }}
            />
            <button
              type="button"
              className="file-page__button"
              onClick={() => file_input.current?.click()}
            >
              {t("file_page.action.upload")}
            </button>
            <button
              type="button"
              className="file-page__button file-page__button--primary"
              disabled={busy || selected_files.length === 0}
              onClick={() => void create_project()}
            >
              {t("file_page.action.create_project")}
              {selected_files.length > 0 ? ` (${selected_files.length})` : ""}
            </button>
          </div>
        </>
      ) : (
        <>
          {trash.length === 0 ? (
            <div className="file-page__empty">
              <div className="file-page__empty-icon" aria-hidden="true">
                🗑️
              </div>
              <div>{t("file_page.empty.trash")}</div>
            </div>
          ) : (
            <ul className="file-page__list">
              {trash.map((item) => (
                <li key={item.id} className="file-page__row">
                  <span className="file-page__row-main file-page__row-main--static">
                    <span className="file-page__row-icon" aria-hidden="true">
                      {item.kind === "dir" ? "📁" : "📄"}
                    </span>
                    <span className="file-page__row-body">
                      <span className="file-page__row-name">{item.name}</span>
                      <span className="file-page__row-meta">{format_size(item.size)}</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="file-page__icon-button"
                    aria-label={t("file_page.action.restore")}
                    onClick={() => {
                      void api_fetch("/api/files/trash/restore", { ids: [item.id] })
                        .then(load_trash)
                        .catch((error: unknown) =>
                          report(error instanceof Error ? error.message : String(error)),
                        );
                    }}
                  >
                    ↩
                  </button>
                  <button
                    type="button"
                    className="file-page__icon-button"
                    aria-label={t("file_page.action.purge")}
                    onClick={() => {
                      void api_fetch("/api/files/trash/purge", { ids: [item.id] })
                        .then(load_trash)
                        .catch((error: unknown) =>
                          report(error instanceof Error ? error.message : String(error)),
                        );
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="file-page__actions">
            <button
              type="button"
              className="file-page__button"
              disabled={trash.length === 0}
              onClick={() => {
                void api_fetch("/api/files/trash/purge", { all: true })
                  .then(load_trash)
                  .catch((error: unknown) =>
                    report(error instanceof Error ? error.message : String(error)),
                  );
              }}
            >
              {t("file_page.action.purge_all")}
            </button>
          </div>
        </>
      )}

      {notice === null ? null : (
        <div className="file-page__notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
