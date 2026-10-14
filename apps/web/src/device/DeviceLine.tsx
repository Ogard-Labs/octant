import { CircleAlert, Hand, Info, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { deviceOpenUrlFrom, type DeviceProblem } from "./deviceModel";

/**
 * The one line under the toolbar. At most one shows at a time, in this order:
 * an address being entered to open, an error, a notice that the live view is
 * off, the input approval, typing, then any other notice. Each is one sentence
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
  | {
      readonly kind: "open-url";
      readonly deviceName: string;
      readonly onOpen: (url: string) => void;
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
  if (content.kind === "open-url") return <OpenUrlLine content={content} />;
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

function OpenUrlLine(props: {
  readonly content: Extract<DeviceLineContent, { kind: "open-url" }>;
}) {
  const { content } = props;
  const [text, setText] = useState("");
  const [refused, setRefused] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const open = () => {
    const url = deviceOpenUrlFrom(text);
    if (url === undefined) {
      setRefused(true);
      return;
    }
    content.onOpen(url);
  };
  return (
    <form
      aria-label={`Open a URL on ${content.deviceName}`}
      className="device-line device-line--type"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        open();
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Address to open on {content.deviceName}
      </label>
      <OctantInput
        {...(refused ? { "aria-describedby": hintId, "aria-invalid": true } : {})}
        autoComplete="off"
        // The person asked to open an address, so the field takes the keys at once.
        autoFocus
        className="device-line__field"
        id={inputId}
        inputMode="url"
        onChange={(event) => {
          setText(event.target.value);
          setRefused(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          content.onClose();
        }}
        placeholder="https://example.com"
        spellCheck={false}
        type="url"
        value={text}
      />
      {refused ? (
        /* ui-boundary-exception: inline-field-error */
        <span className="device-line__message" id={hintId} role="alert">
          Use an http or https address.
        </span>
      ) : null}
      <OctantButton disabled={text.trim().length === 0} size="sm" type="submit">
        Open
      </OctantButton>
      <OctantIconButton
        label="Close Open URL"
        onClick={content.onClose}
        size="icon-sm"
        type="button"
      >
        <X aria-hidden="true" size={14} />
      </OctantIconButton>
    </form>
  );
}
