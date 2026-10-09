import { CircleAlert, Hand, Info, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import type { DeviceProblem } from "./deviceModel";

/**
 * The one line under the toolbar. At most one shows at a time, in this order:
 * an error, the input approval, typing, then a notice. Each is one sentence
 * with at most one action, plus a way to put it away where that makes sense.
 */
export type DeviceLineContent =
  | { readonly kind: "error"; readonly problem: DeviceProblem; readonly onDismiss: () => void }
  | {
      readonly kind: "approval";
      readonly deviceName: string;
      readonly onAllow: () => void;
      readonly onNotNow: () => void;
      readonly focusAllow: boolean;
    }
  | {
      readonly kind: "type";
      readonly deviceName: string;
      readonly onSend: (text: string) => void;
      readonly onClose: () => void;
    }
  | { readonly kind: "notice"; readonly problem: DeviceProblem };

export function DeviceLine(props: { readonly content: DeviceLineContent }) {
  const { content } = props;
  if (content.kind === "error") {
    return (
      /* ui-boundary-exception: compact-status */
      <div className="device-line device-line--error" role="alert">
        <CircleAlert aria-hidden="true" className="device-line__mark" size={16} />
        <span className="device-line__message">{content.problem.message}</span>
        {content.problem.fix === undefined ? null : (
          <OctantButton onClick={content.problem.fix.run} size="sm" type="button" variant="outline">
            {content.problem.fix.label}
          </OctantButton>
        )}
        <OctantIconButton label="Dismiss" onClick={content.onDismiss} size="icon-sm" type="button">
          <X aria-hidden="true" size={14} />
        </OctantIconButton>
      </div>
    );
  }
  if (content.kind === "approval") return <ApprovalLine content={content} />;
  if (content.kind === "type") return <TypeLine content={content} />;
  return (
    <div className="device-line" role="status">
      <Info aria-hidden="true" className="device-line__mark" size={16} />
      <span className="device-line__message">{content.problem.message}</span>
      {content.problem.fix === undefined ? null : (
        <OctantButton onClick={content.problem.fix.run} size="sm" type="button" variant="outline">
          {content.problem.fix.label}
        </OctantButton>
      )}
    </div>
  );
}

function ApprovalLine(props: {
  readonly content: Extract<DeviceLineContent, { kind: "approval" }>;
}) {
  const { content } = props;
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (content.focusAllow) allowRef.current?.focus();
  }, [content.focusAllow]);
  return (
    <div className="device-line device-line--approval" role="status">
      <Hand aria-hidden="true" className="device-line__mark" size={16} />
      <span className="device-line__message">
        Allow input on <strong>{content.deviceName}</strong>?
      </span>
      {/* Allow opens Octant's own confirmation, which is what issues the
          grant. This button only asks for it. */}
      <OctantButton onClick={content.onAllow} ref={allowRef} size="sm" type="button">
        Allow
      </OctantButton>
      <OctantButton onClick={content.onNotNow} size="sm" type="button" variant="ghost">
        Not now
      </OctantButton>
    </div>
  );
}

function TypeLine(props: { readonly content: Extract<DeviceLineContent, { kind: "type" }> }) {
  const { content } = props;
  const [text, setText] = useState("");
  const inputId = useId();
  const send = () => {
    if (text.length === 0) return;
    content.onSend(text);
    setText("");
  };
  return (
    <form
      aria-label={`Type text on ${content.deviceName}`}
      className="device-line device-line--type"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Text to type on {content.deviceName}
      </label>
      <OctantInput
        autoComplete="off"
        // The person asked to type, so the field takes the keys at once.
        autoFocus
        className="device-line__field"
        id={inputId}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          content.onClose();
        }}
        placeholder={`Type on ${content.deviceName}`}
        type="text"
        value={text}
      />
      <OctantButton disabled={text.length === 0} size="sm" type="submit">
        Send
      </OctantButton>
      <OctantIconButton label="Close typing" onClick={content.onClose} size="icon-sm" type="button">
        <X aria-hidden="true" size={14} />
      </OctantIconButton>
    </form>
  );
}
