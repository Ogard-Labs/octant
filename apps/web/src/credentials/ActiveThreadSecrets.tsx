import { useState } from "react";
import type { ActiveThreadSecret, ThreadSecretSource } from "@octant/contracts/thread-secrets";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { useThreadSecrets } from "./threadSecretsFeed";
import "./threadSecrets.css";

export const THREAD_SECRET_SOURCES: Readonly<Record<ThreadSecretSource, string>> = {
  pasted: "Entered",
  onepassword: "1Password",
  remembered: "Remembered",
};

const MINUTE_MS = 60_000;

/** When it ends, in the person's words. */
export function threadSecretTimeLeft(secret: ActiveThreadSecret): string {
  if (secret.remainingMs !== undefined) {
    const minutes = Math.ceil(secret.remainingMs / MINUTE_MS);
    if (minutes <= 1) return "Ends in a minute";
    return minutes < 60 ? `${minutes} min left` : `${Math.round(minutes / 60)} h left`;
  }
  switch (secret.lifetime) {
    case "this-command":
      return "For one command";
    case "this-turn":
      return "Until this turn ends";
    default:
      return "Until archived";
  }
}

/** What this thread's agent may use now, each with a way to end it. */
export function ActiveThreadSecrets(props: {
  readonly threadId: string;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
}) {
  const { threadId } = props;
  const { view, send } = useThreadSecrets(props);
  const [ending, setEnding] = useState<string>();
  const [failed, setFailed] = useState(false);
  if (view.active.length === 0) return null;
  const revoke = async (secretId: string) => {
    setEnding(secretId);
    setFailed(false);
    try {
      const result = await send({ kind: "revoke", threadId, secretId });
      setFailed(result.status === "refused" || result.status === "not-taken");
    } catch {
      setFailed(true);
    } finally {
      setEnding(undefined);
    }
  };
  return (
    <OctantCollapsible summary={<>Active secrets · {view.active.length}</>}>
      <ul className="active-thread-secrets">
        {view.active.map((secret) => (
          <li key={secret.id}>
            <span className="active-thread-secrets__name">{secret.label}</span>
            <span className="active-thread-secrets__facts">
              {threadSecretTimeLeft(secret)} · {THREAD_SECRET_SOURCES[secret.source]} ·{" "}
              {secret.name}
            </span>
            <OctantButton
              aria-label={`Revoke ${secret.label}, ${secret.name}`}
              disabled={ending !== undefined}
              onClick={() => void revoke(secret.id)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Revoke
            </OctantButton>
          </li>
        ))}
      </ul>
      {failed ? (
        <OctantAlert layout="row" tone="danger">
          It could not be revoked. Try again.
        </OctantAlert>
      ) : null}
    </OctantCollapsible>
  );
}
