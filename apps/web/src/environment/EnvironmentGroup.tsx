import { ChevronRight, type IconComponent } from "../ui/icons";
import { useId, useState, type ReactNode, type Ref } from "react";
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
 */
export function EnvironmentCard(props: {
  /** Absent for a card that needs no heading of its own. */
  readonly caption?: string;
  readonly children: ReactNode;
}) {
  const captionId = useId();
  return (
    <div
      aria-labelledby={props.caption === undefined ? undefined : captionId}
      className="environment-card"
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

export interface EnvironmentGroupProps {
  readonly title: string;
  /** The row's glyph; every Environment row leads with one so titles align. */
  readonly icon?: IconComponent;
  /** Short trailing summary shown on the header row (e.g. "+102 −0"). */
  readonly summary?: ReactNode;
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
