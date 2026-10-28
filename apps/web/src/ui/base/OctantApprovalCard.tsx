import { CirclePause } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../shadcn/utils";

export interface OctantApprovalCardProps {
  readonly label: string;
  readonly summary: ReactNode;
  readonly detail?: ReactNode;
  /**
   * What a person should read before answering, placed ahead of the answer
   * controls in both layout and reading order.
   */
  readonly context?: ReactNode;
  /** Absent on a card this window may read but not answer. */
  readonly actions?: ReactNode;
  readonly error?: string | undefined;
  readonly children?: ReactNode;
  readonly className?: string;
}

export function OctantApprovalCard(props: OctantApprovalCardProps) {
  return (
    <section
      aria-label={props.label}
      className={cn("approval-row approval-row--request", props.className)}
      role="group"
    >
      <CirclePause aria-hidden="true" size={14} strokeWidth={1.8} />
      <span className="approval-row__text">
        {props.summary}
        {props.detail === undefined ? null : (
          <span className="approval-row__detail">{props.detail}</span>
        )}
      </span>
      {props.context}
      {props.actions === undefined ? null : (
        <div className="approval-row__actions">{props.actions}</div>
      )}
      {props.children}
      {props.error === undefined ? null : (
        <p className="approval-row__error" role="alert">
          {props.error}
        </p>
      )}
    </section>
  );
}
