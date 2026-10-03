import { useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import "./agent-hierarchy.css";

export function FollowUpControl(props: {
  readonly onFollowUp: (message: string) => Promise<string | undefined>;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const submit = async () => {
    const next = message.trim();
    if (inFlight.current || next.length === 0 || next.length > 4096) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const refusal = await props.onFollowUp(next);
      if (refusal !== undefined) {
        setError(refusal);
        return;
      }
      setMessage("");
      setOpen(false);
    } catch {
      setError("The follow-up could not be sent. Reconnect and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <OctantButton onClick={() => setOpen(true)} size="sm" type="button" variant="secondary">
        Follow up
      </OctantButton>
    );
  }
  return (
    <form
      aria-busy={busy}
      aria-label="Follow up with this subagent"
      className="agent-run-detail__steer"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={fieldId}>
        Follow-up message
        <OctantTextarea
          autoFocus
          disabled={busy}
          id={fieldId}
          maxLength={4096}
          onChange={(event) => setMessage(event.target.value)}
          required
          rows={3}
          value={message}
        />
      </label>
      {error === undefined ? null : (
        <p className="agent-run-detail__note" role="alert">
          {error}
        </p>
      )}
      <div className="agent-run-detail__steer-actions">
        <OctantButton
          disabled={busy || message.trim().length === 0 || message.trim().length > 4096}
          size="sm"
          type="submit"
        >
          {busy ? "Sending…" : "Send follow-up"}
        </OctantButton>
        <OctantButton
          disabled={busy}
          onClick={() => setOpen(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel follow-up
        </OctantButton>
      </div>
    </form>
  );
}
