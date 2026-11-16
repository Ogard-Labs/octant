import { useEffect, useRef, useState } from "react";
import { CircleCheck, Info, TriangleAlert, X } from "../icons";
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
  /**
   * A notice that only reports something done leaves by itself after this
   * long, as if dismissed. It stays while the pointer or the keyboard is on
   * it, and a notice the person must act on never sets it. A notice that
   * stayed until dismissed stood over the top of the pane under it for as long
   * as the person did not go and close it.
   */
  readonly leavesAfterMs?: number;
}

export function OctantToast({
  title,
  detail,
  tone = "neutral",
  action,
  onDismiss,
  leavesAfterMs,
}: OctantToastProps) {
  const [held, setHeld] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (leavesAfterMs === undefined || held) return;
    const timer = window.setTimeout(() => dismiss.current(), leavesAfterMs);
    return () => window.clearTimeout(timer);
  }, [held, leavesAfterMs]);
  const hold =
    leavesAfterMs === undefined
      ? {}
      : {
          onBlur: () => setHeld(false),
          onFocus: () => setHeld(true),
          onPointerEnter: () => setHeld(true),
          onPointerLeave: () => setHeld(false),
        };
  const Icon =
    tone === "success"
      ? CircleCheck
      : tone === "warning" || tone === "danger"
        ? TriangleAlert
        : Info;
  return (
    <div className="toast" data-tone={tone} role={tone === "danger" ? "alert" : "status"} {...hold}>
      <Icon aria-hidden="true" className="toast__icon" size={16} />
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
        size="icon-sm"
        type="button"
      >
        <X aria-hidden="true" size={14} />
      </OctantIconButton>
    </div>
  );
}
