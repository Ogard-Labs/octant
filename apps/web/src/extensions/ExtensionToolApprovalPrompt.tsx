import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
import { useEffect, useState } from "react";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import { samePollingData } from "../polling/samePollingData";
import { ApprovalOutsideContentNote } from "../composer/ApprovalOutsideContentNote";
import { OctantApprovalCard } from "../ui/base/OctantApprovalCard";
import { OctantButton } from "../ui/base/OctantButton";
import { pluginNameIn, UNNAMED_PLUGIN } from "./toolGrantLabels";

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
  const [pluginName, setPluginName] = useState<string>();
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
  const pendingPackageId = pending === undefined ? undefined : String(pending.packageId);
  useEffect(() => {
    setPluginName(undefined);
    if (client === undefined || pendingPackageId === undefined) return;
    let current = true;
    // The prompt names the plugin, which only the installed package list
    // knows. Without it the prompt still names the server and the tool.
    client
      .snapshot()
      .then((snapshot) => {
        if (current) setPluginName(pluginNameIn(snapshot, pendingPackageId));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, pendingPackageId]);

  if (pending === undefined || client === undefined) return null;
  // Remembering an answer is a local window's authority; the host refuses it
  // from a paired device, so it is not offered there at all.
  const canRemember = pending.rememberable && client.toolGrantsAvailable;

  async function decide(decision: "approved" | "denied", remember?: true) {
    if (pending === undefined || client === undefined || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await client.decideToolApproval({
        approvalId: pending.approvalId,
        decision,
        ...(remember === undefined ? {} : { remember }),
      });
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

  const server = `Server: ${pending.serverName}.`;
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
          {canRemember ? (
            <OctantButton
              disabled={busy}
              onClick={() => void decide("approved", true)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Always allow in this Project
            </OctantButton>
          ) : null}
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
      className={props.className}
      detail={
        canRemember
          ? `${server} Always allow means Octant will run this tool in this Project without asking.`
          : server
      }
      error={message}
      label="Extension tool approval"
      summary={`Allow ${pending.mcpToolName} from ${pluginName ?? UNNAMED_PLUGIN}?`}
    >
      {pending.outsideContent === undefined ? null : (
        <ApprovalOutsideContentNote outsideContent={pending.outsideContent} />
      )}
      <code className="approval-row__code">
        {pending.inputJson === "" ? "(empty input)" : pending.inputJson}
      </code>
    </OctantApprovalCard>
  );
}
