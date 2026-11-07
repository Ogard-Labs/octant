import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GitBranch, MessageSquarePlus, X } from "lucide-react";
import type { SideTask, SideTaskContext, SideTaskResult } from "@octant/contracts";
import {
  SideTaskClientFailure,
  type SideTaskClient,
} from "@octant/client-runtime/side-task-client";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";
import { moveWithinRadioGroup } from "../ui/base/radioGroupKeys";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import "./follow-up-suggestions.css";

type StartedResult = Extract<SideTaskResult, { readonly kind: "side-task-started" }>;
type SideTaskAction = "start" | "continue" | "dismiss";

export interface SideTaskProviderProps {
  /** Absent where a pane has no local thread to offer from; the provider then holds nothing. */
  readonly client?:
    | Pick<SideTaskClient, "sideTasks" | "start" | "continueHere" | "dismiss">
    | undefined;
  readonly threadId?: string | undefined;
  /** Opens the thread a start created; the prompt is set only when it was not sent. */
  readonly onStarted?:
    | ((started: StartedResult, unsentPrompt: string | undefined) => void)
    | undefined;
  readonly refreshIntervalMs?: number;
  readonly children: ReactNode;
}

interface SideTasksValue {
  readonly tasks: ReadonlyArray<SideTask>;
  readonly busy: { readonly id: string; readonly action: SideTaskAction } | undefined;
  readonly messages: ReadonlyMap<string, string>;
  readonly deliveries: ReadonlyMap<string, "sent" | "queued">;
  readonly act: (task: SideTask, action: SideTaskAction, context?: SideTaskContext) => void;
  readonly open: (task: SideTask) => void;
}

const SideTasksContext = createContext<SideTasksValue | undefined>(undefined);

const NO_TASKS: ReadonlyArray<SideTask> = [];

/**
 * Loads a thread's side-task offers once for the pane, so every card in its
 * transcript reads one list instead of fetching its own, and owns the actions
 * so only one runs at a time. It renders its children in every case, so a pane
 * without offers keeps its tree unchanged.
 */
export function SideTaskProvider(props: SideTaskProviderProps) {
  const { client, threadId, onStarted } = props;
  const [tasks, setTasks] = useState<ReadonlyArray<SideTask>>(NO_TASKS);
  const [busy, setBusy] = useState<SideTasksValue["busy"]>();
  const busyRef = useRef(false);
  const [messages, setMessages] = useState<ReadonlyMap<string, string>>(new Map());
  const [deliveries, setDeliveries] = useState<ReadonlyMap<string, "sent" | "queued">>(new Map());
  const requestGeneration = useRef(0);
  // The pane can move to another thread while an action is on its way.
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const latestOnStarted = useRef(onStarted);
  latestOnStarted.current = onStarted;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (client === undefined || threadId === undefined) return;
      const generation = ++requestGeneration.current;
      try {
        const next = await client.sideTasks(threadId);
        if (signal?.aborted !== true && requestGeneration.current === generation) {
          setTasks((current) => (samePollingData(current, next.tasks) ? current : next.tasks));
        }
      } catch {
        // An offer is not state the person is waiting on; the next read retries.
      }
    },
    [client, threadId],
  );

  const revision = useThreadActivityRevision("threadFollowUps");
  // A different thread or client starts clean; a notice never clears the list.
  useEffect(() => {
    requestGeneration.current += 1;
    setTasks(NO_TASKS);
    setMessages(new Map());
    setDeliveries(new Map());
  }, [client, threadId]);

  const refresh = useCallback(async (signal: AbortSignal) => load(signal), [load]);
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? (props.refreshIntervalMs ?? 4_000) : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const setMessage = useCallback((id: string, message: string | undefined) => {
    setMessages((current) => {
      const next = new Map(current);
      if (message === undefined) next.delete(id);
      else next.set(id, message);
      return next;
    });
  }, []);

  const act = useCallback(
    (task: SideTask, action: SideTaskAction, context?: SideTaskContext) => {
      if (client === undefined || threadId === undefined || busyRef.current) return;
      const id = String(task.offer.id);
      const actedFor = threadId;
      busyRef.current = true;
      setBusy({ id, action });
      setMessage(id, undefined);
      void (async () => {
        try {
          const result =
            action === "start"
              ? await client.start(actedFor, id, context)
              : action === "continue"
                ? await client.continueHere(actedFor, id)
                : await client.dismiss(actedFor, id);
          // The person still asked for the new thread, so it opens either way;
          // only this pane's cards and messages belong to the thread it shows.
          if (result.kind === "side-task-started") {
            latestOnStarted.current?.(result, result.sent ? undefined : task.offer.prompt);
          }
          if (currentThread.current !== actedFor) return;
          if (result.kind === "side-task-started" && !result.sent) {
            setMessage(
              id,
              "The thread was created, but its first message did not go out. It is ready to send there.",
            );
          } else if (result.kind === "side-task-continued-here") {
            setDeliveries((current) => new Map(current).set(id, result.delivery));
          } else if (result.kind === "side-task-refused") {
            setMessage(id, result.message);
          }
          await load();
        } catch (failure) {
          if (currentThread.current !== actedFor) return;
          setMessage(
            id,
            failure instanceof SideTaskClientFailure ? failure.message : "The side task failed.",
          );
        } finally {
          busyRef.current = false;
          setBusy(undefined);
        }
      })();
    },
    [client, load, setMessage, threadId],
  );

  const open = useCallback((task: SideTask) => {
    if (task.startedThreadId === undefined) return;
    latestOnStarted.current?.(
      {
        kind: "side-task-started",
        sideTaskId: task.offer.id,
        mode: task.offer.mode,
        threadId: task.startedThreadId,
        title: task.offer.title,
        ...(task.offer.projectId === undefined ? {} : { projectId: task.offer.projectId }),
        startedWith: task.startedWith ?? "fresh",
        sent: true,
      },
      undefined,
    );
  }, []);

  const value = useMemo<SideTasksValue | undefined>(
    () => (client === undefined ? undefined : { tasks, busy, messages, deliveries, act, open }),
    [act, busy, client, deliveries, messages, open, tasks],
  );
  return <SideTasksContext value={value}>{props.children}</SideTasksContext>;
}

