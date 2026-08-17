import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeGitOperationId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type { CodeApprovalId } from "@octant/contracts/code";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantTextarea } from "../ui/base/OctantTextarea";

type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;
type ApprovalAction = "stage" | "unstage" | "discard" | "commit" | "push";

export interface CodeGitPaneProps {
  readonly client: Pick<CodeClient, "executeOperation">;
  readonly createGitOperationId: () => CodeGitOperationId;
  readonly createOperationId: () => CodeOperationId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly observation: GitObservation;
  readonly onReviewPullRequest?: () => void;
  readonly requestApproval?: (
    command: Parameters<CodeClient["executeOperation"]>[0],
  ) => Promise<CodeApprovalId | undefined>;
  readonly scope: { readonly checkoutId: CodeCheckoutId; readonly threadId: CodeThreadId };
}

export function CodeGitPane(props: CodeGitPaneProps) {
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [failure, setFailure] = useState<string>();
  const [lastResult, setLastResult] = useState<string>();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const selectedPaths = new Set(selected);
  const staged = props.observation.status.filter(
    (entry) => entry.index !== " " && entry.index !== "?",
  );
  const head = props.observation.head;
  const remote = props.observation.upstream?.remote ?? props.observation.remotes[0]?.name;
  // Unstaging and discarding each answer to a different half of the status: one
  // needs the path to be in the index, the other needs it to be tracked at all.
  const selectedStaged = staged
    .map((entry) => entry.path)
    .filter((path) => selectedPaths.has(path));
  const selectedTracked = props.observation.status
    .filter((entry) => entry.index !== "?" && entry.worktree !== "?")
    .map((entry) => entry.path)
    .filter((path) => selectedPaths.has(path));

  const authorization = async (command: Parameters<CodeClient["executeOperation"]>[0]) => {
    if (props.executionPolicy === "full-access") return { kind: "full-access" } as const;
    if (!decidesCodeEffectsByApproval(props.executionPolicy)) return undefined;
    const approvalId = await props.requestApproval?.(command);
    return approvalId === undefined ? undefined : ({ kind: "approved", approvalId } as const);
  };

  const execute = async (
    action: ApprovalAction,
    exactScope: ReadonlyArray<string>,
    command: Parameters<CodeClient["executeOperation"]>[0],
  ) => {
    try {
      const authority = await authorization(command);
      if (authority === undefined) return;
      const authorizedCommand =
        command.kind === "push-git" ? { ...command, authorization: authority } : command;
      const result = await props.client.executeOperation(authorizedCommand);
      const label = `${action.slice(0, 1).toUpperCase()}${action.slice(1)}`;
      if (result.kind === "operation-failed") setFailure(result.failure.message);
      else if (result.kind === "git-mutation-state" && result.state === "completed")
        setLastResult(`${label} completed.`);
      else if (result.kind === "git-mutation-state")
        setFailure(`${label} ${result.state}. Refresh checkout state before retrying.`);
      else setLastResult(`${label} requested. Waiting for authoritative checkout refresh.`);
    } catch {
      setFailure("Git command failed. Refresh checkout state and retry.");
    }
  };

  /**
   * Ask the thread's provider to describe the change it can already see.
   *
   * Drafting reads and writes nothing, so it needs no approval; the text lands
   * in the field for the user to edit, and the commit itself stays a separate,
   * deliberate action.
   */
  const suggest = async () => {
    setFailure(undefined);
    setLastResult(undefined);
    setSuggesting(true);
    try {
      const result = await props.client.executeOperation({
        kind: "draft-git-text",
        operationId: props.createOperationId(),
        purpose: "commit-message",
        ...props.scope,
      });
      if (result.kind === "operation-failed") setFailure(result.failure.message);
      else if (
        result.kind !== "git-draft-state" ||
        result.state !== "completed" ||
        result.title === undefined
      )
        setFailure("No commit message was drafted. Write one yourself.");
      else {
        const title = result.title;
        setCommitMessage(result.body === undefined ? title : `${title}\n\n${result.body}`);
      }
    } catch {
      setFailure("Drafting a commit message failed. Write one yourself.");
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <section aria-label="Git delivery" className="code-delivery-pane code-git-pane">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Git</span>
          <h1>Checkout changes</h1>
        </div>
        <div className="code-git-pane__toolbar-meta">
          <p>{head.kind === "branch" ? head.name : "Detached HEAD"}</p>
          {props.onReviewPullRequest === undefined ? null : (
            <OctantButton
              onClick={() => props.onReviewPullRequest?.()}
              type="button"
              variant="ghost"
            >
              Review pull request
            </OctantButton>
          )}
        </div>
      </header>
      <ul className="code-git-pane__status">
        {props.observation.status.map((entry) => (
          <li key={entry.path}>
            {props.executionPolicy === "plan" ? null : (
              <OctantCheckbox
                aria-label={`Select ${entry.path}`}
                checked={selectedPaths.has(entry.path)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, entry.path]
                      : current.filter((path) => path !== entry.path),
                  )
                }
              />
            )}
            <code>
              {entry.index}
              {entry.worktree}
            </code>
            <span>{entry.path}</span>
          </li>
        ))}
      </ul>
      {props.executionPolicy === "plan" ? (
        <p className="code-delivery-pane__notice">
          Plan mode is read-only. Git mutation is unavailable.
        </p>
      ) : (
        <div className="code-git-pane__actions">
          <OctantButton
            disabled={selected.length === 0}
            onClick={() =>
              void execute("stage", selected, {
                kind: "stage-git",
                operationId: props.createOperationId(),
                gitOperationId: props.createGitOperationId(),
                paths: selected as [string, ...string[]] as never,
                expectedStateToken: props.observation.stateToken,
                ...props.scope,
              })
            }
            type="button"
            variant="secondary"
          >
            Stage {selected.length} {selected.length === 1 ? "path" : "paths"}
          </OctantButton>
          <OctantButton
            disabled={selectedStaged.length === 0}
            onClick={() =>
              void execute("unstage", selectedStaged, {
                kind: "unstage-git",
                operationId: props.createOperationId(),
                gitOperationId: props.createGitOperationId(),
                paths: selectedStaged as never,
                expectedStateToken: props.observation.stateToken,
                ...props.scope,
              })
            }
            type="button"
            variant="secondary"
          >
            Unstage {selectedStaged.length} {selectedStaged.length === 1 ? "path" : "paths"}
          </OctantButton>
          {/* Discarding removes work no commit can bring back, so it asks once
              before it runs rather than relying on the approval prompt alone. */}
          {confirmingDiscard ? (
            <div className="code-git-pane__confirm" role="alertdialog" aria-label="Confirm discard">
              <p>
                Throw away uncommitted changes to {selectedTracked.length}{" "}
                {selectedTracked.length === 1 ? "path" : "paths"}? This cannot be undone.
              </p>
              <OctantButton
                onClick={() => {
                  setConfirmingDiscard(false);
                  void execute("discard", selectedTracked, {
                    kind: "discard-git-changes",
                    operationId: props.createOperationId(),
                    gitOperationId: props.createGitOperationId(),
                    paths: selectedTracked as never,
                    expectedStateToken: props.observation.stateToken,
                    ...props.scope,
                  });
                }}
                type="button"
                variant="destructive"
              >
                Discard changes
              </OctantButton>
              <OctantButton
                onClick={() => setConfirmingDiscard(false)}
                type="button"
                variant="ghost"
              >
                Keep changes
              </OctantButton>
            </div>
          ) : (
            <OctantButton
              disabled={selectedTracked.length === 0}
              onClick={() => setConfirmingDiscard(true)}
              type="button"
              variant="ghost"
            >
              Discard {selectedTracked.length} {selectedTracked.length === 1 ? "path" : "paths"}
            </OctantButton>
          )}
          <label className="code-delivery-pane__field">
            Commit message
            <OctantTextarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
          </label>
          <OctantButton
            disabled={suggesting || props.observation.status.length === 0}
            onClick={() => void suggest()}
            type="button"
            variant="ghost"
          >
            {suggesting ? "Drafting…" : "Suggest commit message"}
          </OctantButton>
          <OctantButton
            disabled={commitMessage.trim().length === 0 || staged.length === 0}
            onClick={() =>
              void execute(
                "commit",
                staged.map((entry) => entry.path),
                {
                  kind: "commit-git",
                  operationId: props.createOperationId(),
                  gitOperationId: props.createGitOperationId(),
                  message: commitMessage,
                  stagedSummary: staged as never,
                  expectedStateToken: props.observation.stateToken,
                  ...props.scope,
                },
              )
            }
            type="button"
            variant="secondary"
          >
            Commit {staged.length} staged {staged.length === 1 ? "path" : "paths"}
          </OctantButton>
          <OctantButton
            disabled={head.kind !== "branch" || remote === undefined}
            onClick={() => {
              if (head.kind !== "branch" || remote === undefined) return;
              const localRef = `refs/heads/${head.name}` as const;
              const remoteRef = props.observation.upstream?.mergeRef ?? localRef;
              void execute("push", [`${remote} ${localRef}:${remoteRef}`], {
                kind: "push-git",
                operationId: props.createOperationId(),
                gitOperationId: props.createGitOperationId(),
                remote,
                localRef,
                remoteRef,
                expectedHeadOid: head.oid,
                expectedStateToken: props.observation.stateToken,
                confirmation: { remote, refspec: `${localRef}:${remoteRef}` },
                authorization: { kind: "full-access" },
                ...props.scope,
              } as never);
            }}
            type="button"
            variant="secondary"
          >
            Push exact branch
          </OctantButton>
        </div>
      )}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
      {lastResult === undefined ? null : <p role="status">{lastResult}</p>}
    </section>
  );
}
