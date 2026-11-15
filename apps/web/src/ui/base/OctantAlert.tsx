import { CircleAlert, CircleCheck, Info, TriangleAlert } from "../icons";
import type { ReactNode } from "react";
import { cn } from "../shadcn/utils";

export interface OctantAlertProps {
  readonly children: ReactNode;
  readonly title?: string;
  readonly action?: ReactNode;
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  readonly role?: "alert" | "status";
  /**
   * "card" is the floating notice; "row" is a quiet line inside a panel: the
   * tone's icon, one sentence and an action, no fill, no outline and no card.
   */
  readonly layout?: "card" | "row";
  readonly className?: string;
  readonly id?: string;
  /** Names the alert for assistive technology when its words alone do not. */
  readonly label?: string;
  readonly testId?: string;
}

export function OctantAlert({
  children,
  title,
  action,
  tone = "neutral",
  role = tone === "warning" || tone === "danger" ? "alert" : "status",
  layout = "card",
  className,
  id,
  label,
  testId,
}: OctantAlertProps) {
  const Icon =
    tone === "success"
      ? CircleCheck
      : tone === "danger"
        ? TriangleAlert
        : tone === "warning"
          ? CircleAlert
          : Info;
  return (
    <div
      className={cn("callout", layout === "row" && "callout--row", className)}
      data-tone={tone}
      {...(id === undefined ? {} : { id })}
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      role={role}
    >
      <Icon aria-hidden="true" size={16} />
      <div className="callout__body">
        {title === undefined ? null : <p className="callout-title">{title}</p>}
        {children}
      </div>
      {action === undefined ? null : <div className="callout__actions">{action}</div>}
    </div>
  );
}