/** The offers a pane's thread holds, for a transcript that decides where cards go. */
export function useThreadSideTasks(): ReadonlyArray<SideTask> {
  return useContext(SideTasksContext)?.tasks ?? NO_TASKS;
}

export interface SideTaskPlacement {
  /** The turn whose reply the cards follow, in the mode's own identity. */
  readonly turnId: string;
  /** The offering turn has not finished, so a fork cannot be taken yet. */
  readonly running: boolean;
  /** This is the last reply in the loaded transcript, which takes offers with no loaded turn. */
  readonly last: boolean;
  readonly loadedTurnIds: ReadonlySet<string>;
}

/** The offers that sit after this turn's reply, oldest first. */
export function sideTasksAfterTurn(
  tasks: ReadonlyArray<SideTask>,
  placement: Pick<SideTaskPlacement, "turnId" | "last" | "loadedTurnIds">,
): ReadonlyArray<SideTask> {
  return tasks
    .filter((task) => {
      const turnId = task.offer.turnId;
      if (turnId === undefined || !placement.loadedTurnIds.has(turnId)) return placement.last;
      return turnId === placement.turnId;
    })
    .toReversed();
}

/** The side-task cards and receipts that follow one reply in a transcript. */
export function SideTaskInline(props: SideTaskPlacement) {
  const tasks = useThreadSideTasks();
  const here = sideTasksAfterTurn(tasks, props);
  if (here.length === 0) return null;
  return (
    <div className="side-tasks">
      {here.map((task) => (
        <SideTaskCard key={String(task.offer.id)} running={props.running} task={task} />
      ))}
    </div>
  );
}

function wantsWorktree(task: SideTask, context: SideTaskContext): boolean {
  return task.offer.mode === "code" && (task.offer.target === "new-worktree" || context === "fork");
}

