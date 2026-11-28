import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { SidebarThreadAsk } from "./sidebarPendingRequests";

/**
 * The answers a Needs-you row offers for a thread the window does not show: the
 * approval card's own Allow once and Deny when the thread waits on exactly one
 * plain approval, and Open always. They sit after the row's button, because a
 * button cannot hold another, so the keyboard reaches the row and its own hover
 * actions, then Allow once, Deny and Open. Allow once never remembers the answer for the Project; that
 * choice stays on the card in the thread. A refusal the host returns is one
 * quiet line, kept until the host stops listing that request.
 */
export function SidebarRequestActions(props: {
  readonly title: string;
  readonly ask: SidebarThreadAsk | undefined;
  readonly onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const answer = props.ask?.answer;
  const send = async (approved: boolean) => {
    if (answer === undefined) return;
    setBusy(true);
    setRefusal(undefined);
    const result = await answer(approved);
    setBusy(false);
    if (result.status === "refused") setRefusal(result.message);
  };
  return (
    <div className="sidebar-request">
      <div aria-label={`Answer ${props.title}`} className="sidebar-request__actions" role="group">
        {answer === undefined ? null : (
          <>
            <OctantButton disabled={busy} onClick={() => void send(true)} size="sm" type="button">
              Allow once
            </OctantButton>
            <OctantButton
              disabled={busy}
              onClick={() => void send(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Deny
            </OctantButton>
          </>
        )}
        <OctantButton onClick={props.onOpen} size="sm" type="button" variant="ghost">
          Open
        </OctantButton>
      </div>
      {refusal === undefined ? null : (
        <p className="oct-meta sidebar-request__refusal" role="status">
          {refusal}
        </p>
      )}
    </div>
  );
}
