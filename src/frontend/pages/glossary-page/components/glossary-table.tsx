import { CaseSensitive, Columns3 } from "lucide-react";
import { type JSX, useMemo, useState, useEffect } from "react";

import { useI18n } from "@frontend/app/locale/locale-context";
import { GlossaryContextMenuItems } from "@frontend/pages/glossary-page/components/glossary-context-menu";
import type {
  GlossaryEntryId,
  GlossarySortState,
  GlossaryHitBadgeState,
  GlossaryVisibleEntry,
} from "@frontend/pages/glossary-page/types";
import { Card, CardContent } from "@frontend/shadcn/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@frontend/shadcn/tooltip";
import { QualityRuleHitBadge } from "@frontend/features/quality-rule-editor/quality-rule-hit-badge";
import { resolve_quality_rule_boolean_menu_state } from "@frontend/features/quality-rule-editor/quality-rule-selection";
import { use_is_narrow_viewport } from "@frontend/widgets/interactions/use-is-narrow-viewport";
import {
  AppDropdownMenu,
  AppDropdownMenuContent,
  AppDropdownMenuTrigger,
  AppDropdownMenuCheckboxItem,
} from "@frontend/widgets/app-dropdown-menu";
import { AppButton } from "@frontend/widgets/app-button";
import { AppTable } from "@frontend/widgets/app-table/app-table";
import type {
  AppTableColumn,
  AppTableSelectionChange,
  AppTableSortState,
} from "@frontend/widgets/app-table/app-table-types";

const COLUMN_STORAGE_KEY = "lg-glossary-columns";
const COLUMN_IDS = ["drag", "src", "dst", "info", "rule", "hit"] as const;
const DEFAULT_COLUMNS = ["src", "dst", "info"];
/** 列偏好属于当前浏览器，与工程内容无关；失效或空偏好使用三列默认值。 */
function read_columns(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) ?? "null");
    if (Array.isArray(value)) {
      const valid = COLUMN_IDS.filter((id) => value.includes(id));
      if (valid.length > 0) return valid;
    }
  } catch {
    /* 隐私模式或旧存储损坏时使用默认列。 */
  }
  return DEFAULT_COLUMNS;
}

type GlossaryTableProps = {
  entries: GlossaryVisibleEntry[];
  sort_state: GlossarySortState;
  readonly: boolean;
  reorder_disabled: boolean;
  hit_sort_available: boolean;
  selected_entry_ids: GlossaryEntryId[];
  active_entry_id: GlossaryEntryId | null;
  anchor_entry_id: GlossaryEntryId | null;
  restore_scroll_entry_id: GlossaryEntryId | null;
  hit_badge_by_entry_id: Record<GlossaryEntryId, GlossaryHitBadgeState>;
  on_sort_change: (sort_state: AppTableSortState | null) => void;
  on_selection_change: (payload: AppTableSelectionChange) => void;
  on_open_edit: (entry_id: GlossaryEntryId) => void;
  on_toggle_case_sensitive: (next_value: boolean) => Promise<void>;
  on_reorder: (ordered_entry_ids: GlossaryEntryId[]) => Promise<void>;
  on_query_entry_source: (entry_id: GlossaryEntryId) => Promise<void>;
  on_search_entry_relations: (entry_id: GlossaryEntryId) => void;
};