function SideTaskCard(props: { readonly task: SideTask; readonly running: boolean }) {
  const { task } = props;
  const value = useContext(SideTasksContext);
  const id = String(task.offer.id);
  const hintId = useId();
  const [chosen, setChosen] = useState<SideTaskContext>();
  if (value === undefined) return null;
  const message = value.messages.get(id);
  const failure =
    message === undefined ? null : (
      <OctantAlert className="side-task__error" tone="danger">
        {message}
      </OctantAlert>
    );

  if (task.status !== "offered") {
    const delivery = task.continuedDelivery ?? value.deliveries.get(id);
    return (
      <div aria-label={`Side task: ${task.offer.title}`} className="side-task-receipt" role="group">
        <p className="side-task-receipt__line">
          <span className="side-task-receipt__title">{task.offer.title}</span>
          <span aria-hidden="true"> · </span>
          {task.status === "started" ? (
            <>
              {task.startedWith === "fork" ? "Forked into a new thread" : "Started in a new thread"}
              {task.startedThreadId === undefined ? null : (
                <>
                  <span aria-hidden="true"> · </span>
                  <OctantButton
                    className="side-task-receipt__open"
                    onClick={() => value.open(task)}
                    size={null}
                    type="button"
                    variant="link"
                  >
                    Open
                  </OctantButton>
                </>
              )}
            </>
          ) : task.status === "continued-here" ? (
            delivery === "queued" ? (
              "Queued here, runs after the current reply"
            ) : (
              "Doing it here"
            )
          ) : (
            "Dismissed"
          )}
        </p>
        {failure}
      </div>
    );
  }

  const busyHere = value.busy?.id === id ? value.busy.action : undefined;
  const blocked = value.busy !== undefined;
  // A fork needs a settled offering turn, so until then the choice shows fresh.
  const context: SideTaskContext = props.running
    ? "fresh"
    : (chosen ?? task.offer.context ?? "fresh");
  const worktree = wantsWorktree(task, context);
  const destination = worktree
    ? "a new worktree"
    : task.offer.mode === "chat"
      ? "a new chat"
      : "a new thread";
  const newLabel = worktree
    ? "New worktree"
    : task.offer.mode === "chat"
      ? "New chat"
      : "New thread";
  const hint = props.running
    ? "Available when this reply finishes."
    : task.offer.mode === "code"
      ? "Including the conversation starts a new worktree from where this reply left the files."
      : undefined;
  return (
    <article aria-label={`Side task: ${task.offer.title}`} className="side-task">
      <div className="side-task__head">
        {task.offer.target === "new-worktree" ? (
          <GitBranch aria-hidden="true" size={14} />
        ) : (
          <MessageSquarePlus aria-hidden="true" size={14} />
        )}
        <strong className="side-task__title">{task.offer.title}</strong>
        <OctantIconButton
          disabled={blocked}
          label={`Dismiss ${task.offer.title}`}
          onClick={() => value.act(task, "dismiss")}
          size="icon-xs"
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </OctantIconButton>
      </div>
      <p className="side-task__reason">{task.offer.reason}</p>
      <details className="side-task__prompt">
        <summary>Prompt</summary>
        <p>{task.offer.prompt}</p>
      </details>
      <p className="side-task__question">Start this in {destination}, or do it here?</p>
      <div
        aria-label="What the new thread starts with"
        className="side-task__context"
        onKeyDown={moveWithinRadioGroup}
        role="radiogroup"
      >
        <OctantButton
          aria-checked={context === "fresh"}
          disabled={blocked}
          onClick={() => setChosen("fresh")}
          role="radio"
          size="xs"
          type="button"
          variant={context === "fresh" ? "secondary" : "ghost"}
        >
          Fresh
        </OctantButton>
        <OctantButton
          aria-checked={context === "fork"}
          {...(hint === undefined ? {} : { "aria-describedby": hintId })}
          disabled={blocked || props.running}
          onClick={() => setChosen("fork")}
          role="radio"
          size="xs"
          type="button"
          variant={context === "fork" ? "secondary" : "ghost"}
        >
          Include this conversation
        </OctantButton>
      </div>
      {hint === undefined ? null : (
        <p className="side-task__hint" id={hintId}>
          {hint}
        </p>
      )}
      <div className="side-task__actions">
        <OctantButton
          disabled={blocked}
          onClick={() => value.act(task, "start", context)}
          size="xs"
          type="button"
        >
          {busyHere === "start" ? "Starting…" : newLabel}
        </OctantButton>
        <OctantButton
          disabled={blocked}
          onClick={() => value.act(task, "continue")}
          size="xs"
          type="button"
          variant="outline"
        >
          {busyHere === "continue" ? "Sending…" : "Do it here"}
        </OctantButton>
      </div>
      {failure}
    </article>
  );
}
