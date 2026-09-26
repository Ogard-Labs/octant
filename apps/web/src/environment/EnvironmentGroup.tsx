import { ChevronRight, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface EnvironmentGroupProps {
  readonly title: string;
  /** The row's glyph; every Environment row leads with one so titles align. */
  readonly icon?: LucideIcon;
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
          type="button"
          variant="link"
        >
          {props.icon === undefined ? null : (
            <props.icon
              aria-hidden="true"
              className="environment-group__icon"
              size={16}
              strokeWidth={1.7}
            />
          )}
          <span className="environment-group__title">{props.title}</span>
          {props.summary === undefined ? null : (
            <span className="environment-group__summary"> {props.summary}</span>
          )}
          {/* Trailing, where the eye ends the row: a leading chevron pushed
              every title a step right of the rows that have none. */}
          <ChevronRight
            aria-hidden="true"
            className="environment-group__chevron"
            size={14}
            strokeWidth={1.8}
          />
        </OctantButton>
        {props.action === undefined ? null : (
          <span className="environment-group__head-action">{props.action}</span>
        )}
      </div>
      {open ? <div className="environment-group__body">{props.children}</div> : null}
    </section>
  );
}
