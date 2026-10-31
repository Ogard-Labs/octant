import { useEffect, useMemo, useState } from "react";
import type { GitHistoryClient } from "@octant/client-runtime/git-history-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import type { GitHistoryCommit, GitHistoryDetail } from "@octant/contracts/git-history";
import {
  readCodeDiffIgnoreWhitespace,
  writeCodeDiffIgnoreWhitespace,
} from "../code/codeDiffWhitespacePreference";
import { parseUnifiedDiff } from "../code/unifiedDiff";
import { UnifiedDiffList } from "../code/UnifiedDiffList";
import { ShellState } from "../shell/ShellState";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { WhitespaceToggle } from "./CommitDetail";

export interface LocalCommitsPanelProps {
  readonly reader: GitHistoryClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
}

type Listing =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly commits: ReadonlyArray<GitHistoryCommit>;
      readonly comparedWith: string | undefined;
    }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Commits on the thread's branch that its upstream, or its base branch when it
 * has no upstream, does not have yet: the work that exists only on this
 * machine. Read-only; a row opens that commit's own diff.
 */
export function LocalCommitsPanel(props: LocalCommitsPanelProps) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(readCodeDiffIgnoreWhitespace);
  useEffect(() => {
    const controller = new AbortController();
    setListing({ kind: "loading" });
    props.reader
      .read(
        { kind: "local-commits", threadId: props.threadId, checkoutId: props.checkoutId },
        controller.signal,
      )
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setListing(
            result.status === "history"
              ? { kind: "ready", commits: result.commits, comparedWith: result.comparedWith }
              : {
                  kind: "unavailable",
                  message:
                    result.status === "unavailable"
                      ? result.message
                      : "Local commits could not be loaded.",
                },
          );
        },
        () => {
          if (!controller.signal.aborted)
            setListing({
              kind: "unavailable",
              message: "Local commits could not be loaded. Retry the request.",
            });
        },
      );
    return () => controller.abort();
  }, [props.reader, props.threadId, props.checkoutId, refresh]);

  return (
    <section className="git-history" aria-label="Local commits">
      <div className="git-history__toolbar">
        <WhitespaceToggle
          value={ignoreWhitespace}
          onChange={(value) => {
            writeCodeDiffIgnoreWhitespace(value);
            setIgnoreWhitespace(value);
          }}
        />
        <OctantButton size="sm" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </OctantButton>
      </div>
      {listing.kind === "loading" ? <ShellState state="loading" title="Loading commits" /> : null}
      {listing.kind === "unavailable" ? (
        <OctantAlert className="git-history__notice" tone="warning">
          {listing.message}
        </OctantAlert>
      ) : null}
      {listing.kind === "ready" ? (
        <>
          <div className="git-history__status" role="status">
            {listing.commits.length.toLocaleString("en")}{" "}
            {listing.commits.length === 1 ? "local commit" : "local commits"}
            {listing.comparedWith === undefined ? "" : ` · not on ${listing.comparedWith}`}
          </div>
          {listing.commits.length === 0 ? (
            <p className="git-history__notice">
              {listing.comparedWith === undefined
                ? "There is no upstream or base branch to compare against."
                : `Every commit on this branch is already on ${listing.comparedWith}.`}
            </p>
          ) : (
            <ul className="git-history__diffs">
              {listing.commits.map((commit) => (
                <LocalCommit
                  key={commit.oid}
                  commit={commit}
                  checkoutId={props.checkoutId}
                  ignoreWhitespace={ignoreWhitespace}
                  reader={props.reader}
                  threadId={props.threadId}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function LocalCommit(props: {
  readonly commit: GitHistoryCommit;
  readonly reader: GitHistoryClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly ignoreWhitespace: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          {props.commit.subject} <code>{props.commit.oid.slice(0, 7)}</code>{" "}
          <span>{props.commit.author}</span>
        </summary>
        {open ? <LocalCommitDiff {...props} /> : null}
      </details>
    </li>
  );
}

function LocalCommitDiff(props: {
  readonly commit: GitHistoryCommit;
  readonly reader: GitHistoryClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly ignoreWhitespace: boolean;
}) {
  const [detail, setDetail] = useState<GitHistoryDetail>();
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setMessage(undefined);
    props.reader
      .read(
        {
          kind: "commit",
          threadId: props.threadId,
          checkoutId: props.checkoutId,
          oid: props.commit.oid,
          parent: 0,
          ...(props.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
        },
        controller.signal,
      )
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          if (result.status === "commit") setDetail(result);
          else
            setMessage(
              result.status === "unavailable" ? result.message : "The commit could not be loaded.",
            );
        },
        () => {
          if (!controller.signal.aborted) setMessage("The commit could not be loaded.");
        },
      );
    return () => controller.abort();
  }, [props.reader, props.threadId, props.checkoutId, props.commit.oid, props.ignoreWhitespace]);
  const files = useMemo(() => parseUnifiedDiff(detail?.diff ?? ""), [detail?.diff]);
  if (message !== undefined) return <p className="git-history__notice">{message}</p>;
  if (detail === undefined) return <ShellState state="loading" title="Loading commit" />;
  return (
    <>
      {detail.truncated ? (
        <p className="git-history__notice" role="note">
          This commit exceeds the preview limit. The diff is incomplete.
        </p>
      ) : null}
      {files.length === 0 ? (
        <p className="git-history__notice">No file changes against its parent.</p>
      ) : (
        <UnifiedDiffList files={files} />
      )}
    </>
  );
}
