import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId, decodeAgentRunRequestId } from "@octant/contracts";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type {
  ProjectTerminalCommand,
  ProjectTerminalResult,
} from "@octant/contracts/project-terminals";
import { useEffect, useMemo, useState } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

export type PreparationTarget = Omit<
  Extract<ProjectTerminalCommand, { kind: "worktree-preparation" }>,
  "kind" | "action"
>;
type View = Extract<ProjectTerminalResult, { kind: "worktree-preparation" }>;
export function WorktreePreparationDialog(props: {
  readonly children?: Pick<AgentRunClient, "parentSummary"> | undefined;
  readonly client: ProjectTerminalClient;
  readonly target: PreparationTarget;
  readonly onClose: () => void;
}) {
  const [childRequestId, setChildRequestId] = useState("");
  const [children, setChildren] = useState<
    ReadonlyArray<{ readonly requestId: string; readonly task: string }>
  >([]);
  useEffect(() => {
    let current = true;
    void props.children
      ?.parentSummary(decodeAgentRunParentThreadId(String(props.target.thread.threadId)))
      .then((result) => {
        if (current) setChildren(result.entries.slice(-20));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [props.children, props.target]);
  const target = useMemo(
    () => ({
      ...props.target,
      ...(childRequestId === "" ? {} : { childRequestId: decodeAgentRunRequestId(childRequestId) }),
    }),
    [props.target, childRequestId],
  );
  const [view, setView] = useState<View>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await props.client.execute(
          { kind: "worktree-preparation", ...target, action: "inspect" },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (result.kind === "worktree-preparation") {
          setView(result);
          setFailure(undefined);
          timer = setTimeout(() => void read(), 1000);
        } else
          setFailure(
            result.kind === "project-terminal-refused" ? result.message : "Setup is unavailable.",
          );
      } catch {
        if (!abort.signal.aborted) setFailure("Setup status is unavailable. Nothing was retried.");
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [props.client, target, refresh]);
  const command = async (action: "retry" | "cancel" | "skip") => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await props.client.execute({
        kind: "worktree-preparation",
        ...props.target,
        action,
      });
      if (result.kind === "worktree-preparation") {
        setView(result);
        setFailure(undefined);
      } else
        setFailure(
          result.kind === "project-terminal-refused" ? result.message : "Setup is unavailable.",
        );
    } catch {
      setFailure(
        "The reply was lost. Inspect the recorded status before deciding what to do; nothing was retried.",
      );
    } finally {
      setBusy(false);
      setRefresh((current) => current + 1);
    }
  };
  const preparation = view?.preparation;
  const running = preparation?.state === "running";
  return (
    <OctantDialog
      className="project-dialog project-action-run"
      label="Worktree setup"
      open
      onClose={props.onClose}
    >
      <h1>Worktree setup</h1>
      {children.length === 0 ? null : (
        <OctantSelectField
          aria-label="Checkout to prepare"
          value={childRequestId}
          onValueChange={(value) => {
            setChildRequestId(value);
            setView(undefined);
          }}
          options={[
            { id: "", label: "This task's checkout" },
            ...children.map((child) => ({
              id: child.requestId,
              label: `Child: ${child.task.slice(0, 80)}`,
            })),
          ]}
        />
      )}
      <p role="status">
        {preparation === undefined
          ? view === undefined
            ? "Checking setup…"
            : "No setup recipe was recorded for this worktree."
          : `Setup ${preparation.state}${preparation.exitCode === undefined ? "" : ` (exit ${preparation.exitCode})`}`}
      </p>
      {preparation === undefined ? null : (
        <>
          <p>
            Reviewed command: <code>{preparation.recipe.command}</code>
          </p>
          <p>
            Folder within checkout: <code>{preparation.recipe.directory}</code>
          </p>
          <p>{preparation.reason}</p>
          <p>
            The first agent task waits for setup or your explicit Skip. Setup uses task access, has
            a ten minute limit, and never replays after restart.
          </p>
        </>
      )}
      {failure === undefined ? null : <OctantAlert tone="danger">{failure}</OctantAlert>}
      {view?.outputTruncated === true ? <p>Earlier output was truncated.</p> : null}
      {preparation === undefined ? null : (
        <pre className="project-action-run__output">
          {view?.output || "No output retained on this host."}
        </pre>
      )}
      <div className="project-dialog__actions">
        <OctantButton onClick={props.onClose} type="button">
          Close
        </OctantButton>
        {preparation === undefined ? null : running ? (
          <OctantButton disabled={busy} onClick={() => void command("cancel")} type="button">
            Cancel setup
          </OctantButton>
        ) : (
          <>
            <OctantButton
              disabled={busy || preparation.state === "cleanup-uncertain"}
              onClick={() => void command("retry")}
              type="button"
            >
              {preparation.state === "pending" ? "Start setup" : "Retry setup"}
            </OctantButton>
            <OctantButton
              disabled={busy || preparation.state === "cleanup-uncertain"}
              onClick={() => void command("skip")}
              type="button"
            >
              Skip setup
            </OctantButton>
          </>
        )}
      </div>
    </OctantDialog>
  );
}
