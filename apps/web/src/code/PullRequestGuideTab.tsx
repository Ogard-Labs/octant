import type { PullRequestReviewClient } from "@octant/client-runtime";
import { createPullRequestGuideClient } from "@octant/client-runtime/pull-request-guide-client";
import type { PullRequestReviewTarget } from "@octant/contracts";
import type {
  PullRequestGuideAnchor,
  PullRequestGuideFailureReason,
  PullRequestGuideView,
} from "@octant/contracts/pull-request-guide";
import { useEffect, useMemo, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantKbd } from "../ui/base/OctantKbd";
import "./pull-request-guide.css";

/** How often an open Guide tab looks again while a guide is being written. */
const RUNNING_REFRESH_MS = 3_000;

const FAILURE_COPY: Readonly<Record<PullRequestGuideFailureReason, string>> = {
  "no-model": "No guide model is picked for this Project.",
  "spend-ceiling": "The last guide did not run: the thread's spend ceiling was reached.",
  "head-stale": "The last guide was dropped: a push landed while it was being written.",
  "invalid-output": "The last guide was not usable: the model's reply was not a guide.",
  cancelled: "The last guide run was stopped.",
  unavailable: "The last guide could not be written: GitHub or the model was unavailable.",
};

export interface PullRequestGuideTabProps {
  readonly client: PullRequestReviewClient;
  readonly target: PullRequestReviewTarget;
  /** The head the pane shows; a guide written for another head reads as stale. */
  readonly headSha: string;
  /**
   * False on a closed or merged pull request: the host reads no head for one
   * and refuses the run, so nothing offers to write a guide there.
   */
  readonly writable?: boolean;
  readonly onOpenAnchor: (anchor: PullRequestGuideAnchor) => void;
}

function anchorLabel(anchor: PullRequestGuideAnchor): string {
  return anchor.startLine === anchor.endLine
    ? `${String(anchor.path)}:${anchor.startLine}`
    : `${String(anchor.path)}:${anchor.startLine}–${anchor.endLine}`;
}

/**
 * The reading pane's Guide tab: the stops a guide run wrote for this head, in
 * order, with anchors that open Changes at that file. J and K step between
 * stops. A guide written for an older push says so and offers Rewrite.
 * Loaded lazily, with the guide client and its schemas, the first time the tab opens.
 */
