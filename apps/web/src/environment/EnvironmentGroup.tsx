import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface EnvironmentGroupProps {
  readonly title: string;
  /** Short trailing summary shown on the header row (e.g. "+102 −0"). */
  readonly summary?: ReactNode;
  readonly defaultOpen?: boolean;
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
  const [open, setOpen] = useState(props.defaultOpen === true);
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
          className="environment-group__header window-no-drag"
          onClick={toggle}
          type="button"
          variant="ghost"
        >
          <ChevronRight
            aria-hidden="true"
            className="environment-group__chevron"
            size={14}
            strokeWidth={2}
          />
          <span className="environment-group__title">{props.title}</span>
          {props.summary === undefined ? null : (
            <span className="environment-group__summary">{props.summary}</span>
          )}
        </OctantButton>
        {props.action === undefined ? null : (
          <span className="environment-group__head-action">{props.action}</span>
        )}
      </div>
      {open ? <div className="environment-group__body">{props.children}</div> : null}
    </section>
  );
}
