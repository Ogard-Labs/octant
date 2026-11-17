import { ChevronRight, type IconComponent } from "../ui/icons";
import { useCallback, useId, useState, type ReactNode, type Ref } from "react";
import {
  EnvironmentSectionFoldedContext,
  EnvironmentSectionReportContext,
  summaryOfReports,
  useEnvironmentSectionFold,
  type SectionReport,
} from "./environmentSections";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * The glyph tile every Environment row leads with. The glyph is decoration:
 * the row's title names it.
 */
export function EnvironmentTile(props: { readonly icon: IconComponent }) {
  return (
    <span aria-hidden="true" className="environment-tile">
      <props.icon size={16} />
    </span>
  );
}

/**
 * One Environment row: a 16px glyph, the name, and a plain muted detail at the
 * trailing edge. With `onClick` it is a button that fills on hover and shows a
 * chevron there; without, it states a fact. The name gives way first when the
 * line is short, the detail never. `title` carries what the line cannot hold.
 */
export function EnvironmentRow(props: {
  readonly icon: IconComponent;
  readonly label: string;
  readonly detail?: ReactNode;
  /** Muted text after the name on the same line, cut first when the line is short. */
  readonly path?: string | undefined;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly muted?: boolean;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      <EnvironmentTile icon={props.icon} />
      <span className="environment-row__title">{props.label}</span>
      {props.path === undefined ? null : (
        <span className="environment-row__path">
          <span aria-hidden="true"> · </span>
          {props.path}
        </span>
      )}
      {props.detail === undefined ? null : (
        <span className="environment-row__detail">{props.detail}</span>
      )}
    </>
  );
  if (props.onClick === undefined) {
    return (
      <p
        aria-label={props.ariaLabel}
        className="environment-row"
        data-muted={props.muted === true ? "true" : undefined}
        title={props.title}
      >
        {content}
      </p>
    );
  }
  return (
    <OctantButton
      aria-label={props.ariaLabel}
      className="environment-row environment-link window-no-drag"
      onClick={props.onClick}
      title={props.title}
      type="button"
      variant="bare"
    >
      {content}
      <ChevronRight aria-hidden="true" className="environment-row__trailing" size={14} />
    </OctantButton>
  );
}

/**
 * A captioned section of Environment rows: a muted label, then the rows, with
 * a hairline above the section rather than a box around it.
 *
 * Given a `foldId` too, the caption is a button that folds the section away.
 * Folded, the section is its caption, a chevron and a short summary at the
 * right edge, so a strip of folded sections still says the state of each. The
 * rows stay mounted, so what they report (and what they poll) goes on; the
 * `hidden` attribute is what takes them out of the tab order and the reading
 * order.
 */
