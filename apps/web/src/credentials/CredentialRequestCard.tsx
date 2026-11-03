import { useEffect, useId, useRef, useState } from "react";
import { Check, LockKeyhole } from "lucide-react";
import type {
  CredentialRequestAnswer,
  CredentialRequestCard as Card,
} from "@octant/contracts/credential-request";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantInput } from "../ui/base/OctantInput";
import "./credentialRequests.css";

const statusText = {
  using: "Checking access…",
  used: "Access checked · Token not saved",
  declined: "Declined",
  cancelled: "Request cancelled",
  expired: "Request expired",
  failed: "Access could not be checked",
} as const;

export function CredentialRequestCard(props: {
  readonly card: Card;
  readonly answer: (answer: CredentialRequestAnswer) => Promise<boolean>;
}) {
  const id = useId();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  useEffect(() => {
    if (props.card.state !== "pending") setSecret("");
  }, [props.card.state]);
  const send = async (action: "allow" | "decline") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const answer: CredentialRequestAnswer =
      action === "decline" ? { id: props.card.id, action } : { id: props.card.id, action, secret };
    // Do not retain the entry after submission, even if the network fails.
    setSecret("");
    try {
      if (!(await props.answer(answer)))
        setError("This request is no longer available. Refresh its status before trying again.");
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
      <div className="credential-request-result" role="status">
        {props.card.state === "used" ? (
          <Check size={15} aria-hidden="true" />
        ) : (
          <LockKeyhole size={15} aria-hidden="true" />
        )}
        <span>
          {props.card.label} · {statusText[props.card.state]}
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
        <LockKeyhole size={16} aria-hidden="true" />
        <span>Credential needed</span>
      </div>
      <label id={`${id}-title`} htmlFor={id} className="credential-request-card__title">
        {props.card.label}
      </label>
      <p className="credential-request-card__reason">{props.card.reason}</p>
      <div className="credential-request-card__entry">
        <OctantInput
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          value={secret}
          maxLength={4096}
          disabled={busy}
          onChange={(event) => setSecret(event.target.value)}
          aria-describedby={`${id}-privacy`}
          aria-invalid={error !== undefined}
          placeholder="Enter token"
        />
        <OctantButton type="submit" disabled={busy || !secret.trim()}>
          {busy ? "Checking…" : props.card.actionLabel}
        </OctantButton>
      </div>
      <div className="credential-request-card__footer">
        <p id={`${id}-privacy`}>
          Kept out of chat. Sent only to {props.card.consumer} for this check, then discarded.
        </p>
        <OctantButton
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void send("decline")}
        >
          Decline
        </OctantButton>
      </div>
      <details className="credential-request-card__details">
        <summary>Access details</summary>
        <p>
          One request to {props.card.destination}. No files, shell access, or saved sign-in. This
          request expires after 10 minutes.
        </p>
      </details>
      {error === undefined ? null : (
        <OctantAlert role="alert">
          <p>{error}</p>
        </OctantAlert>
      )}
    </form>
  );
}
