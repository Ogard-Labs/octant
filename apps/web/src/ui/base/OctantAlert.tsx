import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../shadcn/utils";

export interface OctantAlertProps {
  readonly children: ReactNode;
  readonly title?: string;
  readonly action?: ReactNode;
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  readonly role?: "alert" | "status";
  readonly className?: string;
  readonly id?: string;
  readonly testId?: string;
}

export function OctantAlert({
  children,
  title,
  action,
  tone = "neutral",
  role = tone === "warning" || tone === "danger" ? "alert" : "status",
  className,
  id,
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
      className={cn("callout", className)}
      data-tone={tone}
      {...(id === undefined ? {} : { id })}
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