export function EnvironmentCard(props: {
  /** Absent for a card that needs no heading of its own. */
  readonly caption?: string;
  /** Names the section among the folds a person chose; with a caption, makes it foldable. */
  readonly foldId?: string;
  /** What a folded section says, when the card knows it; else what its rows report. */
  readonly summary?: string | undefined;
  /** A small mark drawn after the summary, for a figure that is also a share. */
  readonly summaryMark?: ReactNode;
  /**
   * One small control at the right end of the title row (a "…" menu). It sits
   * beside the fold button, never inside it, so pressing it cannot fold the
   * section; folded, the row is only its title and summary and the control is
   * gone.
   */
  readonly titleAction?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  if (props.caption !== undefined && props.foldId !== undefined) {
    return <FoldableEnvironmentCard {...props} caption={props.caption} foldId={props.foldId} />;
  }
  return <PlainEnvironmentCard {...props} />;
}

function PlainEnvironmentCard(props: {
  readonly caption?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const captionId = useId();
  return (
    <div
      aria-labelledby={props.caption === undefined ? undefined : captionId}
      className={
        props.className === undefined ? "environment-card" : `environment-card ${props.className}`
      }
      role={props.caption === undefined ? undefined : "group"}
    >
      {props.caption === undefined ? null : (
        <p className="environment-card__caption" id={captionId}>
          {props.caption}
        </p>
      )}
      <div className="environment-card__rows">{props.children}</div>
    </div>
  );
}

function FoldableEnvironmentCard(props: {
  readonly caption: string;
  readonly foldId: string;
  readonly summary?: string | undefined;
  readonly summaryMark?: ReactNode;
  readonly titleAction?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const captionId = useId();
  const rowsId = useId();
  const summaryId = useId();
  const [folded, toggle] = useEnvironmentSectionFold(props.foldId);
  const [reports, setReports] = useState<ReadonlyMap<string, SectionReport>>(() => new Map());
  const report = useCallback((key: string, next: SectionReport | undefined) => {
    setReports((current) => {
      const existing = current.get(key);
      if (existing === undefined && next === undefined) return current;
      if (existing !== undefined && next !== undefined && sameReport(existing, next)) {
        return current;
      }
      const updated = new Map(current);
      if (next === undefined) updated.delete(key);
      else updated.set(key, next);
      return updated;
    });
  }, []);
  const summary = props.summary ?? summaryOfReports(reports);
  const showSummary = folded && summary !== undefined;
  return (
    <EnvironmentSectionReportContext.Provider value={report}>
      <div
        aria-labelledby={captionId}
        className={
          props.className === undefined ? "environment-card" : `environment-card ${props.className}`
        }
        data-folded={folded ? "true" : undefined}
        role="group"
      >
        <div className="environment-card__head">
          <OctantButton
            aria-controls={rowsId}
            aria-describedby={showSummary ? summaryId : undefined}
            aria-expanded={!folded}
            aria-labelledby={captionId}
            className="environment-card__caption environment-card__toggle window-no-drag"
            onClick={toggle}
            type="button"
            variant="bare"
          >
            <span className="environment-card__title" id={captionId}>
              {props.caption}
            </span>
            <ChevronRight aria-hidden="true" className="environment-card__chevron" size={12} />
            {showSummary ? (
              <span className="environment-card__summary" id={summaryId}>
                {summary}
                {props.summaryMark}
              </span>
            ) : null}
          </OctantButton>
          {folded || props.titleAction === undefined ? null : (
            <span className="environment-card__title-action">{props.titleAction}</span>
          )}
        </div>
        <div className="environment-card__rows" hidden={folded} id={rowsId}>
          <EnvironmentSectionFoldedContext.Provider value={folded}>
            {props.children}
          </EnvironmentSectionFoldedContext.Provider>
        </div>
      </div>
    </EnvironmentSectionReportContext.Provider>
  );
}

function sameReport(a: SectionReport, b: SectionReport): boolean {
  if (a.kind === "running" && b.kind === "running") return a.count === b.count;
  if (a.kind === "summary" && b.kind === "summary") return a.text === b.text;
  return false;
}

export interface EnvironmentGroupProps {
  readonly title: string;
  /** The row's glyph; every Environment row leads with one so titles align. */
  readonly icon?: IconComponent;
  /** Short trailing summary shown on the header row (e.g. "+102 −0"). */
  readonly summary?: ReactNode;
  /**
   * False for a group with nothing to open: it draws its title and value as a
   * plain row, with no chevron and no button, so a reader is never sent to an
   * opened body that only repeats the value.
   */
  readonly expandable?: boolean;
  /** A tooltip on the header row for what the row cannot hold (a caveat the body leaves out). */
  readonly hint?: string;
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
  /** Lets a parent react to open/close, e.g. to pause polling while collapsed. */
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * The one thing this section's facts let a reader do next, rendered beside
   * the title. Rendered outside the disclosure control because a control
   * nested inside a button is not reachable as its own control.
   */
  readonly action?: ReactNode;
  /** The disclosure button, for a parent that returns keyboard focus to this row. */
  readonly headerRef?: Ref<HTMLButtonElement>;
  readonly children: ReactNode;
}

/**
 * Collapsible section of the thread Environment rail. Children mount only
 * while the group is open, so a collapsed Files or Local servers group does
 * not fetch or poll in the background.
 */
export function EnvironmentGroup(props: EnvironmentGroupProps) {
  const [storedOpen, setOpen] = useState(props.defaultOpen === true);
  const open = props.open ?? storedOpen;
  const onOpenChange = props.onOpenChange;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };
  if (props.expandable === false) {
    return (
      <section className="environment-group">
        <p className="environment-group__header environment-group__header--static">
          {props.icon === undefined ? null : <EnvironmentTile icon={props.icon} />}
          <span className="environment-group__title">{props.title}</span>
          {props.summary === undefined ? null : (
            <span className="environment-group__summary"> {props.summary}</span>
          )}
        </p>
      </section>
    );
  }
  return (
    <section className={`environment-group${open ? " environment-group--open" : ""}`}>
      <div className="environment-group__head">
        <OctantButton
          aria-expanded={open}
          aria-label={
            typeof props.summary === "string" ? `${props.title} ${props.summary}` : undefined
          }
          className="environment-group__header window-no-drag"
          onClick={toggle}
          ref={props.headerRef}
          title={props.hint}
          type="button"
          variant="bare"
        >
          {props.icon === undefined ? null : <EnvironmentTile icon={props.icon} />}
          <span className="environment-group__title">{props.title}</span>
          {props.summary === undefined ? null : (
            <span className="environment-group__summary"> {props.summary}</span>
          )}
          {/* Trailing, where the eye ends the row: a leading chevron pushed
              every title a step right of the rows that have none. */}
          <ChevronRight aria-hidden="true" className="environment-group__chevron" size={14} />
        </OctantButton>
        {props.action === undefined ? null : (
          <span className="environment-group__head-action">{props.action}</span>
        )}
      </div>
      {open ? <div className="environment-group__body">{props.children}</div> : null}
    </section>
  );
}
