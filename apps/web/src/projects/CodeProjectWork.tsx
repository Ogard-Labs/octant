import { useCallback, useEffect, useRef, useState } from "react";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeProjectReportPage, CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import {
  COORDINATOR_WORKER_STATE_WORDS,
  coordinatorWorkerState,
} from "../code/coordinatorWorkerPanel";
import type { CodeThreadNavigationItem } from "../code/useCodeController";
import { OctantButton } from "../ui/base/OctantButton";

export function CodeProjectWork(props: {
  readonly projectId: ProjectId;
  readonly conversationId: CodeThreadId;
  readonly client: CodeClient;
  readonly onRead: (id: CodeThreadId, sequence: number) => void;
  readonly reportSequence: number;
  readonly threads: ReadonlyArray<CodeThreadNavigationItem>;
  readonly onOpen: (id: CodeThreadId, title: string) => void;
  readonly onOpenBeside: (id: CodeThreadId, title: string) => void;
}) {
  const { projectId, client, reportSequence } = props;
  const [page, setPage] = useState<CodeProjectReportPage>();
  const [failure, setFailure] = useState<string>();
  const [before, setBefore] = useState<CodeProjectReportPage["next"]>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController>(null);

  const readReports = useCallback(
    (abort: AbortController, cursor?: CodeProjectReportPage["next"]) => {
      setLoading(true);
      setFailure(undefined);
      void client
        .execute(
          {
            kind: "read-code-project-report-page",
            projectId,
            ...(cursor === undefined ? {} : { before: cursor }),
          },
          abort.signal,
        )
        .then((result) => {
          if (abort.signal.aborted) return;
          if (result.kind !== "project-report-page")
            throw new Error("Project reports are unavailable.");
          setPage((current) => {
            if (cursor === undefined || current === undefined) return result;
            const seen = new Set(current.reports.map((report) => report.operationId));
            return {
              ...result,
              reports: [
                ...current.reports,
                ...result.reports.filter((report) => !seen.has(report.operationId)),
              ],
            };
          });
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted)
            setFailure(error instanceof Error ? error.message : "Project reports are unavailable.");
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    },
    [client, projectId],
  );

  useEffect(() => {
    const abort = new AbortController();
    request.current = abort;
    setBefore(undefined);
    readReports(abort);
    return () => abort.abort();
  }, [readReports, reportSequence, retry]);

  function loadEarlier() {
    const cursor = page?.next;
    if (request.current === null || cursor === undefined || loading) return;
    setBefore(cursor);
    readReports(request.current, cursor);
  }

  const reports = page?.reports ?? [];
  const newestReport = reports[0]?.sequence;
  const { conversationId, onRead } = props;
  const latestResult = useRef<HTMLElement>(null);
  useEffect(() => {
    const result = latestResult.current;
    if (newestReport === undefined || result === null) return;
    let visible = false;
    const recordReading = () => {
      if (visible && document.visibilityState === "visible") onRead(conversationId, newestReport);
    };
    if (typeof IntersectionObserver === "undefined") {
      if (document.visibilityState === "visible") onRead(conversationId, newestReport);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      recordReading();
    });
    observer.observe(result);
    document.addEventListener("visibilitychange", recordReading);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", recordReading);
    };
  }, [conversationId, newestReport, onRead]);
  const workers = props.threads.filter(
    (thread) => thread.projectId === projectId && thread.coordinatorThreadId !== undefined,
  );
  const needsYou = workers.filter((worker) => worker.awaitingInput === true).length;
  const working = workers.filter((worker) => worker.executing === true).length;
  const links = (id: CodeThreadId, title: string) => (
    <>
      <OctantButton variant="ghost" size="sm" onClick={() => props.onOpen(id, title)}>
        {title}
      </OctantButton>
      <OctantButton
        variant="ghost"
        size="sm"
        aria-label={`Open ${title} beside the Project`}
        onClick={() => props.onOpenBeside(id, title)}
      >
        Open beside
      </OctantButton>
    </>
  );
  if (workers.length === 0 && reports.length === 0 && failure === undefined) return null;
  return (
    <section className="project-work thread-column" aria-label="Project work">
      {workers.length > 0 && (
        <details>
          <summary>
            {workers.length} {workers.length === 1 ? "worker" : "workers"} · {working} working ·{" "}
            Needs you ({needsYou})
          </summary>
          <ul>
            {workers.map((worker) => (
              <li key={worker.threadId}>
                {links(worker.threadId, worker.title)}
                <span>
                  {COORDINATOR_WORKER_STATE_WORDS[coordinatorWorkerState(worker)]} ·{" "}
                  {worker.coordinatorThreadId === props.conversationId
                    ? "Project conversation"
                    : (props.threads.find((owner) => owner.threadId === worker.coordinatorThreadId)
                        ?.title ?? "Former coordinator")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {reports.length > 0 && (
        <section aria-label="Project report">
          <h3>Project report</h3>
          {reports.map((report, index) => (
            <article key={report.operationId} ref={index === 0 ? latestResult : undefined}>
              <header>{links(report.workerId, report.title)}</header>
              <span className="project-work__outcome">
                {
                  {
                    completed: "Completed",
                    waiting: "Waiting",
                    failed: "Failed",
                    interrupted: "Interrupted",
                    ambiguous: "Outcome unknown",
                  }[report.state]
                }
              </span>
              {report.summary && <p>{report.summary}</p>}
            </article>
          ))}
          {page?.next !== undefined && (failure === undefined || before === undefined) && (
            <OctantButton size="sm" variant="ghost" disabled={loading} onClick={loadEarlier}>
              {loading && before !== undefined ? "Loading earlier reports" : "Load earlier reports"}
            </OctantButton>
          )}
        </section>
      )}
      {failure && (
        <p role="status">
          {failure}{" "}
          <OctantButton
            size="sm"
            variant="ghost"
            onClick={() => {
              if (before === undefined) setRetry((n) => n + 1);
              else loadEarlier();
            }}
          >
            Retry
          </OctantButton>
        </p>
      )}
    </section>
  );
}
