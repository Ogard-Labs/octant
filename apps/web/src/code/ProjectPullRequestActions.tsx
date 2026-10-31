import type {
  CodeProjectPullRequestActionContext,
  CodeProjectPullRequestActionOutcome,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";

/** The person's own actions on a pull request, before the pane names its target. */
export type ProjectPullRequestPersonAction =
  | {
      readonly kind: "labels";
      readonly add: ReadonlyArray<string>;
      readonly remove: ReadonlyArray<string>;
    }
  | { readonly kind: "comment"; readonly body: string }
  | { readonly kind: "reply"; readonly reviewThreadId: string; readonly body: string }
  | { readonly kind: "close" }
  | { readonly kind: "reopen" };

export interface ProjectPullRequestActionsProps {
  readonly pullRequestState: "open" | "draft" | "merged" | "closed";
  readonly loadContext: () => Promise<CodeProjectPullRequestActionContext>;
  readonly onAct: (
    action: ProjectPullRequestPersonAction,
  ) => Promise<CodeProjectPullRequestActionOutcome>;
  /** Called after an action the forge accepted, so the review can re-read. */
  readonly onChanged?: () => void;
}

type ReadContext = Extract<CodeProjectPullRequestActionContext, { status: "read" }>;

type Notice =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "refused"; readonly text: string };

/**
 * Labels, a comment, a reply in one review thread, close, and reopen: the
 * person's own controls. The click is the approval, so there is no second
 * confirmation; a comment or reply posts under the person's name, which the
 * copy says next to the button. A paired phone or web client is refused by the
 * host, and the pane says so instead of failing silently.
 */
