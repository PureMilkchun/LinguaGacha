import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { ArrowUp, File, Folder } from "lucide-react";
import { api_fetch } from "@frontend/app/desktop/desktop-api";
import {
  finish_server_path_pick,
  get_server_path_pick,
  subscribe_server_path_pick,
  type ServerPathPickRequest,
} from "@frontend/app/desktop/server-path-picker";
import { useI18n } from "@frontend/app/locale/locale-context";
import { AppPageDialog } from "@frontend/widgets/app-page-dialog";
import { AppButton } from "@frontend/widgets/app-button";
import { Input } from "@frontend/shadcn/input";
import "./server-path-picker.css";

type FileEntry = { name: string; kind: "dir" | "file" | "link"; size: number | null };
type DirectoryList = { path: string; parent: string | null; entries: FileEntry[] };
const join_path = (directory: string, name: string): string =>
  `${directory.replace(/\/+$/u, "")}/${name}`;

export function ServerPathPickerHost(): JSX.Element | null {
  const request = useSyncExternalStore(subscribe_server_path_pick, get_server_path_pick);
  return request === null ? null : <ServerPathPicker key={request.id} request={request} />;
}

function ServerPathPicker({ request }: { request: ServerPathPickRequest }): JSX.Element {
  const { t } = useI18n();
  const options = request.options;
  const title_ref = useRef<HTMLHeadingElement>(null);
  const [root, set_root] = useState("");
  const [directory, set_directory] = useState("");
  const [listing, set_listing] = useState<DirectoryList | null>(null);
  const [selected, set_selected] = useState<readonly string[]>([]);
  const [query, set_query] = useState("");
  const [name, set_name] = useState((options.default_name ?? "").split(/[\\/]/u).at(-1) ?? "");
  const [busy, set_busy] = useState(true);
  const [reload, set_reload] = useState(0);
  const [error, set_error] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const roots = await api_fetch<{ root: string }>("/api/files/roots", {}, controller.signal);
        let initial = roots.root;
        if (options.initial_folder) initial = join_path(initial, options.initial_folder);
        if (
          options.default_path?.startsWith(roots.root + "/") ||
          options.default_path === roots.root
        )
          initial = options.default_path;
        if (!controller.signal.aborted) {
          set_root(roots.root);
          set_directory(initial);
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          set_error(caught instanceof Error ? caught.message : String(caught));
          set_busy(false);
        }
      }
    })();
    return () => controller.abort();
  }, [options, reload]);

  useEffect(() => {
    if (!directory) return;
    const controller = new AbortController();
    set_busy(true);
    set_error("");
    set_listing(null);
    set_query("");
    void (async () => {
      try {
        const result = await api_fetch<DirectoryList>(
          "/api/files/list",
          { path: directory },
          controller.signal,
        );
        if (!controller.signal.aborted) set_listing(result);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (options.initial_folder && directory === join_path(root, options.initial_folder))
          set_directory(root);
        else set_error(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!controller.signal.aborted) set_busy(false);
      }
    })();
    return () => controller.abort();
  }, [directory, root, options.initial_folder, reload]);

  const close = (): void => finish_server_path_pick(request.id, { canceled: true, paths: [] });
  const filename = name.trim();
  const valid_name =
    filename !== "" &&
    filename !== "." &&
    filename !== ".." &&
    !/[\\/]/u.test(filename) &&
    !filename.includes(String.fromCharCode(0));
  const can_confirm =
    !busy &&
    listing !== null &&
    (options.mode === "directory" || (options.mode === "save" ? valid_name : selected.length > 0));
  const confirm = (): void => {
    if (!can_confirm || listing === null) return;
    const paths =
      options.mode === "directory"
        ? [listing.path]
        : options.mode === "save"
          ? [join_path(listing.path, filename)]
          : [...selected];
    finish_server_path_pick(request.id, { canceled: false, paths });
  };
  const title =
    options.mode === "save"
      ? t("app.action.save")
      : options.mode === "directory"
        ? t("app.action.select_folder")
        : options.extensions?.includes(".lg")
          ? t("project_page.open.title")
          : t("app.action.select_file");
  const visible = (listing?.entries ?? [])
    .filter(
      (entry) =>
        entry.kind !== "link" &&
        (entry.kind === "dir" ||
          (options.mode !== "directory" &&
            (!options.extensions ||
              options.extensions.some((extension) =>
                entry.name.toLowerCase().endsWith(extension),
              )))) &&
        entry.name.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name),
    );

  return (
    <AppPageDialog
      open
      title={title}
      size="lg"
      initialFocus={title_ref}
      onClose={close}
      bodyClassName="server-path-picker"
      footer={
        <>
          <AppButton variant="outline" onClick={close}>
            {t("app.action.cancel")}
          </AppButton>
          <AppButton disabled={!can_confirm} onClick={confirm}>
            {options.mode === "directory"
              ? t("file_page.picker.current_directory")
              : options.mode === "save"
                ? t("app.action.save")
                : `${t("app.action.confirm")} (${selected.length})`}
          </AppButton>
        </>
      }
    >
      <h2 ref={title_ref} tabIndex={-1} className="server-path-picker__title">
        {title}
      </h2>
      <div className="server-path-picker__pathbar">
        <AppButton
          size="icon"
          variant="outline"
          aria-label={t("file_page.action.up")}
          disabled={busy || !listing?.parent || listing.path === root}
          onClick={() => {
            if (listing?.parent) set_directory(listing.parent);
          }}
        >
          <ArrowUp />
        </AppButton>
        <span className="server-path-picker__path">{listing?.path ?? directory}</span>
      </div>
      <Input
        aria-label={t("file_page.picker.search")}
        placeholder={t("file_page.picker.search")}
        value={query}
        onChange={(event) => set_query(event.target.value)}
      />
      {error ? (
        <div role="alert">
          {error}
          <AppButton variant="outline" onClick={() => set_reload((value) => value + 1)}>
            {t("app.action.retry")}
          </AppButton>
        </div>
      ) : null}
      <ul className="server-path-picker__list" aria-busy={busy}>
        {busy ? (
          <li className="server-path-picker__empty">{t("app.action.loading")}</li>
        ) : visible.length === 0 ? (
          <li className="server-path-picker__empty">{t("file_page.empty.files")}</li>
        ) : (
          visible.map((entry) => {
            const path = join_path(listing?.path ?? directory, entry.name);
            const active = selected.includes(path);
            return (
              <li key={path}>
                <button
                  type="button"
                  className="server-path-picker__entry"
                  aria-pressed={entry.kind === "file" ? active : undefined}
                  onClick={() => {
                    if (entry.kind === "dir") set_directory(path);
                    else if (options.mode === "save") set_name(entry.name);
                    else
                      set_selected(
                        options.multiple
                          ? active
                            ? selected.filter((value) => value !== path)
                            : [...selected, path]
                          : [path],
                      );
                  }}
                >
                  {entry.kind === "dir" ? (
                    <Folder aria-hidden="true" />
                  ) : (
                    <File aria-hidden="true" />
                  )}
                  <span>{entry.name}</span>
                  {active ? <span className="server-path-picker__selected">✓</span> : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
      {options.mode === "save" ? (
        <label className="server-path-picker__filename">
          <span>{t("file_page.picker.filename")}</span>
          <Input value={name} onChange={(event) => set_name(event.target.value)} />
        </label>
      ) : options.mode === "files" ? (
        <p className="server-path-picker__selection">
          {t("file_page.picker.selected", { COUNT: String(selected.length) })}
        </p>
      ) : null}
    </AppPageDialog>
  );
}
