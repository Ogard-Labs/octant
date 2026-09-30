import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { OctantButton, OctantIconButton } from "./OctantButton";

export interface OctantToastProps {
  readonly title: string;
  readonly detail: string;
  readonly tone?: "neutral" | "success" | "warning" | "danger";
  readonly action?: {
    readonly label: string;
    readonly onSelect: () => void;
  };
  readonly onDismiss: () => void;
}

export function OctantToast({
  title,
  detail,
  tone = "neutral",
  action,
  onDismiss,
}: OctantToastProps) {
  const Icon =
    tone === "success"
      ? CircleCheck
      : tone === "warning" || tone === "danger"
        ? TriangleAlert
        : Info;
  return (
    <div className="toast" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <Icon aria-hidden="true" className="toast__icon" size={16} strokeWidth={1.8} />
      <div className="toast__content">
        <strong className="toast-title">{title}</strong>
        <p>
          {detail}
          {action === undefined ? null : (
            <>
              {" "}
              <OctantButton
                className="toast__action"
                onClick={action.onSelect}
                type="button"
                variant="link"
              >
                {action.label}
                <span aria-hidden="true">↗</span>
              </OctantButton>
            </>
          )}
        </p>
      </div>
      <OctantIconButton
        className="toast__dismiss"
        label="Dismiss notification"
        onClick={onDismiss}
        size="icon"
        type="button"
      >
        <X aria-hidden="true" size={14} />
      </OctantIconButton>
    </div>
  );
}