export function ProjectPullRequestActions(props: ProjectPullRequestActionsProps) {
  const [context, setContext] = useState<ReadContext>();
  const [loadFailure, setLoadFailure] = useState<string>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [comment, setComment] = useState("");
  const [replyThread, setReplyThread] = useState<string>();
  const [reply, setReply] = useState("");
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const { loadContext } = props;
  const closed = props.pullRequestState === "closed";
  const merged = props.pullRequestState === "merged";

  const reload = useCallback(async () => {
    try {
      const next = await loadContext();
      if (next.status === "read") {
        setContext(next);
        setLoadFailure(undefined);
      } else {
        setContext(undefined);
        setLoadFailure(contextFailureCopy(next));
      }
    } catch (error) {
      setContext(undefined);
      setLoadFailure(
        isUnauthorized(error) ? DESKTOP_ONLY : "Labels and review threads could not be read.",
      );
    }
  }, [loadContext]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(
    action: ProjectPullRequestPersonAction,
    done: string,
    after?: () => void,
  ): Promise<void> {
    setPending(true);
    setNotice(undefined);
    try {
      const outcome = await props.onAct(action);
      if (outcome.status === "done") {
        setNotice({ tone: "done", text: done });
        after?.();
        await reload();
        props.onChanged?.();
      } else {
        setNotice({ tone: "refused", text: actionRefusalCopy(outcome) });
      }
    } catch (error) {
      setNotice({
        tone: "refused",
        text: isUnauthorized(error) ? DESKTOP_ONLY : "That did not go through. Try again.",
      });
    } finally {
      setPending(false);
      queueMicrotask(() => noticeRef.current?.focus());
    }
  }

  const applied = new Set(context?.labels ?? []);
  const available = (context?.repositoryLabels ?? []).filter((label) => !applied.has(label));
  const openThreads = (context?.reviewThreads ?? []).filter((thread) => !thread.resolved);

  return (
    <section aria-label="Your actions" className="code-pr-review__section code-pr-actions">
      <header className="code-pr-review__section-header">
        <h2>Your actions</h2>
      </header>
      {loadFailure === undefined ? null : (
        <p className="code-pr-actions__note" role="status">
          {loadFailure}
        </p>
      )}

      <div className="code-pr-actions__group" role="group" aria-label="Labels">
        <strong>Labels</strong>
        {context === undefined ? null : context.labels.length === 0 && available.length === 0 ? (
          <p className="code-pr-actions__note">This repository has no labels yet.</p>
        ) : (
          <ul className="code-pr-actions__labels">
            {context.labels.map((label) => (
              <li key={`on-${label}`}>
                <OctantButton
                  aria-label={`Remove label ${label}`}
                  aria-pressed="true"
                  disabled={pending || merged}
                  onClick={() =>
                    void run(
                      { kind: "labels", add: [], remove: [label] },
                      `Removed label ${label}.`,
                    )
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {label} ×
                </OctantButton>
              </li>
            ))}
            {available.map((label) => (
              <li key={`off-${label}`}>
                <OctantButton
                  aria-label={`Add label ${label}`}
                  aria-pressed="false"
                  disabled={pending || merged}
                  onClick={() =>
                    void run({ kind: "labels", add: [label], remove: [] }, `Added label ${label}.`)
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  + {label}
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        aria-label="Comment on this pull request"
        noValidate
        className="code-pr-actions__group"
        onSubmit={(event) => {
          event.preventDefault();
          if (comment.trim() === "") return;
          void run({ kind: "comment", body: comment }, "Posted your comment.", () =>
            setComment(""),
          );
        }}
      >
        <label htmlFor="code-pr-actions-comment">
          <strong>Comment</strong>
        </label>
        <OctantTextarea
          id="code-pr-actions-comment"
          onChange={(event) => setComment(event.target.value)}
          placeholder="Write a comment"
          rows={3}
          value={comment}
        />
        <div className="code-pr-actions__row">
          <span className="code-pr-actions__note">Posts under your name.</span>
          <OctantButton
            disabled={pending || comment.trim() === ""}
            size="sm"
            type="submit"
            variant="secondary"
          >
            Post comment
          </OctantButton>
        </div>
      </form>

      {openThreads.length === 0 ? null : (
        <div className="code-pr-actions__group" role="group" aria-label="Review threads">
          <strong>Open review threads</strong>
          <ul className="code-pr-actions__threads">
            {openThreads.map((thread) => (
              <li key={thread.id}>
                <p className="code-pr-actions__thread-text">
                  <span className="code-pr-actions__note">
                    {thread.path === "" ? "General" : thread.path}
                    {thread.outdated ? " · outdated" : ""}
                    {thread.author === "" ? "" : ` · ${thread.author}`}
                  </span>
                  {thread.excerpt === "" ? null : <span>{thread.excerpt}</span>}
                </p>
                {replyThread === thread.id ? (
                  <form
                    noValidate
                    aria-label={`Reply in the thread on ${thread.path === "" ? "the pull request" : thread.path}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (reply.trim() === "") return;
                      void run(
                        { kind: "reply", reviewThreadId: thread.id, body: reply },
                        "Posted your reply.",
                        () => {
                          setReply("");
                          setReplyThread(undefined);
                        },
                      );
                    }}
                  >
                    <OctantTextarea
                      aria-label="Your reply"
                      autoFocus
                      onChange={(event) => setReply(event.target.value)}
                      rows={2}
                      value={reply}
                    />
                    <div className="code-pr-actions__row">
                      <span className="code-pr-actions__note">Posts under your name.</span>
                      <OctantButton
                        disabled={pending}
                        onClick={() => {
                          setReplyThread(undefined);
                          setReply("");
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Cancel
                      </OctantButton>
                      <OctantButton
                        disabled={pending || reply.trim() === ""}
                        size="sm"
                        type="submit"
                        variant="secondary"
                      >
                        Post reply
                      </OctantButton>
                    </div>
                  </form>
                ) : (
                  <OctantButton
                    disabled={pending}
                    onClick={() => {
                      setReplyThread(thread.id);
                      setReply("");
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Reply
                  </OctantButton>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {merged ? null : (
        <div className="code-pr-actions__group code-pr-actions__row">
          <span className="code-pr-actions__note">
            {closed
              ? "Reopening keeps the same branch and history."
              : "Closing keeps the branch; you can reopen it."}
          </span>
          <OctantButton
            disabled={pending}
            onClick={() =>
              void run(
                closed ? { kind: "reopen" } : { kind: "close" },
                closed ? "Reopened the pull request." : "Closed the pull request.",
              )
            }
            size="sm"
            type="button"
            variant="secondary"
          >
            {closed ? "Reopen pull request" : "Close pull request"}
          </OctantButton>
        </div>
      )}

      {notice === undefined ? null : (
        /* ui-boundary-exception: compact-status */
        <p
          ref={noticeRef}
          tabIndex={-1}
          className={`code-pr-review__merge-result code-pr-review__merge-result--${notice.tone === "done" ? "merged" : "refused"}`}
          role={notice.tone === "done" ? "status" : "alert"}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}

const DESKTOP_ONLY = "Only the desktop window can do this.";

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === "unauthorized"
  );
}

function contextFailureCopy(
  context: Exclude<CodeProjectPullRequestActionContext, { status: "read" }>,
): string {
  if (context.status === "refused") {
    return "This Project is not connected to that repository, so these actions are off.";
  }
  return context.reason === "unauthenticated"
    ? "GitHub authentication is unavailable, so labels and review threads could not be read."
    : context.reason === "disconnected"
      ? "GitHub could not be reached, so labels and review threads could not be read."
      : "Labels and review threads could not be read.";
}

function actionRefusalCopy(
  outcome: Exclude<CodeProjectPullRequestActionOutcome, { status: "done" }>,
): string {
  if (outcome.status === "unavailable") {
    return outcome.reason === "unauthenticated"
      ? "That did not go through: GitHub authentication is unavailable."
      : outcome.reason === "disconnected"
        ? "That did not go through: GitHub could not be reached."
        : "That did not go through: the GitHub command is unavailable.";
  }
  const reason =
    outcome.reason === "not-authorized"
      ? "only the desktop window with this Project connected can do this"
      : outcome.reason === "not-open"
        ? "the pull request is not open"
        : outcome.reason === "not-closed"
          ? "the pull request is not closed"
          : outcome.reason === "merged"
            ? "the pull request is already merged"
            : outcome.reason === "label-not-found"
              ? "the repository does not have that label"
              : outcome.reason === "invalid"
                ? "GitHub did not accept that text or thread"
                : "GitHub rejected it";
  return `That did not go through: ${reason}.`;
}
