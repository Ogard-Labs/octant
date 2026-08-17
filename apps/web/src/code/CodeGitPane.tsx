import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeGitOperationId, CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type { CodeApprovalId } from "@octant/contracts/code";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";

type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;
type ApprovalAction = "stage" | "commit" | "push";

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
  const selectedPaths = new Set(selected);
  const staged = props.observation.status.filter(
    (entry) => entry.index !== " " && entry.index !== "?",
  );
  const head = props.observation.head;
  const remote = props.observation.upstream?.remote ?? props.observation.remotes[0]?.name;

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

  return (
    <section aria-label="Git delivery" className="code-delivery-pane code-git-pane">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Git</span>
          <h1>Checkout changes</h1>
        </div>
        <div className="code-git-pane__toolbar-meta">
          <p>
            {head.kind === "detached"
              ? "Detached HEAD"
              : head.kind === "unborn"
                ? `${head.name} (no commits yet)`
                : head.name}
          </p>
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
          <label className="code-delivery-pane__field">
            Commit message
            <OctantInput
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
          </label>
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
