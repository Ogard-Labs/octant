import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import { useCallback, useEffect, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { announceShellSettingsWritten } from "../shell/shellSettingsNotifications";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * A CLI waiting on this answer has no turn the window can see, so the window
 * looks often enough that the person is asked while still at the terminal.
 */
const POLL_MS = 1_500;

export interface TerminalBrowserApprovalPromptProps {
  readonly client: Pick<BrowserAutomationClient, "listApprovals" | "decideApproval">;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly className?: string;
}

/**
 * Asks the person before a program in one of this Code thread's terminals
 * opens a new site in the thread's Browser.
 *
 * In Code, the host's Browser approval service is asked only by a terminal's
 * Browser grant: a managed Code turn asks through its own operation approval.
 * So every Code approval listed here came from a terminal, and the card says
 * so, because the person must not mistake it for the thread's own agent.
 */
export function TerminalBrowserApprovalPrompt(props: TerminalBrowserApprovalPromptProps) {
  const [approvals, setApprovals] = useState<ReadonlyArray<BrowserToolApproval>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [ended, setEnded] = useState<string>();
  const listApprovals = props.client.listApprovals;

  const revision = useThreadActivityRevision("toolApprovals");

  // A different thread or client starts clean; a notice never clears the list.
  useEffect(() => {
    setApprovals([]);
  }, [listApprovals, props.threadId]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (listApprovals === undefined) return;
      try {
        const listed = await listApprovals(signal);
        if (signal.aborted) return;
        const mine = listed.filter(
          (approval) =>
            approval.mode === "code" && String(approval.threadId) === String(props.threadId),
        );
        setApprovals((current) => (samePollingData(current, mine) ? current : mine));
        if (mine.length > 0) setEnded(undefined);
      } catch {
        if (!signal.aborted) setApprovals([]);
      }
    },
    [listApprovals, props.threadId],
  );
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? POLL_MS : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const pending = approvals[0];
  if (pending === undefined || props.client.decideApproval === undefined) {
    return ended === undefined ? null : (
      <OctantAlert {...(props.className === undefined ? {} : { className: props.className })}>
        {ended}
      </OctantAlert>
    );
  }

  const decide = async (decision: "approved" | "denied", remember?: boolean) => {
    if (busy || props.client.decideApproval === undefined) return;
    setBusy(true);
    setMessage(undefined);
    setEnded(undefined);
    try {
      const settled = await props.client.decideApproval({
        approvalId: pending.approvalId,
        decision,
        ...(remember === true ? { remember: true } : {}),
      });
      setApprovals((current) =>
        current.filter((approval) => approval.approvalId !== pending.approvalId),
      );
      if (!settled) {
        setEnded(
          `The terminal's request to open ${pending.origin} had already ended, so nothing was let through.`,
        );
      } else if (decision === "approved" && remember === true) {
        announceShellSettingsWritten();
      }
    } catch {
      setMessage("The answer could not be sent. The request is still open; try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <OctantApprovalCard
      actions={
        <>
          <OctantButton
            disabled={busy}
            onClick={() => void decide("approved")}
            size="sm"
            type="button"
          >
            Approve once
          </OctantButton>
          <OctantButton
            disabled={busy}
            onClick={() => void decide("approved", true)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Always allow
          </OctantButton>
          <OctantButton
            disabled={busy}
            onClick={() => void decide("denied")}
            size="sm"
            type="button"
            variant="ghost"
          >
            Deny
          </OctantButton>
        </>
      }
      {...(props.className === undefined ? {} : { className: props.className })}
      detail={`Asked by a program in a terminal of “${props.threadTitle}”, not by this thread's agent`}
      error={message}
      label="Browser request from a terminal"
      summary={`Let the terminal open ${pending.origin} in the Browser?`}
    />
  );
}