export default function PullRequestGuideTab(props: PullRequestGuideTabProps) {
  const [view, setView] = useState<PullRequestGuideView>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState(0);
  const [reloads, setReloads] = useState(0);
  const stopRefs = useRef<Array<HTMLLIElement | null>>([]);
  const { client, target, headSha } = props;
  // The pane builds its target afresh on every render; read again only when it names another pull request.
  const targetKey = `${String(target.projectId)}/${String(target.repositoryOwner)}/${String(target.repositoryName)}#${target.number}`;
  const guides = useMemo(() => createPullRequestGuideClient(client.transport), [client]);

  useEffect(() => {
    const controller = new AbortController();
    void guides
      .read({ target, headSha }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setView(next);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "The review guide is unavailable.");
        }
      });
    return () => controller.abort();
  }, [guides, targetKey, headSha, reloads]);

  const running = view?.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setReloads((count) => count + 1), RUNNING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [running, view]);

  const stops = view?.guide?.stops ?? [];
  useEffect(() => {
    if (stops.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      if (typing || (event.key !== "j" && event.key !== "k")) return;
      event.preventDefault();
      setActive((current) => {
        const next =
          event.key === "j" ? Math.min(stops.length - 1, current + 1) : Math.max(0, current - 1);
        const element = stopRefs.current[next];
        element?.focus();
        element?.scrollIntoView?.({ block: "nearest" });
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stops.length]);

  async function write(): Promise<void> {
    setPending(true);
    setError(undefined);
    try {
      setView(await guides.write(target));
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The guide could not be started.");
    } finally {
      setPending(false);
    }
  }

  if (view === undefined) {
    return error === undefined ? (
      <p className="pr-detail__quiet" role="status">
        Reading the guide…
      </p>
    ) : (
      <OctantAlert layout="row" tone="warning">
        {error}
      </OctantAlert>
    );
  }

  const guide = view.guide;
  const writeLabel = guide === undefined ? "Write guide" : "Rewrite";
  const writable = props.writable !== false;

  return (
    <section aria-label="Review guide" className="pr-guide">
      {!writable ? (
        <p className="pr-detail__quiet" role="status">
          Guides are written while a pull request is open.
        </p>
      ) : !view.modelPicked ? (
        <p className="pr-detail__quiet" role="status">
          Pick a model to write guides: Project settings › Pull request reviews › Guide model.
        </p>
      ) : null}
      {view.stale ? (
        <OctantAlert
          {...(writable
            ? {
                action: (
                  <OctantButton
                    disabled={pending || running || !view.modelPicked}
                    onClick={() => void write()}
                    size="sm"
                    variant="outline"
                  >
                    Rewrite
                  </OctantButton>
                ),
              }
            : {})}
          layout="row"
          tone="warning"
        >
          Written for an older push.
        </OctantAlert>
      ) : null}
      {running ? (
        <p className="pr-detail__quiet" role="status">
          Writing a guide for this push…
        </p>
      ) : null}
      {view.lastFailure === undefined || running ? null : (
        <p className="pr-detail__quiet" role="status">
          {FAILURE_COPY[view.lastFailure]}
        </p>
      )}
      {error === undefined ? null : (
        <OctantAlert layout="row" tone="warning">
          {error}
        </OctantAlert>
      )}
      {guide === undefined ? (
        <div className="pr-guide__empty">
          <p className="pr-detail__quiet">
            No guide for this push yet. A guide walks through the change stop by stop.
          </p>
          {view.modelPicked && writable ? (
            <OctantButton disabled={pending || running} onClick={() => void write()} size="sm">
              {writeLabel}
            </OctantButton>
          ) : null}
        </div>
      ) : (
        <>
          <p className="pr-guide__meta oct-meta">
            {stops.length} {stops.length === 1 ? "stop" : "stops"} · {String(guide.modelId)} on{" "}
            <code>{guide.headSha.slice(0, 7)}</code> · <OctantKbd>J</OctantKbd>{" "}
            <OctantKbd>K</OctantKbd> step between stops
            {view.stale || !writable ? null : (
              <OctantButton
                className="pr-guide__rewrite"
                disabled={pending || running || !view.modelPicked}
                onClick={() => void write()}
                size="sm"
                variant="ghost"
              >
                Rewrite
              </OctantButton>
            )}
          </p>
          <ol className="pr-guide__stops">
            {stops.map((stop, index) => (
              <li
                aria-current={index === active ? "step" : undefined}
                className="pr-guide__stop"
                data-active={index === active ? "" : undefined}
                key={stop.id}
                onFocus={() => setActive(index)}
                ref={(element) => {
                  stopRefs.current[index] = element;
                }}
                tabIndex={-1}
              >
                <p className="pr-guide__title">
                  <span className="pr-guide__number">{index + 1}</span>
                  <strong>{stop.title}</strong>
                  {stop.needsDecision ? (
                    <OctantBadge variant="warning">Needs your decision</OctantBadge>
                  ) : null}
                </p>
                {stop.why.length === 0 ? null : <p className="pr-guide__why">{stop.why}</p>}
                {stop.anchors.length === 0 ? (
                  <p className="pr-detail__quiet">Not anchored to the diff.</p>
                ) : (
                  <ul className="pr-guide__anchors">
                    {stop.anchors.map((anchor) => (
                      <li key={anchorLabel(anchor)}>
                        <OctantButton
                          onClick={() => props.onOpenAnchor(anchor)}
                          size="sm"
                          variant="ghost"
                        >
                          <code>{anchorLabel(anchor)}</code>
                        </OctantButton>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
