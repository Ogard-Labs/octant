import { useContext, useEffect, useState } from "react";
import {
  decodeSandboxRestrictionsCommand,
  type SandboxRestrictionsSnapshot,
} from "@octant/contracts/sandbox-policy";
import { TaskAccessContext } from "./TaskAccessContext";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

/** One grouped refusal at the work, with grants made only by the person's controls. */
export function SandboxRestrictionsNotice() {
  const context = useContext(TaskAccessContext);
  const client = context?.sandboxRestrictionsClient;
  const threadId = context?.subject.aggregateId;
  const [snapshot, setSnapshot] = useState<SandboxRestrictionsSnapshot>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSnapshot(undefined);
    if (client === undefined || threadId === undefined) return;
    const controller = new AbortController();
    const refresh = () => {
      void client
        .settings({ kind: "session", threadId }, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setSnapshot(value);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, threadId]);
  const denial = snapshot?.denials[0];
  if (client === undefined || snapshot === undefined || denial === undefined) return null;
  async function answer(duration?: "session" | "project") {
    if (client === undefined || snapshot === undefined || denial === undefined) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change(
        decodeSandboxRestrictionsCommand(
          duration === undefined
            ? { kind: "keep-blocked", denialId: denial.id, expectedVersion: snapshot.version }
            : {
                kind: "grant-denial",
                denialId: denial.id,
                duration,
                expectedVersion: snapshot.version,
              },
        ),
      );
      if (result.kind === "sandbox-restrictions-refused") setProblem(result.message);
      else setSnapshot(result);
    } catch {
      setProblem("The host could not save this choice. Retry from Sandbox restrictions.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OctantAlert
      tone="warning"
      title="Blocked by sandbox"
      className="composer-notice"
      action={
        <>
          {denial.grantable ? (
            <>
              <OctantButton disabled={busy} onClick={() => void answer("session")}>
                Allow for this session
              </OctantButton>
              <OctantButton
                disabled={busy}
                variant="outline"
                onClick={() => void answer("project")}
              >
                Remember for this Project
              </OctantButton>
            </>
          ) : null}
          <OctantButton disabled={busy} variant="ghost" onClick={() => void answer()}>
            Keep blocked
          </OctantButton>
          {context?.onOpenSandboxRestrictions === undefined ? null : (
            <OctantButton variant="ghost" onClick={context.onOpenSandboxRestrictions}>
              Sandbox restrictions…
            </OctantButton>
          )}
        </>
      }
    >
      <p>
        {denial.message}
        {denial.count > 1 ? ` (${denial.count} attempts)` : ""}
      </p>
      <p>
        {denial.grantable
          ? `Allow ${denial.operation} access to ${denial.resource}. Applies next turn.`
          : denial.remedy}
      </p>
      {snapshot.denials.length > 1 ? (
        <p>{snapshot.denials.length - 1} more blocked actions in Sandbox restrictions.</p>
      ) : null}
      {problem === undefined ? null : <p>{problem}</p>}
    </OctantAlert>
  );
}
