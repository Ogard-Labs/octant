import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, MessageSquarePlus, X } from "lucide-react";
import type { OctantMode, SideTask, SideTaskResult } from "@octant/contracts";
import {
  SideTaskClientFailure,
  type SideTaskClient,
} from "@octant/client-runtime/side-task-client";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import "./follow-up-suggestions.css";

export interface SideTaskCardsProps {
  readonly client: Pick<SideTaskClient, "sideTasks" | "start" | "dismiss">;
  readonly threadId: string;
  /** Opens the thread a start created; the prompt is set only when it was not sent. */
  readonly onStarted: (
    started: Extract<SideTaskResult, { readonly kind: "side-task-started" }>,
    unsentPrompt: string | undefined,
  ) => void;
  readonly refreshIntervalMs?: number;
}

function startLabel(task: SideTask, mode: OctantMode): string {
  if (task.offer.target === "new-worktree") return "Start in new worktree";
  return mode === "chat" ? "Start in new chat" : "Start in new thread";
}

/**
 * Work the model noticed and offered to run separately, as cards over the
 * composer. The person reads why, may read the exact prompt, and starts or
 * dismisses each one; starting creates the thread and sends the prompt.
 */
export function SideTaskCards(props: SideTaskCardsProps) {
  const [tasks, setTasks] = useState<ReadonlyArray<SideTask>>([]);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const requestGeneration = useRef(0);
  const { client, threadId } = props;
  // The pane can move to another thread while a start or dismissal is on its way.
  const currentThread = useRef(threadId);
  currentThread.current = threadId;

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const next = await client.sideTasks(threadId);
      if (requestGeneration.current === generation) setTasks(next.tasks);
    } catch {
      // An offer is not state the person is waiting on; the next tick retries.
    }
  }, [client, threadId]);

  useEffect(() => {
    setTasks([]);
    setError(undefined);
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      void load().finally(() => {
        inFlight = false;
      });
    };
    tick();
    const stop = scheduleVisibleInterval(tick, props.refreshIntervalMs ?? 4_000);
    return () => {
      requestGeneration.current += 1;
      stop();
    };
  }, [load, props.refreshIntervalMs]);

  const offered = tasks.filter((task) => task.status === "offered").reverse();
  if (offered.length === 0 && error === undefined) return null;

  const act = async (task: SideTask, action: "start" | "dismiss") => {
    const id = String(task.offer.id);
    if (busyId !== undefined) return;
    setBusyId(id);
    setError(undefined);
    const actedFor = threadId;
    try {
      const result =
        action === "start" ? await client.start(actedFor, id) : await client.dismiss(actedFor, id);
      // The person still asked for the new thread, so it opens either way;
      // only this pane's cards and messages belong to the thread it shows.
      if (result.kind === "side-task-started") {
        props.onStarted(result, result.sent ? undefined : task.offer.prompt);
      }
      if (currentThread.current !== actedFor) return;
      if (result.kind === "side-task-started") {
        if (!result.sent) {
          setError(
            "The thread was created, but its first message did not go out. It is ready to send there.",
          );
        }
      } else if (result.kind === "side-task-refused") {
        setError(result.message);
      }
      await load();
    } catch (failure) {
      if (currentThread.current !== actedFor) return;
      setError(
        failure instanceof SideTaskClientFailure ? failure.message : "The side task failed.",
      );
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div aria-label="Side tasks" className="composer-side-tasks" role="group">
      {offered.map((task) => (
        <article
          aria-label={`Side task: ${task.offer.title}`}
          className="composer-side-task"
          key={String(task.offer.id)}
        >
          <div className="composer-side-task__head">
            {task.offer.target === "new-worktree" ? (
              <GitBranch aria-hidden="true" size={14} />
            ) : (
              <MessageSquarePlus aria-hidden="true" size={14} />
            )}
            <strong className="composer-side-task__title">{task.offer.title}</strong>
            <OctantIconButton
              disabled={busyId !== undefined}
              label={`Dismiss ${task.offer.title}`}
              onClick={() => void act(task, "dismiss")}
              size="icon-xs"
              type="button"
            >
              <X aria-hidden="true" size={12} />
            </OctantIconButton>
          </div>
          <p className="composer-side-task__reason">{task.offer.reason}</p>
          <details className="composer-side-task__prompt">
            <summary>Prompt</summary>
            <p>{task.offer.prompt}</p>
          </details>
          <div className="composer-side-task__actions">
            <OctantButton
              disabled={busyId !== undefined}
              onClick={() => void act(task, "start")}
              size="xs"
              type="button"
            >
              {busyId === String(task.offer.id) ? "Starting…" : startLabel(task, task.offer.mode)}
            </OctantButton>
          </div>
        </article>
      ))}
      {error === undefined ? null : (
        <p className="composer-follow-ups__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
