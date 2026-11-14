import type { PendingRequest } from "@octant/contracts/pending-requests";
import { useContext, useEffect, useMemo, useState } from "react";
import "../agents/agent-hierarchy.css";
import "../followUps/follow-up-suggestions.css";
import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import { pendingRequestKey, type PendingRequestResponse } from "../pendingRequests/pendingRequests";
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

/** Settled rows kept in the transcript; older ones leave so the trail stays short. */
const MAX_SETTLED_ASKS = 12;

/**
 * The requests a thread view keeps: every live one, and the most recent
 * settled ones up to {@link MAX_SETTLED_ASKS}, in arrival order. An evicted
 * request leaves storage, not only the screen, so a long-lived coordinator
 * view does not grow with every request it has ever shown.
 */
export function retainedWorkerAsks<T>(
  seen: ReadonlyMap<string, T>,
  live: ReadonlySet<string>,
): ReadonlyMap<string, T> {
  const settled = [...seen.keys()].filter((key) => !live.has(key));
  if (settled.length <= MAX_SETTLED_ASKS) return seen;
  const evicted = new Set(settled.slice(0, settled.length - MAX_SETTLED_ASKS));
  return new Map([...seen].filter(([key]) => !evicted.has(key)));
}

/** What an answer given in this row did, in the words its settled row reads. */
function answeredHere(response: PendingRequestResponse): string {
  if (response.kind === "approve") return "Approved here";
  if (response.kind === "deny") return "Denied here";
  return `Answered here: ${response.label}`;
}

/**
 * A request this row did not answer leaves the host's list when the person
 * answers it in the worker, in Needs you, or in the composer, or when the
 * worker's turn ends without it; the list does not say which.
 */
const LEFT_THE_LIST = "No longer waiting: answered elsewhere or its turn ended";

/**
 * A coordinator's workers' pending approvals and questions as rows at the end
 * of the coordinator's transcript, oldest first, each naming its worker and
 * answered in place (docs/design/coordinator-threads.md#questions-and-approvals).
 * Rows read the same window list as the composer's region and answer through
 * the worker's own command, so answering here, in the composer, in the worker,
 * or in Needs you settles one request. A row whose request leaves the list
 * stays, reading its outcome, until the thread view closes. The coordinator
 * agent has no part in it.
 */
export function CoordinatorWorkerAskRows(props: {
  readonly source: CoordinatorWorkerRequestSource;
  readonly workers: ReadonlyArray<CoordinatorWorker>;
  readonly onOpenWorker: (worker: CoordinatorWorker) => void;
}) {
  const connectionLost = useContext(ThreadConnectionLostContext);
  const now = useMinuteTick().getTime();
  const source = useMemo<PendingRequestRowsSource>(
    () => ({ ...props.source, modes: CODE_MODE, now }),
    [props.source, now],
  );
  const { rows, answer } = usePendingRequestRows(source);
  const workers = useMemo(
    () => new Map(props.workers.map((worker) => [worker.threadId, worker.title])),
    [props.workers],
  );
  const waiting = useMemo(
    () => (rows ?? []).filter((entry) => isWorkerRequest(entry.request, workers)),
    [rows, workers],
  );
  // Every worker request this view has shown, in arrival order, so one that
  // leaves the list keeps its row and can read how it left.
  const [seen, setSeen] = useState<ReadonlyMap<string, PendingRequest>>(new Map());
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    setSeen((current) => {
      const fresh = waiting.filter((entry) => !current.has(pendingRequestKey(entry.request)));
      let next = current;
      if (fresh.length > 0) {
        const added = new Map(current);
        for (const entry of fresh) added.set(pendingRequestKey(entry.request), entry.request);
        next = added;
      }
      return retainedWorkerAsks(
        next,
        new Set(waiting.map((entry) => pendingRequestKey(entry.request))),
      );
    });
  }, [waiting]);
  // An outcome is kept only while its request's row is.
  useEffect(() => {
    setAnswers((current) =>
      [...current.keys()].every((key) => seen.has(key))
        ? current
        : new Map([...current].filter(([key]) => seen.has(key))),
    );
  }, [seen]);

  const live = new Map(waiting.map((entry) => [pendingRequestKey(entry.request), entry]));
  // The same bound on screen, for the render before the effect prunes storage.
  const shown = [...retainedWorkerAsks(seen, new Set(live.keys()))];
  if (shown.length === 0) return null;

  async function answerInRow(request: PendingRequest, response: PendingRequestResponse) {
    const result = await answer(request, response);
    if (result.status === "answered")
      setAnswers((current) =>
        new Map(current).set(pendingRequestKey(request), answeredHere(response)),
      );
    return result;
  }

  return (
    <section aria-label="Workers' requests" className="follow-up-cards thread-column">
      {connectionLost ? (
        <OctantAlert tone="warning">Reconnect to answer these requests.</OctantAlert>
      ) : null}
      {shown.map(([key, request]) => {
        const entry = live.get(key);
        const threadId = String(request.threadId);
        const worker: CoordinatorWorker = {
          threadId,
          title: workers.get(threadId) ?? request.threadTitle,
        };
        return (
          <div className="follow-up-card" key={key}>
            <PendingRequestRow
              now={now}
              onAnswer={answerInRow}
              onOpenThread={() => props.onOpenWorker(worker)}
              outcome={entry === undefined ? (answers.get(key) ?? LEFT_THE_LIST) : undefined}
              request={{ ...request, threadTitle: worker.title }}
              settled={entry?.unlisted === true || connectionLost}
            />
          </div>
        );
      })}
    </section>
  );
}
