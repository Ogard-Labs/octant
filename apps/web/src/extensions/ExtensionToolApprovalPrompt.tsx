import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
import { CirclePause } from "lucide-react";
import { useEffect, useState } from "react";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import { samePollingData } from "../polling/samePollingData";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

const ACTIVE_TOOL_APPROVAL_POLL_MS = 500;
const IDLE_TOOL_APPROVAL_POLL_MS = 5_000;

/**
 * A selected MCP server's tool call waits on the host until a person answers
 * it, in Chat, Work, and Code alike. The host lists every pending request for
 * this window; only the open thread's are shown, oldest first.
 */
export function ExtensionToolApprovalPrompt(props: {
  readonly client: ExtensionClient | undefined;
  readonly threadId: string | undefined;
  /** A running turn is polled often, because its call is waiting on the answer. */
  readonly turnActive: boolean;
  readonly className: string;
}) {
  const { client, threadId, turnActive } = props;
  const [approvals, setApprovals] = useState<ReadonlyArray<ExtensionToolApproval>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (client === undefined || threadId === undefined) {
      setApprovals([]);
      return;
    }
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const listed = await client.listToolApprovals(controller.signal);
        if (!controller.signal.aborted) {
          const next = listed.filter((approval) => String(approval.threadId) === threadId);
          setApprovals((current) => (samePollingData(current, next) ? current : next));
        }
      } catch {
        if (!controller.signal.aborted) {
          setApprovals((current) => (current.length === 0 ? current : []));
        }
      } finally {
        inFlight = false;
      }
    };
    const stop = scheduleVisibleInterval(
      () => void refresh(),
      turnActive ? ACTIVE_TOOL_APPROVAL_POLL_MS : IDLE_TOOL_APPROVAL_POLL_MS,
      { runImmediately: true },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [client, threadId, turnActive]);

  const pending = approvals[0];
  if (pending === undefined || client === undefined) return null;

  async function decide(decision: "approved" | "denied") {
    if (pending === undefined || client === undefined || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await client.decideToolApproval({ approvalId: pending.approvalId, decision });
      setApprovals((current) =>
        current.filter((approval) => approval.approvalId !== pending.approvalId),
      );
    } catch {
      // The call is still waiting on the host, so the request stays on screen
      // for another answer rather than vanishing as if it had been decided.
      setMessage("The approval could not be sent. Keep this request open and retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Extension tool approval"
      className={`approval-row approval-row--request ${props.className}`}
      role="group"
    >
      <CirclePause aria-hidden="true" size={14} strokeWidth={1.8} />
      <span className="approval-row__text">
        Allow {pending.mcpToolName}?
        <span className="approval-row__detail">One-time extension tool request</span>
      </span>
      <div className="approval-row__actions">
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
          onClick={() => void decide("denied")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Deny
        </OctantButton>
      </div>
      <code className="approval-row__code">
        {pending.inputJson === "" ? "(empty input)" : pending.inputJson}
      </code>
      {message === undefined ? null : (
        <OctantAlert className="approval-row__detail" tone="warning">
          {message}
        </OctantAlert>
      )}
    </section>
  );
}
