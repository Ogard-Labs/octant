import type { PendingRequest } from "@octant/contracts/pending-requests";
import { useContext, useMemo, useState } from "react";
import "../agents/agent-hierarchy.css";
import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import { pendingRequestKey } from "../pendingRequests/pendingRequests";
import {
  usePendingRequestRows,
  type PendingRequestRowsSource,
} from "../pendingRequests/usePendingRequestRows";
import { useMinuteTick } from "../polling/useMinuteTick";
import { ThreadConnectionLostContext } from "../transcript/ThreadConnectionNotice";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

/** A worker as the window's thread list names it. */
export interface CoordinatorWorker {
  readonly threadId: string;
  readonly title: string;
}

/** The window's pending-request reader and answer clients; the clock is the component's own. */
export type CoordinatorWorkerRequestSource = Omit<PendingRequestRowsSource, "now">;

const CODE_MODE = ["code"] as const;

/**
 * A worker's approval or question as the coordinator's composer lists it.
 * A decision is the ask a finished worker turn closed with, not something the
 * worker waits on, so it stays in Needs you and the worker.
 */
function isWorkerRequest(request: PendingRequest, workers: ReadonlyMap<string, string>): boolean {
  return (
    request.mode === "code" && request.kind !== "decision" && workers.has(String(request.threadId))
  );
}

/**
 * A coordinator's workers' pending approvals and questions, in the bounded
 * region above its composer where a child run's requests are listed. It reads
 * the window's own pending-request list, so it shows only requests this window
 * could already answer elsewhere, and answers each through the worker's own
 * command with the handle the host listed: the same request a Needs you row or
 * the worker answers. The coordinator agent has no part in it.
 */
export function CoordinatorWorkerRequests(props: {
  readonly source: CoordinatorWorkerRequestSource;
  readonly workers: ReadonlyArray<CoordinatorWorker>;
  readonly onOpenWorker: (worker: CoordinatorWorker) => void;
}) {
  // The thread already says its host connection is lost; the region keeps the
  // request in view and offers no answer, as a child run's request does.
  const connectionLost = useContext(ThreadConnectionLostContext);
  const now = useMinuteTick().getTime();
  const source = useMemo<PendingRequestRowsSource>(
    () => ({ ...props.source, modes: CODE_MODE, now }),
    [props.source, now],
  );
  const { rows, answer } = usePendingRequestRows(source);
  const [selected, setSelected] = useState<string>();
  const workers = useMemo(
    () => new Map(props.workers.map((worker) => [worker.threadId, worker.title])),
    [props.workers],
  );
  const waiting = (rows ?? []).filter((entry) => isWorkerRequest(entry.request, workers));
  const entry =
    waiting.find((candidate) => pendingRequestKey(candidate.request) === selected) ?? waiting[0];
  if (entry === undefined) return null;
  const threadId = String(entry.request.threadId);
  const worker: CoordinatorWorker = {
    threadId,
    title: workers.get(threadId) ?? entry.request.threadTitle,
  };
  const openWorker = () => props.onOpenWorker(worker);
  return (
    <section aria-label="Worker requests" className="composer-child-requests">
      <div className="composer-subagents__head">
        <strong>A worker needs your input</strong>
        <OctantButton size="xs" variant="link" onClick={openWorker}>
          Open worker
        </OctantButton>
      </div>
      <p title={worker.title}>{worker.title}</p>
      {waiting.length < 2 ? null : (
        <div
          className="composer-child-requests__choices"
          role="group"
          aria-label="Pending worker requests"
        >
          {waiting.map((candidate, index) => (
            <OctantButton
              key={pendingRequestKey(candidate.request)}
              size="xs"
              variant="ghost"
              aria-pressed={candidate === entry}
              onClick={() => setSelected(pendingRequestKey(candidate.request))}
            >
              Request {index + 1}
            </OctantButton>
          ))}
        </div>
      )}
      {connectionLost ? (
        <OctantAlert tone="warning">Reconnect to answer this request.</OctantAlert>
      ) : null}
      <PendingRequestRow
        embedded
        key={pendingRequestKey(entry.request)}
        now={now}
        onAnswer={answer}
        onOpenThread={openWorker}
        request={entry.request}
        settled={entry.unlisted || connectionLost}
      />
    </section>
  );
}
