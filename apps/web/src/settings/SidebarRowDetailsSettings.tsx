import type { ShellSettings } from "@octant/contracts";
import { useEffect, useRef } from "react";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";

type RowProperties = ShellSettings["sidebarRowProperties"];
type List = keyof RowProperties;

interface Detail {
  readonly key: "project" | "branch" | "pullRequest" | "lastUpdated" | "status";
  readonly label: string;
  readonly hint: string;
  readonly settingSlug: string;
  /** The lists that can show it; absent means both. */
  readonly lists?: ReadonlyArray<List>;
}

const DETAILS: ReadonlyArray<Detail> = [
  {
    key: "project",
    label: "Project",
    hint: "The Project it belongs to",
    settingSlug: "project",
    lists: ["activity"],
  },
  { key: "branch", label: "Branch", hint: "Its branch or worktree", settingSlug: "branch" },
  {
    key: "pullRequest",
    label: "Pull request",
    hint: "Its pull request and state",
    settingSlug: "pull-request",
  },
  {
    key: "lastUpdated",
    label: "Last updated",
    hint: "How long ago it moved",
    settingSlug: "last-updated",
  },
  { key: "status", label: "Status", hint: "Working, waiting, or unread", settingSlug: "status" },
];

const LISTS: ReadonlyArray<{ readonly list: List; readonly label: string }> = [
  { list: "projects", label: "Projects" },
  { list: "activity", label: "Activity" },
];

function settingIdFor(list: List, detail: Detail): string {
  return `sidebar-${list}-${detail.settingSlug}`;
}

/**
 * What a thread row in the sidebar shows, as one grid: a detail per row, a
 * sidebar list per column. Nine switches stacked one per row said the same
 * five facts twice. A Projects row sits under its Project and never names it,
 * so that cell is empty rather than a checkbox that does nothing.
 */
export function SidebarRowDetailsSettings(props: {
  readonly value: RowProperties;
  readonly onChange: (next: RowProperties) => void;
  /** A search result or link named one cell: land on its checkbox. */
  readonly focusedSetting?: string | undefined;
}) {
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const focused = props.focusedSetting;
    if (focused === undefined || tableRef.current === null) return;
    const control = tableRef.current.querySelector<HTMLInputElement>(
      `input[data-setting-id="${CSS.escape(focused)}"]`,
    );
    if (control === null) return;
    control.focus();
    control.scrollIntoView?.({ block: "center" });
  }, [props.focusedSetting]);

  return (
    <table className="sidebar-row-details" ref={tableRef}>
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Detail</span>
          </th>
          {LISTS.map(({ list, label }) => (
            <th key={list} scope="col">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {DETAILS.map((detail) => (
          <tr key={detail.key}>
            <th scope="row">
              <span className="sidebar-row-details__label">{detail.label}</span>
              <span className="sidebar-row-details__hint">{detail.hint}</span>
            </th>
            {LISTS.map(({ list, label }) => {
              const offered = detail.lists === undefined || detail.lists.includes(list);
              const current = offered ? props.value[list][detail.key] : undefined;
              return (
                <td key={list}>
                  {current === undefined ? null : (
                    <OctantCheckbox
                      aria-label={`${detail.label} on ${label} rows`}
                      checked={current}
                      data-setting-id={settingIdFor(list, detail)}
                      onChange={(event) =>
                        props.onChange({
                          ...props.value,
                          [list]: {
                            ...props.value[list],
                            [detail.key]: event.currentTarget.checked,
                          },
                        })
                      }
                    />
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
