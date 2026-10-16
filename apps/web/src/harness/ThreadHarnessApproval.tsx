import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeHarnessSessionView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { HarnessApprovalLostPanel, HarnessApprovalPanel } from "./HarnessApprovalPanel";
import "./native-harness.css";

export interface ThreadHarnessApprovalProps {
  readonly client: Pick<NativeHarnessClient, "session" | "decideApproval" | "command">;
  readonly threadId: string;
  /**
   * The thread list already says this thread waits on the person. It starts the
   * quick refresh straight away; without it the card reads the session once and
   * then only while an approval is showing, so an idle thread costs one read.
   */
  readonly waiting?: boolean;
  readonly refreshIntervalMs?: number;
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
  const { client, threadId } = props;
  const [read, setRead] = useState<{
    readonly threadId: string;
    readonly view: NativeHarnessSessionView | null;
  }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++generation.current;
    try {
      const view = await client.session(threadId);
      // A response for a thread the card has left must not paint over the one
      // it shows now.
      if (generation.current === mine) setRead({ threadId, view });
    } catch {
      // Keep what was last read while the host reconnects.
    } finally {
      inFlight.current = false;
    }
  }, [client, threadId]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const view = read?.threadId === threadId ? read.view : undefined;
  const approval = view?.approvals?.find(
    (entry) => entry.status === "pending" && entry.source === undefined,
  );
  const polling = props.waiting === true || approval !== undefined;
  useEffect(() => {
    void load();
    if (!polling) return;
    return scheduleVisibleInterval(() => void load(), props.refreshIntervalMs ?? 1_500);
  }, [load, polling, props.refreshIntervalMs]);
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
        await load();
      }
    },
    [approval, busy, client, threadId, load],
  );

  const resume = useCallback(async () => {
    if (view === null || view === undefined || busy) return;
    setBusy(true);
    try {
      const result = await client.command(threadId, {
        kind: "resume-native-harness-session",
        sessionId: view.session.id,
        expectedVersion: view.session.version,
      });
      setNotice(result.kind === "native-harness-session-refused" ? result.message : undefined);
    } catch {
      setNotice("The session was not resumed. Try again.");
    } finally {
      setBusy(false);
      await load();
    }
  }, [view, busy, client, threadId, load]);

  if (view === null || view === undefined || approval === undefined) return null;
  // An approval the journal still holds as pending after a restart has no turn
  // waiting on it any more: nothing can run for it, so the card offers no way
  // to approve it, only the Resume that settles it.
  const lostInRestart = view.session.status === "recovery-required";
  return (
    <div className="thread-harness-approval">
      {lostInRestart ? (
        <HarnessApprovalLostPanel approval={approval}>
          <OctantButton
            disabled={busy}
            onClick={() => void resume()}
            size="sm"
            type="button"
            variant="default"
          >
            Resume
          </OctantButton>
        </HarnessApprovalLostPanel>
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
