import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeEvidenceContentId, CodeThreadId } from "@octant/contracts/code";
import type {
  CodeOperationId,
  CodeOperationResult,
  CodePullRequestReview,
  CodePullRequestReviewObserved,
  CodePullRequestReviewSection,
} from "@octant/contracts/code-operations";
import type { CodeApprovalId } from "@octant/contracts/code";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { PullRequestConversation } from "./CodeReviewPane";

type PullRequestResult = Extract<CodeOperationResult, { readonly kind: "pull-request-state" }>;

const PR_STATE_LABELS: Record<CodePullRequestReviewObserved["pullRequestState"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const CHECK_STATE_LABELS: Record<CodePullRequestReviewObserved["checks"][number]["state"], string> =
  {
    success: "Passing",
    failure: "Failing",
    pending: "Pending",
    neutral: "Neutral",
    unknown: "Unknown",
  };

export interface CodePullRequestPaneProps {
  readonly client: Pick<CodeClient, "executeOperation" | "operationContent">;
  readonly createOperationId: () => CodeOperationId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly idempotencyKey: string;
  readonly requestApproval?: (
    command: Parameters<CodeClient["executeOperation"]>[0],
  ) => Promise<CodeApprovalId | undefined>;
  readonly scope: { readonly checkoutId: CodeCheckoutId; readonly threadId: CodeThreadId };
  readonly review?: CodePullRequestReview;
  readonly onNavigateThread?: () => void;
  readonly onNavigateWorktree?: () => void;
  readonly onRefresh?: () => void;
}

export function CodePullRequestPane(props: CodePullRequestPaneProps) {
  if (props.review?.state === "observed") {
    return <ReviewWindow {...props} review={props.review} />;
  }
  if (props.review?.state === "unavailable") {
    return (
      <section aria-label="Pull request" className="code-delivery-pane code-pr-pane">
        <ReviewHeader {...(props.onRefresh === undefined ? {} : { onRefresh: props.onRefresh })} />
        <p role="alert">
          The linked pull request could not be observed from GitHub. Check GitHub authentication and
          retry.
        </p>
      </section>
    );
  }
  return <CreatePullRequest {...props} noLinkedPullRequest={props.review?.state === "none"} />;
}

function ReviewHeader(props: { readonly onRefresh?: () => void }) {
  return (
    <header className="code-delivery-pane__toolbar">
      <div>
        <span>Pull request</span>
        <h1>Review</h1>
      </div>
      {props.onRefresh === undefined ? null : (
        <OctantButton onClick={() => props.onRefresh?.()} size="sm" type="button" variant="ghost">
          Refresh observation
        </OctantButton>
      )}
    </header>
  );
}

function ReviewWindow(
  props: CodePullRequestPaneProps & { readonly review: CodePullRequestReviewObserved },
) {
  const { review } = props;
  const stale = (section: CodePullRequestReviewSection) => review.staleSections.includes(section);
  const waiting = review.ambiguous || review.freshness === "stale";
  const description = useEvidenceText(
    props.client,
    props.scope.threadId,
    review.operationId,
    review.description.contentId,
  );
  const diff = useEvidenceText(
    props.client,
    props.scope.threadId,
    review.operationId,
    review.diff.contentId,
  );

  return (
    <section aria-label="Pull request review" className="code-delivery-pane code-pr-review">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Pull request #{review.number}</span>
          <h1>{review.title.length === 0 ? `Pull request #${review.number}` : review.title}</h1>
          <p className="code-pr-review__meta">
            <span className="code-pr-review__badge">
              {PR_STATE_LABELS[review.pullRequestState]}
            </span>
            <span>
              {review.headBranch} → {review.baseRepository}:{review.baseBranch}
            </span>
            {review.author.length === 0 ? null : <span>by {review.author}</span>}
          </p>
        </div>
        <div className="code-pr-review__actions">
          <a
            className="code-pr-review__github-link"
            href={review.url}
            rel="noreferrer"
            target="_blank"
          >
            Open on GitHub
          </a>
          {props.onNavigateThread === undefined ? null : (
            <OctantButton
              onClick={() => props.onNavigateThread?.()}
              size="sm"
              type="button"
              variant="ghost"
            >
              Go to thread
            </OctantButton>
          )}
          {props.onNavigateWorktree === undefined ? null : (
            <OctantButton
              onClick={() => props.onNavigateWorktree?.()}
              size="sm"
              type="button"
              variant="ghost"
            >
              Go to worktree
            </OctantButton>
          )}
          {props.onRefresh === undefined ? null : (
            <OctantButton
              onClick={() => props.onRefresh?.()}
              size="sm"
              type="button"
              variant="ghost"
            >
              Refresh observation
            </OctantButton>
          )}
        </div>
      </header>

      <p className="code-pr-review__guardrail">
        Read-only review · merging, commenting, approving, requesting changes, and closing stay on
        GitHub.
      </p>

      {waiting ? (
        <div className="code-pr-review__waiting" role="alert">
          <strong>Waiting on a fresh GitHub observation.</strong>
          <p>
            {review.freshness === "stale"
              ? "This is the last known GitHub metadata and may be out of date."
              : "Some sections could not be fully observed."}{" "}
            Stale GitHub metadata never marks delivery Done.
          </p>
        </div>
      ) : null}

      {review.matchesDeliveryBranch ? null : (
        <p className="code-pr-review__notice" role="note">
          This pull request does not match the confirmed delivery branch.
        </p>
      )}

      <section aria-label="Pull request description" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Description</h2>
          {stale("description") ? <StaleTag section="description" /> : null}
        </header>
        <EvidenceBlock label="description" state={description} empty="No description provided." />
      </section>

      <section aria-label="Pull request commits" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Commits ({review.commits.length})</h2>
          {stale("commits") ? <StaleTag section="commits" /> : null}
        </header>
        {review.commits.length === 0 ? (
          <p role="status">No commits observed.</p>
        ) : (
          <ul className="code-pr-review__commits">
            {review.commits.map((commit) => (
              <li key={commit.oid}>
                <code>{commit.oid.slice(0, 12)}</code>
                <span>{commit.messageHeadline}</span>
                {commit.author.length === 0 ? null : (
                  <span className="code-pr-review__muted">{commit.author}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request changed files" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Changed files ({review.files.length})</h2>
          {stale("files") ? <StaleTag section="files" /> : null}
        </header>
        {review.files.length === 0 ? (
          <p role="status">No changed files observed.</p>
        ) : (
          <ul className="code-pr-review__files">
            {review.files.map((file) => (
              <li key={file.path}>
                <span>{file.path}</span>
                <span className="code-pr-review__muted">
                  +{file.additions} −{file.deletions}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request checks" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Checks ({review.checks.length})</h2>
          {stale("checks") ? <StaleTag section="checks" /> : null}
        </header>
        {review.checks.length === 0 ? (
          <p role="status">No checks observed.</p>
        ) : (
          <ul className="code-pr-review__checks">
            {review.checks.map((check, index) => (
              <li key={`${check.name}-${index}`}>
                <span>{check.name}</span>
                <span className="code-pr-review__badge">{CHECK_STATE_LABELS[check.state]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Pull request diff" className="code-pr-review__section">
        <header className="code-pr-review__section-header">
          <h2>Diff</h2>
          {stale("diff") ? <StaleTag section="diff" /> : null}
        </header>
        {review.diff.truncated === true ? (
          <p className="code-pr-review__notice" role="note">
            This diff is truncated and is not complete.
          </p>
        ) : null}
        <EvidenceBlock label="diff" state={diff} empty="No diff observed." pre />
      </section>

      <PullRequestConversation
        comments={review.comments}
        reviews={review.reviews}
        staleComments={stale("comments")}
        staleReviews={stale("reviews")}
      />
    </section>
  );
}

type EvidenceState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string };

function EvidenceBlock(props: {
  readonly label: string;
  readonly state: EvidenceState;
  readonly empty: string;
  readonly pre?: boolean;
}) {
  if (props.state.kind === "loading") return <p role="status">Loading {props.label} evidence…</p>;
  if (props.state.kind === "unavailable") return <p role="alert">{props.state.message}</p>;
  if (props.state.text.trim().length === 0) return <p role="status">{props.empty}</p>;
  return props.pre === true ? (
    <pre className="code-pr-review__diff">{props.state.text}</pre>
  ) : (
    <p className="code-pr-review__description">{props.state.text}</p>
  );
}

function useEvidenceText(
  client: Pick<CodeClient, "operationContent">,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  contentId: CodeEvidenceContentId,
): EvidenceState {
  const [state, setState] = useState<EvidenceState>({ kind: "loading" });
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    let active = true;
    setState({ kind: "loading" });
    void client
      .operationContent(threadId, operationId, contentId)
      .then((bytes) => {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("Evidence is not valid UTF-8.");
        }
        if (active && request === generation.current) setState({ kind: "ready", text });
      })
      .catch((error: unknown) => {
        if (!active || request !== generation.current) return;
        setState({
          kind: "unavailable",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Evidence is unavailable.",
        });
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [client, contentId, operationId, threadId]);
  return state;
}

function StaleTag(props: { readonly section: string }) {
  return (
    <span className="code-pr-review__stale" role="note">
      Stale · {props.section} could not be refreshed from GitHub
    </span>
  );
}

function CreatePullRequest(
  props: CodePullRequestPaneProps & { readonly noLinkedPullRequest: boolean },
) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<PullRequestResult>();
  const [failure, setFailure] = useState<string>();
  const [suggesting, setSuggesting] = useState(false);

  /**
   * Ask the thread's provider to describe the branch's change. Reading a diff
   * and writing prose changes nothing, so this needs no approval; opening the
   * pull request stays a separate, deliberate action on edited text.
   */
  const suggest = async () => {
    setFailure(undefined);
    setSuggesting(true);
    try {
      const draft = await props.client.executeOperation({
        kind: "draft-git-text",
        operationId: props.createOperationId(),
        purpose: "pull-request",
        ...props.scope,
      });
      if (draft.kind === "operation-failed") setFailure(draft.failure.message);
      else if (
        draft.kind !== "git-draft-state" ||
        draft.state !== "completed" ||
        draft.title === undefined
      )
        setFailure("No pull request text was drafted. Write it yourself.");
      else {
        setTitle(draft.title);
        if (draft.body !== undefined) setBody(draft.body);
      }
    } catch {
      setFailure("Drafting pull request text failed. Write it yourself.");
    } finally {
      setSuggesting(false);
    }
  };

  const create = async () => {
    try {
      const operationId = props.createOperationId();
      const command = {
        kind: "create-pull-request",
        operationId,
        title,
        body,
        idempotencyKey: props.idempotencyKey,
        authorization: { kind: "full-access" },
        ...props.scope,
      } as const;
      const approvalId = decidesCodeEffectsByApproval(props.executionPolicy)
        ? await props.requestApproval?.(command)
        : undefined;
      if (decidesCodeEffectsByApproval(props.executionPolicy) && approvalId === undefined) return;
      const next = await props.client.executeOperation({
        ...command,
        authorization:
          approvalId === undefined ? { kind: "full-access" } : { kind: "approved", approvalId },
      });
      if (next.kind === "pull-request-state") setResult(next);
      if (next.kind === "operation-failed") setFailure(next.failure.message);
    } catch {
      setFailure("Pull request command failed. Check GitHub authentication and retry.");
    }
  };

  return (
    <section aria-label="Pull request" className="code-delivery-pane code-pr-pane">
      <header className="code-delivery-pane__toolbar">
        <div>
          <span>Pull request</span>
          <h1>New pull request</h1>
        </div>
        <p>Creation only · no review mutation or merge</p>
      </header>
      {props.noLinkedPullRequest ? (
        <p className="code-delivery-pane__notice" role="status">
          No linked pull request yet.
        </p>
      ) : null}
      {result !== undefined && (result.state === "created" || result.state === "existing") ? (
        <div className="code-pr-pane__result">
          <strong>
            {result.state === "existing" ? "Existing pull request" : "Pull request created"}
          </strong>
          <span>
            {result.headBranch} → {result.baseBranch}
          </span>
          <a href={result.url} rel="noreferrer" target="_blank">
            Open pull request #{result.number}
          </a>
        </div>
      ) : null}
      {props.executionPolicy === "plan" ? (
        <p className="code-delivery-pane__notice">
          Plan mode is read-only. Pull request creation is unavailable.
        </p>
      ) : (
        <div className="code-pr-pane__form">
          <label className="code-delivery-pane__field">
            Pull request title
            <OctantInput value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="code-delivery-pane__field">
            Pull request body
            <OctantTextarea value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <OctantButton
            disabled={suggesting}
            onClick={() => void suggest()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {suggesting ? "Drafting…" : "Suggest title and description"}
          </OctantButton>
          <OctantButton
            disabled={title.trim().length === 0}
            onClick={() => void create()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Create pull request
          </OctantButton>
        </div>
      )}
      {result?.state === "unavailable" || result?.state === "failed" ? (
        <p role="alert">
          Pull request creation is {result.state}. Check GitHub authentication and delivery target.
        </p>
      ) : null}
      {failure === undefined ? null : <p role="alert">{failure}</p>}
    </section>
  );
}
