import { useEffect, useRef, useState } from "react";
import type { CodeClient } from "@octant/client-runtime";
import {
  PULL_REQUEST_HANDOFF_HEADING,
  readyPullRequestNotice,
} from "@octant/domain/code-pull-request-switch-policy";
import type {
  CodeProjectPullRequestMergeMethod,
  CodeProjectPullRequestRow,
  CodeThreadFollowUp,
  CodeThreadId,
  ProjectId,
} from "@octant/contracts";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { type BabysitClient, targetFor } from "./BulkBabysitDialog";
import { isMergeMethod, mergeOutcomeCopy, switchRefusalCopy } from "./ProjectPullRequestSupport";
import { projectPullRequestKey } from "./projectPullRequestKey";

function pullRequestRef(row: CodeProjectPullRequestRow) {
  return `${row.repositoryOwner}/${row.repositoryName}#${row.number}`;
}

function ReadyMerge({
  row,
  headSha,
  client,
  onUpdated,
}: {
  row: CodeProjectPullRequestRow;
  headSha: string;
  client: BabysitClient;
  onUpdated?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<CodeProjectPullRequestMergeMethod>("squash");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState("");
  const running = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  if (!client.mergeProjectPullRequest) return null;
  // A draft cached before the watch's ready observation may already have been marked ready.
  if (
    row.state === "open" &&
    row.draft &&
    row.babysit?.stoppedAt &&
    Date.parse(row.updatedAt) > Date.parse(row.babysit.stoppedAt)
  ) {
    return <span>Returned to draft after the ready check.</span>;
  }
  const ref = pullRequestRef(row);
  async function confirm() {
    if (running.current || !client.mergeProjectPullRequest) return;
    running.current = true;
    setBusy(true);
    try {
      const outcome = await client.mergeProjectPullRequest({
        ...targetFor(row),
        headSha,
        method,
        confirmed: true,
      });
      setDone(outcome.status === "merged");
      setMessage(outcome.status === "merged" ? `Merged ${ref}.` : mergeOutcomeCopy(outcome));
      if (outcome.status === "merged") onUpdated?.();
    } catch {
      setMessage("Octant could not confirm the merge. Check the pull request before retrying.");
    } finally {
      setBusy(false);
      running.current = false;
      setOpen(false);
    }
  }
  return (
    <>
      <OctantButton
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Merge ${ref}`}
        disabled={done || busy}
        onClick={() => setOpen(true)}
      >
        Merge…
      </OctantButton>
      {message && <p role="status">{message}</p>}
      {open && (
        <OctantDialog
          open
          initialFocus={cancel}
          label={`Merge ${ref}`}
          className="octant-confirmation"
          onClose={() => {
            if (!running.current) setOpen(false);
          }}
        >
          <h2 className="octant-confirmation__title">Merge {ref}?</h2>
          <p className="octant-confirmation__description">
            Octant will check that commit <code>{headSha}</code> still meets the repository’s merge
            requirements.
          </p>
          <OctantSelectField
            aria-label="Merge method"
            value={method}
            disabled={busy}
            onValueChange={(value) => {
              if (isMergeMethod(value)) setMethod(value);
            }}
            options={[
              { id: "squash", label: "Squash and merge" },
              { id: "merge", label: "Create a merge commit" },
              { id: "rebase", label: "Rebase and merge" },
            ]}
          />
          <div className="octant-dialog__actions">
            <OctantButton
              ref={cancel}
              type="button"
              disabled={busy}
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </OctantButton>
            <OctantButton
              type="button"
              disabled={busy}
              variant="destructive"
              onClick={() => void confirm()}
            >
              Confirm merge
            </OctantButton>
          </div>
        </OctantDialog>
      )}
    </>
  );
}

export function RowWatchHandoff({
  row,
  client,
  onUpdated,
}: {
  row: CodeProjectPullRequestRow;
  client: BabysitClient;
  onUpdated: () => void;
}) {
  const watch = row.babysit;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  if (!watch) return null;
  if (watch.status === "ready" && watch.readyHeadSha)
    return (
      <ReadyMerge
        key={watch.readyHeadSha}
        row={row}
        client={client}
        headSha={watch.readyHeadSha}
        onUpdated={onUpdated}
      />
    );
  if (
    !["needs-help", "feedback-limit", "attempt-limit"].includes(watch.status) ||
    !watch.stoppedAt ||
    !watch.checks
  )
    return null;
  const command = {
    kind: "enable" as const,
    target: targetFor(row),
    threadId: watch.threadId,
    expectedStoppedAt: watch.stoppedAt,
    babysit: {
      checks: watch.checks,
      ...(watch.requiredLabel && { requiredLabel: watch.requiredLabel }),
    },
  };
  async function resume() {
    if (running.current || !client.setProjectPullRequestAutoFix) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const outcome = await client.setProjectPullRequestAutoFix(command);
      if (outcome.status !== "applied") setError(switchRefusalCopy("auto-fix", outcome));
      onUpdated();
    } catch {
      setError("Octant could not resume this watch.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <OctantButton
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        aria-label={`Resume babysitting ${pullRequestRef(row)}`}
        onClick={() => void resume()}
      >
        Resume
      </OctantButton>
      {error && (
        <OctantAlert tone="warning" layout="row">
          {error}
        </OctantAlert>
      )}
    </>
  );
}

export function ThreadWatchHandoff({
  client,
  projectId,
  threadId,
  followUp,
}: {
  client: CodeClient;
  projectId: ProjectId;
  threadId: CodeThreadId;
  followUp: CodeThreadFollowUp | undefined;
}) {
  const reason =
    followUp?.origin === "automatic" &&
    followUp.state === "open" &&
    String(followUp.threadId) === String(threadId) &&
    followUp.reason.startsWith(PULL_REQUEST_HANDOFF_HEADING)
      ? followUp.reason
      : undefined;
  const [rows, setRows] = useState<ReadonlyArray<CodeProjectPullRequestRow>>([]);
  useEffect(() => {
    setRows([]);
    if (!reason?.includes(readyPullRequestNotice("")) || !client.mergeProjectPullRequest) return;
    let live = true;
    let reading = false;
    // The overview and thread share the host's cached PR rows. A visible handoff follows updates
    // without restarting its stopped watch or polling GitHub.
    const readRows = async () => {
      if (reading) return;
      reading = true;
      try {
        const view = await client.queryProjectPullRequests({ version: 1, threadId });
        if (live)
          setRows(
            view.rows.filter(
              (row) =>
                String(row.projectId) === String(projectId) &&
                row.babysit?.status === "ready" &&
                String(row.babysit.threadId) === String(threadId) &&
                row.linkedThreads.some((link) => String(link.threadId) === String(threadId)),
            ),
          );
      } catch {
        if (live) setRows([]);
      } finally {
        reading = false;
      }
    };
    const cancel = scheduleVisibleInterval(() => void readRows(), 20_000, { runImmediately: true });
    return () => {
      live = false;
      cancel();
    };
  }, [client, reason, projectId, threadId]);
  if (!reason) return null;
  const actions = new Map<string, { row: CodeProjectPullRequestRow; sha: string }>(
    rows.flatMap((row) => {
      const sha = row.babysit?.readyHeadSha;
      return sha
        ? [[`${pullRequestRef(row)} ${readyPullRequestNotice(sha)}`, { row, sha }] as const]
        : [];
    }),
  );
  return (
    <section aria-label="Pull request updates">
      <strong>Pull request updates</strong>
      <ul>
        {reason
          .slice(PULL_REQUEST_HANDOFF_HEADING.length)
          .split("\n")
          .map((line) => {
            const match = actions.get(line);
            return (
              <li key={line}>
                {match ? (
                  <span title={line}>
                    {pullRequestRef(match.row)} {readyPullRequestNotice(match.sha.slice(0, 12))}
                  </span>
                ) : (
                  line
                )}{" "}
                {match && (
                  <ReadyMerge
                    key={projectPullRequestKey(match.row) + match.sha}
                    row={match.row}
                    client={client}
                    headSha={match.sha}
                  />
                )}
              </li>
            );
          })}
      </ul>
    </section>
  );
}
