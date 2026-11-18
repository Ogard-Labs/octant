import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { ProjectTerminalCommand } from "@octant/contracts/project-terminals";
import type { ChildWorktreeSourceReview } from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";
type SourceCommand = Extract<ProjectTerminalCommand, { kind: "child-worktree-source" }>;
export function ChildWorktreeSourceSection(props: {
  readonly client: ProjectTerminalClient;
  readonly target: Pick<SourceCommand, "projectId" | "thread">;
}) {
  const [review, setReview] = useState<ChildWorktreeSourceReview>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void props.client
      .execute(
        {
          kind: "child-worktree-source",
          projectId: props.target.projectId,
          thread: props.target.thread,
          action: "inspect",
        },
        abort.signal,
      )
      .then((result) => {
        if (abort.signal.aborted) return;
        if (result.kind === "child-worktree-source") {
          setReview(result.review);
          setFailure(undefined);
        } else
          setFailure(
            result.kind === "project-terminal-refused"
              ? result.message
              : "Child source is unavailable.",
          );
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setFailure("Could not read the helper's source. Refresh before you decide.");
      });
    return () => abort.abort();
  }, [props.client, props.target, refresh]);
  const send = async (action: "capture" | "use-committed" | "use-snapshot") => {
    if (submitted.current) return;
    submitted.current = true;
    setBusy(true);
    try {
      const result = await props.client.execute({
        kind: "child-worktree-source",
        projectId: props.target.projectId,
        thread: props.target.thread,
        action,
        ...(action !== "use-snapshot" || review?.preview === undefined
          ? {}
          : { snapshotId: review.preview.id }),
      });
      if (result.kind === "child-worktree-source") {
        setReview(result.review);
        setFailure(undefined);
      } else
        setFailure(
          result.kind === "project-terminal-refused"
            ? result.message
            : "Child source is unavailable.",
        );
    } catch {
      setFailure("The reply was lost. Refresh before you decide again. Nothing was retried.");
    } finally {
      submitted.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="worktree-child-source">
      <h2>Child worktree source</h2>
      <p>
        Choose the source for helpers prepared from this task. Existing helpers keep their own copy.
        Committed revision is the default.
      </p>
      {review === undefined ? (
        <p role="status">
          {failure === undefined ? "Reading child source…" : "Child source unavailable"}
        </p>
      ) : (
        <p role="status">
          {review.selection === "committed"
            ? "Committed revision selected"
            : `Current edits snapshot selected: ${review.selected?.id ?? "unavailable"}`}
        </p>
      )}
      {review?.selected === undefined ? null : (
        <p>
          Committed base: <code>{review.selected.baseRevision.slice(0, 12)}</code> ·{" "}
          {review.selected.files.length} changed files
        </p>
      )}
      {review?.refusal === undefined ? null : (
        <OctantAlert tone="danger">{review.refusal}</OctantAlert>
      )}
      {busy ? (
        <p role="status">Saving the helper's source. This can take up to 30 seconds.</p>
      ) : null}
      {failure === undefined ? null : <OctantAlert tone="danger">{failure}</OctantAlert>}
      <div className="project-dialog__actions">
        <OctantButton
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
          type="button"
          variant="ghost"
        >
          Refresh source
        </OctantButton>
        <OctantButton
          disabled={busy || review === undefined}
          onClick={() => void send("use-committed")}
          type="button"
          variant="secondary"
        >
          Committed revision
        </OctantButton>
        <OctantButton
          disabled={busy || review === undefined}
          onClick={() => void send("capture")}
          type="button"
          variant="secondary"
        >
          Review current edits
        </OctantButton>
      </div>
      {review?.preview === undefined ? null : (
        <>
          <h3>Snapshot preview</h3>
          <p>
            <time dateTime={review.preview.capturedAt}>
              Captured {new Date(review.preview.capturedAt).toLocaleString()}
            </time>
            <br />
            <code>{review.preview.id}</code>
            <br />
            Base: <code>{review.preview.baseRevision.slice(0, 12)}</code>
          </p>
          <p>
            Includes the listed tracked changes and eligible untracked files, with staging
            preserved. Ignored files are excluded. Protected changes refuse capture.
          </p>
          <pre className="project-action-run__output">
            {review.preview.files.length === 0
              ? "No changed files"
              : review.preview.files
                  .map(
                    (file) =>
                      `${file.path}${file.previousPath === undefined ? "" : ` (from ${file.previousPath})`} — ${file.index === "?" ? "untracked" : [file.index === " " ? undefined : "staged", file.worktree === " " ? undefined : "unstaged"].filter(Boolean).join(", ")}`,
                  )
                  .join("\n")}
          </pre>
          <OctantButton
            disabled={busy || review.selected?.id === review.preview.id}
            onClick={() => void send("use-snapshot")}
            type="button"
          >
            Use this snapshot
          </OctantButton>
        </>
      )}
    </section>
  );
}
