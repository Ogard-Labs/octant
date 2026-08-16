import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

export interface EnvironmentGroupProps {
  readonly title: string;
  /** Short trailing summary shown on the header row (e.g. "+102 −0"). */
  readonly summary?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}

/**
 * Collapsible section of the thread Environment rail. Children mount only
 * while the group is open, so a collapsed Files or Local servers group does
 * not fetch or poll in the background.
 */
export function EnvironmentGroup(props: EnvironmentGroupProps) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <section className={`environment-group${open ? " environment-group--open" : ""}`}>
      <button
        aria-expanded={open}
        className="environment-group__header window-no-drag"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className="environment-group__chevron"
          size={13}
          strokeWidth={2}
        />
        <span className="environment-group__title">{props.title}</span>
        {props.summary === undefined ? null : (
          <span className="environment-group__summary">{props.summary}</span>
        )}
      </button>
      {open ? <div className="environment-group__body">{props.children}</div> : null}
    </section>
  );
}
