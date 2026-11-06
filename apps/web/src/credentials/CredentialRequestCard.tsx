import { useEffect, useId, useRef, useState } from "react";
import { Check, Eye, EyeOff, LockKeyhole } from "lucide-react";
import type {
  CredentialRequestAnswer,
  CredentialRequestCard as Card,
} from "@octant/contracts/credential-request";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantInput } from "../ui/base/OctantInput";
import "./credentialRequests.css";

const statusText = {
  using: "Sending request…",
  used: "Request completed · Token not saved",
  declined: "Declined",
  cancelled: "Request cancelled",
  expired: "Request expired",
  failed: "Request could not be completed",
} as const;

export function CredentialRequestCard(props: {
  readonly card: Card;
  readonly answer: (answer: CredentialRequestAnswer) => Promise<boolean>;
}) {
  const id = useId();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  useEffect(() => {
    if (props.card.state !== "pending") {
      setSecret("");
      setRevealed(false);
    }
  }, [props.card.state]);
  const send = async (action: "allow" | "decline") => {
    if (inFlight.current || accepted) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const answer: CredentialRequestAnswer =
      action === "decline" ? { id: props.card.id, action } : { id: props.card.id, action, secret };
    // Do not retain the entry after submission, even if the network fails.
    setSecret("");
    setRevealed(false);
    try {
      if (await props.answer(answer)) setAccepted(true);
      else setError("This request is no longer available. Wait for its status to update.");
    } catch {
      setError(
        "The result could not be confirmed. The token was cleared; it will not be sent again automatically.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (props.card.state !== "pending")
    return (
      <div className="credential-request-result" data-state={props.card.state} role="status">
        {props.card.state === "used" ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <LockKeyhole size={16} aria-hidden="true" />
        )}
        <span>
          {props.card.label} · {statusText[props.card.state]}
          {props.card.state === "failed"
            ? " · Check the credential's access and expiry, then ask for a new private card. Nothing is retried automatically."
            : null}
        </span>
      </div>
    );
  return (
    <form
      noValidate
      className="credential-request-card"
      aria-labelledby={`${id}-title`}
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (secret.trim()) void send("allow");
      }}
    >
      <div className="credential-request-card__heading">
        <span className="credential-request-card__mark">
          <LockKeyhole size={20} aria-hidden="true" />
        </span>
        <div className="credential-request-card__identity">
          <label id={`${id}-title`} htmlFor={id} className="credential-request-card__title">
            {props.card.label}
          </label>
          <span className="credential-request-card__destination">
            {props.card.destination} · One use
          </span>
        </div>
      </div>
      <p className="credential-request-card__reason">{props.card.reason}</p>
      <div className="credential-request-card__field">
        <OctantInput
          id={id}
          type={revealed ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          value={secret}
          maxLength={4096}
          disabled={busy || accepted}
          onChange={(event) => {
            setSecret(event.target.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          }}
          aria-describedby={`${id}-privacy${error === undefined ? "" : ` ${id}-error`}`}
          aria-invalid={error !== undefined}
          placeholder="Paste token"
        />
        <OctantIconButton
          className="credential-request-card__reveal"
          type="button"
          label={revealed ? "Hide token" : "Show token"}
          aria-pressed={revealed}
          disabled={busy || accepted || !secret}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
        </OctantIconButton>
      </div>
      <div className="credential-request-card__footer">
        <details className="credential-request-card__details">
          <summary id={`${id}-privacy`}>Not saved or added to chat</summary>
          <p>
            Sent only to {props.card.consumer} for this request, then discarded. No files, shell
            access, or saved sign-in. This request expires after 10 minutes.
          </p>
        </details>
        <div className="credential-request-card__actions">
          <OctantButton
            type="button"
            variant="ghost"
            disabled={busy || accepted}
            onClick={() => void send("decline")}
          >
            Decline
          </OctantButton>
          <OctantButton
            type="submit"
            disabled={busy || accepted || !secret.trim()}
            aria-busy={busy}
          >
            {props.card.actionLabel}
          </OctantButton>
        </div>
      </div>
      {busy || accepted ? (
        <p className="credential-request-card__progress" role="status">
          {busy ? "Sending request…" : "Waiting for confirmation…"}
        </p>
      ) : null}
      {error === undefined ? null : (
        <OctantAlert role="alert">
          <p id={`${id}-error`}>{error}</p>
        </OctantAlert>
      )}
    </form>
  );
}