type GlossaryRuleBadgeProps = {
  enabled: boolean;
  tooltip: string;
};
/** 显示大小写规则并提供说明，徽标区域不触发框选。 */
function GlossaryRuleBadge(props: GlossaryRuleBadgeProps): JSX.Element {
  const badge = (
    <span className="glossary-page__rule-badge-wrap">
      <span
        data-state={props.enabled ? "active" : "inactive"}
        data-app-table-ignore-box-select="true"
        className="glossary-page__rule-badge"
      >
        <CaseSensitive aria-hidden="true" />
      </span>
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipContent>
        <p className="whitespace-pre-line">{props.tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** 将术语条目、命中与选择状态接入通用表格，写入交给页面回调。 */
export function GlossaryTable(props: GlossaryTableProps): JSX.Element {
  const { t } = useI18n();
  const is_narrow = use_is_narrow_viewport();
  const [visible_columns, set_visible_columns] = useState(read_columns);
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visible_columns));
    } catch {
      /* 禁止本地存储的浏览器仍保留当前页面的列选择。 */
    }
  }, [visible_columns]);
  const visible_entry_by_id = useMemo(() => {
    return new Map(
      props.entries.map((entry) => {
        return [entry.entry_id, entry] as const;
      }),
    );
  }, [props.entries]);

  const columns = useMemo<AppTableColumn<GlossaryVisibleEntry>[]>(() => {
    const desktop_columns: AppTableColumn<GlossaryVisibleEntry>[] = [
      {
        kind: "drag",
        id: "drag",
        width: 64,
        align: "center",
        title: t("app.drag.handle"),
        head_class_name: "glossary-page__table-drag-head",
        cell_class_name: "glossary-page__table-drag-cell",
      },
      {
        kind: "data",
        id: "src",
        title: t("quality_rule_editor.fields.source"),
        align: "left",
        sortable: {},
        head_class_name: "glossary-page__table-source-head",
        cell_class_name: "glossary-page__table-source-cell",
        render_cell: (payload) => {
          return <span className="glossary-page__table-text">{payload.row.entry.src}</span>;
        },
      },
      {
        kind: "data",
        id: "dst",
        title: t("glossary_page.fields.translation"),
        align: "left",
        sortable: {},
        head_class_name: "glossary-page__table-translation-head",
        cell_class_name: "glossary-page__table-translation-cell",
        render_cell: (payload) => {
          return <span className="glossary-page__table-text">{payload.row.entry.dst}</span>;
        },
      },
      {
        kind: "data",
        id: "info",
        title: t("glossary_page.fields.description"),
        align: "left",
        sortable: {},
        head_class_name: "glossary-page__table-description-head",
        cell_class_name: "glossary-page__table-description-cell",
        render_cell: (payload) => (
          <span className="glossary-page__table-text">{payload.row.entry.info}</span>
        ),
      },
      {
        kind: "data",
        id: "rule",
        title: t("quality_rule_editor.fields.rule"),
        width: 96,
        align: "center",
        sortable: {},
        head_class_name: "glossary-page__table-rule-head",
        cell_class_name: "glossary-page__table-rule-cell",
        render_cell: (payload) => {
          const case_tooltip = t("app.tooltip.value", {
            TITLE: t("quality_rule_editor.rule.case_sensitive"),
            VALUE: t(payload.row.entry.case_sensitive ? "app.state.enabled" : "app.state.disabled"),
          });

          return (
            <GlossaryRuleBadge enabled={payload.row.entry.case_sensitive} tooltip={case_tooltip} />
          );
        },
      },
      {
        kind: "data",
        id: "hit",
        title: t("quality_rule_editor.fields.hit"),
        width: 120,
        align: "center",
        sortable: {
          disabled: !props.hit_sort_available,
        },
        head_class_name: "glossary-page__table-hit-head",
        cell_class_name: "glossary-page__table-hit-cell",
        render_cell: (payload) => {
          if (payload.presentation === "overlay") {
            return null;
          }

          return (
            <QualityRuleHitBadge
              entry_id={payload.row_id}
              running={false}
              badge_state={props.hit_badge_by_entry_id[payload.row_id] ?? null}
              on_query_entry_source={props.on_query_entry_source}
              on_search_entry_relations={props.on_search_entry_relations}
            />
          );
        },
      },
    ];
    return desktop_columns;
  }, [
    props.on_query_entry_source,
    props.on_search_entry_relations,
    props.hit_badge_by_entry_id,
    props.hit_sort_available,
    t,
  ]);

  const selected_columns = columns.filter((column) => visible_columns.includes(column.id));
  const table_columns = selected_columns;
  return (
    <Card variant="table" className="glossary-page__table-card">
      <CardContent className="glossary-page__table-card-content">
        <div className="glossary-page__column-bar">
          <AppDropdownMenu>
            <AppDropdownMenuTrigger
              render={
                <AppButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="glossary-page__columns-trigger"
                />
              }
            >
              <Columns3 aria-hidden="true" />
              {t("glossary_page.columns")}
            </AppDropdownMenuTrigger>
            <AppDropdownMenuContent
              align="end"
              className="glossary-page__columns-menu"
              matchTriggerWidth={false}
            >
              {columns.map((column) => (
                <AppDropdownMenuCheckboxItem
                  key={column.id}
                  className="glossary-page__column-option"
                  checked={visible_columns.includes(column.id)}
                  disabled={visible_columns.length === 1 && visible_columns.includes(column.id)}
                  onCheckedChange={(checked) => {
                    set_visible_columns((current) =>
                      checked ? [...current, column.id] : current.filter((id) => id !== column.id),
                    );
                  }}
                >
                  {column.title}
                </AppDropdownMenuCheckboxItem>
              ))}
            </AppDropdownMenuContent>
          </AppDropdownMenu>
        </div>
        <div className="glossary-page__table-grid">
          <AppTable
            {...(is_narrow ? { row_height: 52 } : {})}
            rows={props.entries}
            columns={table_columns}
            selection_mode="multiple"
            selected_row_ids={props.selected_entry_ids}
            active_row_id={props.active_entry_id}
            anchor_row_id={props.anchor_entry_id}
            sort_state={props.sort_state}
            get_row_id={(entry) => entry.entry_id}
            scroll_to_row={
              props.restore_scroll_entry_id === null
                ? undefined
                : { row_id: props.restore_scroll_entry_id, revision: 0 }
            }
            on_selection_change={props.on_selection_change}
            on_sort_change={props.on_sort_change}
            on_reorder={props.on_reorder}
            reorder_disabled={props.reorder_disabled}
            on_row_activate={props.on_open_edit}
            render_row_context_menu_items={(payload) => {
              const target_entry_ids = payload.target_row_ids;
              const case_sensitive_state = resolve_quality_rule_boolean_menu_state({
                entry_by_id: visible_entry_by_id,
                target_entry_ids,
                pick_value: (entry) => entry.entry.case_sensitive,
              });

              return (
                <GlossaryContextMenuItems
                  case_sensitive_state={case_sensitive_state}
                  readonly={props.readonly}
                  on_open_edit={() => {
                    props.on_open_edit(payload.row_id);
                  }}
                  on_toggle_case_sensitive={props.on_toggle_case_sensitive}
                />
              );
            }}
            box_selection_enabled
            table_class_name="glossary-page__table"
            className={is_narrow && table_columns.length > 3 ? "glossary-page__wide-table" : ""}
            row_class_name={() => "glossary-page__table-row"}
          />
        </div>
      </CardContent>
    </Card>
  );
}
