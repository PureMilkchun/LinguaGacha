import { useEffect, useLayoutEffect, useMemo, useRef, type JSX } from "react";
import { ArrowLeft, Download, FileText, Image, MessageSquareText, X } from "lucide-react";
import { use_is_narrow_viewport } from "@frontend/widgets/interactions/use-is-narrow-viewport";
import type { ScreenComponentProps } from "@frontend/app/navigation/types";
import { useAppNavigation } from "@frontend/app/navigation/navigation-context";
import {
  useAgentControls,
  useAgentSessionId,
} from "@frontend/app/session/agent/agent-session-context";
import { useI18n } from "@frontend/app/locale/locale-context";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@frontend/shadcn/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@frontend/shadcn/tooltip";
import { is_browser_host } from "@frontend/app/desktop/desktop-api";
import { agent_file_download_url } from "./agent-file-download";
import { AgentConversation } from "./agent-conversation";
import { AgentPreviewPage } from "./agent-preview";
import { AgentFileContext } from "./agent-file-context";
import { useAgentPreviews } from "./use-agent-previews";
import "./agent-documents.css";

const CONVERSATION_TAB = "conversation";

/** 对话身份决定全部页内资源的生命周期。 */
export function AgentPage(_props: ScreenComponentProps): JSX.Element {
  const session_id = useAgentSessionId();
  return <AgentPages key={session_id ?? "restoring"} session_id={session_id ?? ""} />;
}

/** 页内标签保留组件实例，会话身份变化才整体释放旧页面。 */
function AgentPages({ session_id }: { session_id: string }): JSX.Element {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const { pendingDecision } = useAgentControls();
  const { agent_input_request } = useAppNavigation();
  const state = useAgentPreviews(session_id);
  const { select } = state;
  const conversation_active = state.selected === null;
  const is_narrow = use_is_narrow_viewport();
  const active_document =
    state.documents.find((document) => document.path === state.selected) ?? null;
  /*
   * 手机上预览独占整页。
   *
   * 桌面上文档是「与对话并列的标签页」，手机上标签条会与对话内容争夺同一屏，
   * 而且窄屏下标签本身也放不下几个文件名。因此窄屏且打开了文档时，
   * 把标签条换成带返回按钮的页头 —— 文档面板本就占满剩余空间，于是成为单独一页。
   *
   * 注意这里只是**换掉页头**，没有改变组件树：Tabs 仍以 keepMounted 保留对话面板，
   * 因此草稿、滚动位置与运行态都不会因为"切到预览页"而丢失。
   */
  const document_full_page = is_narrow && active_document !== null;
  const context = useMemo(
    () => ({ open_file: state.open_file, session_id, active: true }),
    [state.open_file, session_id],
  );
  const inactive_context = useMemo(() => ({ ...context, active: false }), [context]);
  useEffect(() => {
    if (agent_input_request) select(null);
  }, [agent_input_request, select]);
  /** 关闭后从已提交的 DOM 恢复焦点，最后一个标签关闭时回到对话面板。 */
  const focus_current = (): void => {
    const target = !root.current?.querySelector<HTMLElement>('[role="tablist"]')?.hidden
      ? root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      : root.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
    target?.focus({ preventScroll: true });
  };
  const previous_selected = useRef(state.selected);
  useLayoutEffect(() => {
    if (previous_selected.current === state.selected) return;
    previous_selected.current = state.selected;
    const target = root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (state.documents.length > 0) target?.focus({ preventScroll: true });
  }, [state.selected, state.documents.length]);
  return (
    <Tabs
      ref={root}
      className="agent-pages"
      value={state.selected ?? CONVERSATION_TAB}
      onValueChange={(value) => select(value === CONVERSATION_TAB ? null : String(value))}
    >
      {document_full_page ? (
        <div className="agent-pages__page-header">
          <button type="button" className="agent-pages__back" onClick={() => select(null)}>
            <ArrowLeft aria-hidden="true" />
            <span>{t("agent_page.document.back_to_conversation")}</span>
          </button>
          <span className="agent-pages__page-title">{active_document?.name}</span>
        </div>
      ) : null}
      <TabsList
        className="agent-pages__tabs"
        hidden={state.documents.length === 0 || document_full_page}
        activateOnFocus={false}
      >
        <TabsTrigger
          className="agent-pages__tab"
          value={CONVERSATION_TAB}
          data-needs-response={pendingDecision && !conversation_active ? "" : undefined}
        >
          <MessageSquareText aria-hidden="true" />
          <span className="agent-pages__filename">{t("agent_page.document.conversation")}</span>
        </TabsTrigger>
        <div className="agent-pages__file-tabs">
          {state.documents.map((document) => (
            <span className="agent-pages__tab-group" key={document.path}>
              <Tooltip>
                <TooltipTrigger
                  render={<TabsTrigger className="agent-pages__tab" value={document.path} />}
                >
                  {document.preview === "image" ? (
                    <Image aria-hidden="true" />
                  ) : (
                    <FileText aria-hidden="true" />
                  )}
                  <span className="agent-pages__filename">{document.name}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{decodeURIComponent(document.path)}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="agent-pages__close"
                      aria-label={t("app.action.close")}
                      onClick={() => {
                        state.close(document.path);
                        requestAnimationFrame(focus_current);
                      }}
                    />
                  }
                >
                  <X aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("app.action.close")}</TooltipContent>
              </Tooltip>
            </span>
          ))}
        </div>
      </TabsList>
      {active_document !== null && is_browser_host() ? (
        <div className="agent-pages__file-actions">
          <a
            className="agent-pages__download"
            href={agent_file_download_url(active_document.path, session_id)}
            download={active_document.name}
          >
            <Download aria-hidden="true" />
            <span>{t("file_page.action.download")}</span>
          </a>
        </div>
      ) : null}
      <TabsContent className="agent-pages__panel" value={CONVERSATION_TAB} keepMounted>
        <AgentFileContext value={conversation_active ? context : inactive_context}>
          <AgentConversation active={conversation_active} />
        </AgentFileContext>
      </TabsContent>
      {state.documents.map((document) => (
        <TabsContent
          className="agent-pages__panel"
          key={document.path}
          value={document.path}
          keepMounted
        >
          <AgentFileContext value={state.selected === document.path ? context : inactive_context}>
            <AgentPreviewPage
              document={document}
              active={state.selected === document.path}
              scroll={state.scroll.current}
            />
          </AgentFileContext>
        </TabsContent>
      ))}
    </Tabs>
  );
}
