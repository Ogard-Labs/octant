import type { PullRequestReviewClient } from "@octant/client-runtime";
import { createPullRequestGuideClient } from "@octant/client-runtime/pull-request-guide-client";
import type {
  CodeProjectPullRequestDetailObserved,
  PullRequestReviewTarget,
} from "@octant/contracts";
import type { PullRequestViewedState } from "@octant/contracts/pull-request-guide";
import { useEffect, useMemo, useState } from "react";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import "./pull-request-guide.css";

export interface PullRequestViewedFilesProps {
  readonly client: PullRequestReviewClient;
  readonly target: PullRequestReviewTarget;
  readonly files: CodeProjectPullRequestDetailObserved["files"];
}

/**
 * The changed files with GitHub's own Viewed checkboxes. The state is read
 * from and written to GitHub through the host, so it follows the person to
 * github.com and back; a file GitHub reset after a new push reads "Changed".
 * Where the host refuses Viewed (a paired device), the list stays plain.
 */
export default function PullRequestViewedFiles(props: PullRequestViewedFilesProps) {
  const [states, setStates] = useState<ReadonlyMap<string, PullRequestViewedState>>();
  const [note, setNote] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const { client, target } = props;
  // The pane builds its target afresh on every render; read again only when it names another pull request.
  const targetKey = `${String(target.projectId)}/${String(target.repositoryOwner)}/${String(target.repositoryName)}#${target.number}`;
  const guides = useMemo(() => createPullRequestGuideClient(client.transport), [client]);

  useEffect(() => {
    const controller = new AbortController();
    void guides
      .readViewed(target, controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return;
        setStates(new Map(view.files.map((file) => [String(file.path), file.state])));
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setNote(caught instanceof Error ? caught.message : "Viewed files are unavailable.");
        }
      });
    return () => controller.abort();
  }, [guides, targetKey]);

  async function toggle(path: string, viewed: boolean): Promise<void> {
    if (states === undefined) return;
    const before = states;
    setSaving(path);
    setStates(new Map(states).set(path, viewed ? "viewed" : "unviewed"));
    try {
      await guides.setViewed({ target, path, viewed });
      setNote(undefined);
    } catch (caught: unknown) {
      setStates(before);
      setNote(caught instanceof Error ? caught.message : "GitHub did not take the change.");
    } finally {
      setSaving(undefined);
    }
  }

  const viewedCount = props.files.filter((file) => states?.get(file.path) === "viewed").length;

  return (
    <>
      {states === undefined ? null : (
        <p className="pr-guide__viewed-count oct-meta" role="status">
          {viewedCount} of {props.files.length} viewed
        </p>
      )}
      {note === undefined ? null : <p className="pr-detail__quiet">{note}</p>}
      <ul className="pr-detail__rows">
        {props.files.map((file) => {
          const state = states?.get(file.path);
          return (
            <li key={file.path}>
              {states === undefined ? null : (
                <OctantCheckbox
                  aria-label={`Viewed ${file.path}`}
                  checked={state === "viewed"}
                  disabled={saving !== undefined}
                  onChange={(event) => void toggle(file.path, event.currentTarget.checked)}
                />
              )}
              <span className="pr-detail__name">{file.path}</span>
              {/* Plain text, not a badge: a badge here split the shared button chunk and grew first paint. */}
              {state === "changed" ? <span className="pr-guide__changed">Changed</span> : null}
              <span className="pr-detail__delta">
                <span data-tone="added">+{file.additions}</span>
                <span data-tone="removed">−{file.deletions}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
