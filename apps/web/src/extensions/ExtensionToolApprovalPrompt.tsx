import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
import { useCallback, useEffect, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
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
  const revision = useThreadActivityRevision("toolApprovals");

  // A different client or thread starts clean; a notice never clears the list.
  useEffect(() => {
    setApprovals([]);
  }, [client, threadId]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined || threadId === undefined) return;
      try {
        const listed = await client.listToolApprovals(signal);
        if (signal.aborted) return;
        const next = listed.filter((approval) => String(approval.threadId) === threadId);
        setApprovals((current) => (samePollingData(current, next) ? current : next));
      } catch {
        if (!signal.aborted) {
          setApprovals((current) => (current.length === 0 ? current : []));
        }
      }
    },
    [client, threadId],
  );
  // A running turn's call is blocked on the answer, so a stalled change stream
  // must not delay the prompt: the active beat stays as the recovery read.
  useVisibleRefresh(
    refresh,
    revision,
    turnActive
      ? ACTIVE_TOOL_APPROVAL_POLL_MS
      : revision === undefined
        ? IDLE_TOOL_APPROVAL_POLL_MS
        : THREAD_ACTIVITY_RECOVERY_MS,
  );

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
  // The host says what approving lets run afterwards. A server is asked about
  // once, so approving there covers all its tools; a marked thread's network
  // server is asked about once more, for that thread.
  const covers = pending.answerCovers ?? "call";
  // Narrowing the answer to one tool is recorded as a grant, which the host
  // takes from a local window and a device its own person paired, so it is
  // not offered to any other session.
  const canNarrow = covers === "server" && client.toolGrantsAvailable;
  // A thread outside a Project has no Project to remember in: the host keeps
  // its answer for the account, where only such threads use it.
  const where =
    pending.projectId !== undefined ? "in this Project" : "in Chat threads outside a Project";

  async function decide(decision: "approved" | "denied", remember?: "tool") {
    if (pending === undefined || client === undefined || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await client.decideToolApproval({
        approvalId: pending.approvalId,
        decision,
        ...(remember === undefined ? {} : { remember: true }),
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
            {covers === "server"
              ? "Allow all tools of this server"
              : covers === "server-on-thread"
                ? "Allow this server in this thread"
                : "Approve once"}
          </OctantButton>
          {canNarrow ? (
            <OctantButton
              disabled={busy}
              onClick={() => void decide("approved", "tool")}
              size="sm"
              type="button"
              variant="secondary"
            >
              Allow only this tool
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
      context={
        pending.outsideContent === undefined ? undefined : (
          <ApprovalOutsideContentNote outsideContent={pending.outsideContent} />
        )
      }
      detail={
        covers === "server"
          ? `${server} Octant asks about a server once: allowing lets every tool of this server run ${where} without asking, until its plugin is updated.`
          : covers === "server-on-thread"
            ? `${server} This thread has read outside content, and this server can send what the thread has read over the network. Allowing lets its tools run for the rest of this thread without asking.`
            : server
      }
      error={message}
      label="Extension tool approval"
      summary={`Allow ${pending.mcpToolName} from ${pluginName ?? UNNAMED_PLUGIN}?`}
    >
      <code className="approval-row__code">
        {pending.inputJson === "" ? "(empty input)" : pending.inputJson}
      </code>
    </OctantApprovalCard>
  );
}
