import { useCallback, useEffect, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { HarnessApprovalLostPanel, HarnessApprovalPanel } from "./HarnessApprovalPanel";
import "./native-harness.css";

export interface ThreadHarnessApprovalProps {
  readonly client: Pick<NativeHarnessClient, "decideApproval" | "command">;
  readonly threadId: string;
  /** The thread's session as `ThreadHarnessCards` last read it. */
  readonly view: NativeHarnessSessionView | null | undefined;
  readonly reload: () => Promise<unknown>;
}

/** The lead's own pending approval; a subagent's is the Agents tab's to answer. */
export function leadApproval(view: NativeHarnessSessionView | null | undefined) {
  return view?.approvals?.find((entry) => entry.status === "pending" && entry.source === undefined);
}

/**
 * The agent's own harness approval, shown in the thread it blocks, beside the
 * composer, the way a question is. Anyone reading the thread sees that it
 * needs them without opening the Agents tab.
 *
 * The card decides nothing. A decision goes to the thread's session route,
 * which checks the window and the principal on the host before anything runs,
 * so a window or a paired device gets exactly the choices it already had in the
 * Agents tab. A subagent's approval is not shown here; the Agents tab answers
 * it, and the thread's Needs you row finds it.
 */
export function ThreadHarnessApproval(props: ThreadHarnessApprovalProps) {
  const { client, threadId, view, reload } = props;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const approval = leadApproval(view);
  useEffect(() => setNotice(undefined), [threadId, approval?.id]);

  const decide = useCallback(
    async (
      decision: "approve" | "approve-always" | "deny",
      commandHosts: ReadonlyArray<{ readonly host: string; readonly port: number }> | undefined,
    ) => {
      if (approval === undefined || busy) return;
      setBusy(true);
      try {
        const result = await client.decideApproval(threadId, {
          approvalId: String(approval.id),
          decision,
          ...(commandHosts === undefined || decision !== "approve" ? {} : { commandHosts }),
        });
        setNotice(result.kind === "approval-refused" ? result.message : undefined);
      } catch {
        setNotice("The decision was not delivered. Try again.");
      } finally {
        setBusy(false);
        await reload();
      }
    },
    [approval, busy, client, threadId, reload],
  );

  const resume = useCallback(async () => {
    if (view === null || view === undefined || busy) return;
    setBusy(true);
    try {
      const result = await client.command(threadId, {
        kind: "resume-native-harness-session",
        sessionId: view.session.id,
        expectedVersion: view.session.version,
        continueInterrupted: true,
      });
      setNotice(result.kind === "native-harness-session-refused" ? result.message : undefined);
    } catch {
      setNotice(
        "Resume could not be confirmed. Refresh the thread and check its message queue before trying again.",
      );
    } finally {
      setBusy(false);
      await reload();
    }
  }, [view, busy, client, threadId, reload]);

  if (view === null || view === undefined) return null;
  // An approval the journal still holds as pending after a restart has no turn
  // waiting on it any more: nothing can run for it, so the card offers no way
  // to approve it, only the Resume that settles it.
  const lostInRestart = view.session.status === "recovery-required";
  if (approval === undefined && !lostInRestart) return null;
  const resumeButton = (
    <OctantButton
      disabled={busy}
      onClick={() => void resume()}
      size="sm"
      type="button"
      variant="default"
    >
      {busy ? "Resuming…" : "Resume"}
    </OctantButton>
  );
  return (
    <div className="thread-harness-approval">
      {approval === undefined ? (
        <OctantAlert tone="warning" role="status" action={resumeButton}>
          <p>Octant restarted before this turn finished. Review any changes before continuing.</p>
        </OctantAlert>
      ) : lostInRestart ? (
        <HarnessApprovalLostPanel approval={approval}>{resumeButton}</HarnessApprovalLostPanel>
      ) : (
        <HarnessApprovalPanel
          approval={approval}
          busy={busy}
          onDecide={(decision, commandHosts) => void decide(decision, commandHosts)}
        />
      )}
      {notice === undefined ? null : (
        <OctantAlert className="native-harness-panel__error" tone="warning">
          {notice}
        </OctantAlert>
      )}
    </div>
  );
}
