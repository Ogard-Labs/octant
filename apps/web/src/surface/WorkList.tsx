import type { LucideIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import { ArrowUpDown } from "lucide-react";
import { compactRelativeTimeLabel } from "../lib/relativeTime";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { OctantTooltip } from "../ui/base/OctantTooltip";

/**
 * The list the pull-request and issue places share: two-line rows, a slim group
 * head and the header's icon menus. Both lists draw the same row so a person
 * learns one list.
 */

export interface WorkListState {
  readonly label: string;
  readonly tone: "open" | "draft" | "merged" | "closed";
  readonly Icon: LucideIcon;
}

export interface WorkListRowProps {
  readonly title: string;
  readonly state: WorkListState;
  /** Named on the meta line; leave it out where the list is of one repository. */
  readonly repository?: string;
  readonly author: string;
  readonly updatedAt: string;
  readonly number: number;
  /** At the trailing edge of the title line: what needs attention, if anything. */
  readonly trailing?: ReactNode;
  /** After the age on the meta line: quiet marks such as a linked thread. */
  readonly extras?: ReactNode;
  /** Text only a screen reader gets: the facts the row leaves out of sight. */
  readonly description?: string;
  /**
   * Opens on hover and on keyboard focus of the whole row, so what the row
   * leaves out is not a pointer-only fact.
   */
  readonly tooltip?: ReactNode;
  readonly selected: boolean;
  /** How the shell marks the row it has open. */
  readonly selection: "pressed" | "current";
  /** Receives `id`, so a parent can pass one stable callback to every row. */
  readonly id: string;
  readonly onSelect: (id: string) => void;
}

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

/**
 * One item: the title, then one quiet line of where it lives and how old it
 * is. The row is the only control; what opening it does is the caller's.
 */
export const WorkListRow = memo(function WorkListRow(props: WorkListRowProps) {
  const { Icon } = props.state;
  const selection =
    props.selection === "pressed"
      ? { "aria-pressed": props.selected }
      : { "aria-current": props.selected ? ("true" as const) : undefined };
  const button = (
    <OctantButton
      {...selection}
      className="work-list__row"
      onClick={() => props.onSelect(props.id)}
      type="button"
      variant="bare"
    >
      <span className="work-list__title" title={props.title}>
        {props.title}
      </span>
      <span className="work-list__status-cell">{props.trailing}</span>
      <span className="work-list__meta">
        <span
          aria-label={props.state.label}
          className="work-list__state"
          data-state={props.state.tone}
          role="img"
        >
          <Icon aria-hidden="true" size={14} strokeWidth={1.7} />
        </span>
        {props.repository === undefined ? null : (
          <span className="work-list__meta-text">{props.repository}</span>
        )}
        <span className="work-list__meta-text">{props.author}</span>
        <time
          className="work-list__meta-text"
          dateTime={props.updatedAt}
          title={formatUpdatedAt(props.updatedAt)}
        >
          {compactRelativeTimeLabel(props.updatedAt)}
        </time>
        {props.extras}
      </span>
      <span className="work-list__number">#{props.number}</span>
      {props.description === undefined ? null : (
        <span className="sr-only">{props.description}</span>
      )}
    </OctantButton>
  );
  return props.tooltip === undefined ? (
    button
  ) : (
    <OctantTooltip label={props.tooltip} side="top">
      {button}
    </OctantTooltip>
  );
});

export function WorkList(props: { readonly ariaLabel?: string; readonly children: ReactNode }) {
  return (
    <ul
      {...(props.ariaLabel === undefined ? {} : { "aria-label": props.ariaLabel })}
      className="work-list__list"
    >
      {props.children}
    </ul>
  );
}

/** A repository's slim header: its name, the count, any marks, then its menu. */
export function WorkListGroup(props: {
  readonly title: string;
  readonly count: number;
  /** Quiet marks beside the count, such as a permission that is on. */
  readonly marks?: ReactNode;
  /** The group's "..." menu, at the trailing edge. */
  readonly menu?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="work-list__group">
      <div className="work-list__group-head">
        <h2 className="work-list__group-title">{props.title}</h2>
        <span className="oct-meta work-list__group-count">{props.count}</span>
        {props.marks}
        {props.menu}
      </div>
      {props.children}
    </section>
  );
}

/**
 * A header icon button that opens a menu, with a tooltip. `active` puts a dot
 * on it: a narrowing filter or a permission that is on says so while the menu
 * is closed.
 */
export function WorkListMenuTrigger(props: {
  readonly label: string;
  readonly tooltip: string;
  readonly active?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <OctantTooltip label={props.tooltip}>
      <OctantMenuTrigger
        aria-label={props.label}
        className={`${octantButtonClassName({ variant: "ghost", size: "icon" })} work-list__icon-button`}
      >
        {props.children}
        {props.active === true ? (
          <span aria-hidden="true" className="work-list__active-dot" />
        ) : null}
      </OctantMenuTrigger>
    </OctantTooltip>
  );
}

/** Sort by one of the options and, where the data supports it, group by repository. */
export function WorkListSortMenu<T extends string>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  /** Absent where grouping by repository means nothing (one repository). */
  readonly grouped?: boolean;
  readonly onGroupedChange?: (grouped: boolean) => void;
}) {
  return (
    <OctantMenuRoot>
      <WorkListMenuTrigger label={props.label} tooltip="Sort and group">
        <ArrowUpDown aria-hidden="true" size={16} strokeWidth={1.5} />
      </WorkListMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
          <OctantMenuPopup aria-label={props.label} className="min-w-56">
            <OctantMenuGroup>
              <OctantMenuGroupLabel>Sort by</OctantMenuGroupLabel>
              <OctantMenuRadioGroup
                onValueChange={(value) => {
                  const next = props.options.find((option) => option.value === value);
                  if (next !== undefined) props.onValueChange(next.value);
                }}
                value={props.value}
              >
                {props.options.map((option) => (
                  <OctantMenuRadioItem
                    closeOnClick
                    key={option.value}
                    label={option.label}
                    value={option.value}
                  >
                    {option.label}
                  </OctantMenuRadioItem>
                ))}
              </OctantMenuRadioGroup>
            </OctantMenuGroup>
            {props.onGroupedChange === undefined ? null : (
              <>
                <OctantMenuSeparator />
                <OctantMenuCheckboxItem
                  checked={props.grouped === true}
                  closeOnClick={false}
                  label="Group by repository"
                  onCheckedChange={(checked) => props.onGroupedChange?.(checked)}
                >
                  Group by repository
                </OctantMenuCheckboxItem>
              </>
            )}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}
