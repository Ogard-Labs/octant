import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SideTask, SideTaskContext, SideTaskResult } from "@octant/contracts";
import {
  SideTaskClientFailure,
  type SideTaskClient,
} from "@octant/client-runtime/side-task-client";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import "./follow-up-suggestions.css";

const LazySideTaskCard = lazy(() =>
  import("./SideTaskCardItem").then((module) => ({ default: module.SideTaskCard })),
);

type StartedResult = Extract<SideTaskResult, { readonly kind: "side-task-started" }>;
type SideTaskAction = "start" | "continue" | "dismiss";
type SideTaskBusyAction = SideTaskAction | "reporting";

export interface SideTaskProviderProps {
  /** Absent where a pane has no local thread to offer from; the provider then holds nothing. */
  readonly client?:
    | Pick<SideTaskClient, "sideTasks" | "start" | "continueHere" | "dismiss" | "setReporting">
    | undefined;
  readonly threadId?: string | undefined;
  /** Opens the thread a start created; the prompt is set only when it was not sent. */
  readonly onStarted?:
    | ((started: StartedResult, unsentPrompt: string | undefined) => void)
    | undefined;
  readonly refreshIntervalMs?: number;
  /**
   * The pane mode's navigation revision. A started receipt's child state is
   * read from that mode's navigation, so the list re-reads when it moves —
   * but only while a started task makes the read meaningful.
   */
  readonly navigationRevision?: number | undefined;
  readonly children: ReactNode;
}

interface SideTasksValue {
  readonly tasks: ReadonlyArray<SideTask>;
  readonly busy: { readonly id: string; readonly action: SideTaskBusyAction } | undefined;
  readonly messages: ReadonlyMap<string, string>;
  readonly unconfirmedActions: ReadonlyMap<string, string>;
  readonly deliveries: ReadonlyMap<string, NonNullable<SideTask["continuedDelivery"]>>;
  readonly act: (task: SideTask, action: SideTaskAction, context?: SideTaskContext) => void;
  /** Stops or resumes the reports a started child owes this thread. */
  readonly setReporting: (task: SideTask, on: boolean) => void;
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
  const [unconfirmedActions, setUnconfirmedActions] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [deliveries, setDeliveries] = useState<SideTasksValue["deliveries"]>(new Map());
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
          setUnconfirmedActions(new Map());
        }
      } catch {
        // Keep the last view and any action hold until a fresh host read succeeds.
      }
    },
    [client, threadId],
  );

  const followUpsRevision = useThreadActivityRevision("threadFollowUps");
  const navigationRevision = props.navigationRevision;
  // A started child's state lives on its own thread's navigation row, which
  // the follow-ups feed does not see. The navigation revision joins the
  // refresh only while a started task makes that read meaningful, so streamed
  // tokens on unrelated threads do not re-read the offers.
  const hasStarted = tasks.some((task) => task.status === "started");
  const tracksNavigation = hasStarted && navigationRevision !== undefined;
  const revision = tracksNavigation
    ? (followUpsRevision ?? 0) + navigationRevision
    : followUpsRevision;
  // A different thread or client starts clean; a notice never clears the list.
  useEffect(() => {
    requestGeneration.current += 1;
    setTasks(NO_TASKS);
    setMessages(new Map());
    setUnconfirmedActions(new Map());
    setDeliveries(new Map());
  }, [client, threadId]);

  const refresh = useCallback(async (signal: AbortSignal) => load(signal), [load]);
  useVisibleRefresh(
    refresh,
    revision,
    followUpsRevision === undefined && !tracksNavigation
      ? (props.refreshIntervalMs ?? 4_000)
      : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const setMessage = useCallback((id: string, message: string | undefined) => {
    setMessages((current) => {
      const next = new Map(current);
      if (message === undefined) next.delete(id);
      else next.set(id, message);
      return next;
    });
  }, []);

  const perform = useCallback(
    (
      task: SideTask,
      action: SideTaskBusyAction,
      work: (actedFor: string, id: string) => Promise<SideTaskResult>,
    ) => {
      const id = String(task.offer.id);
      if (
        client === undefined ||
        threadId === undefined ||
        busyRef.current ||
        unconfirmedActions.has(id)
      )
        return;
      const actedFor = threadId;
      busyRef.current = true;
      setBusy({ id, action });
      setMessage(id, undefined);
      void (async () => {
        try {
          const result = await work(actedFor, id);
          // The person still asked for the new thread, so it opens either way;
          // only this pane's cards and messages belong to the thread it shows.
          if (result.kind === "side-task-started") {
            latestOnStarted.current?.(result, result.sent ? undefined : task.offer.prompt);
          }
          if (currentThread.current !== actedFor) return;
          if (result.kind === "side-task-started" && !result.sent) {
            setMessage(
              id,
              "The thread was created, but its first message was not sent. Send it from there.",
            );
          } else if (result.kind === "side-task-continued-here") {
            setDeliveries((current) => new Map(current).set(id, result.delivery));
          } else if (result.kind === "side-task-refused") {
            setMessage(id, result.message);
          }
          if (result.kind !== "side-task-refused") {
            setUnconfirmedActions((current) =>
              new Map(current).set(id, "This computer recorded this action."),
            );
          }
          await load();
        } catch (failure) {
          if (currentThread.current !== actedFor) return;
          setUnconfirmedActions((current) =>
            new Map(current).set(
              id,
              failure instanceof SideTaskClientFailure
                ? failure.message
                : "The action's result is unknown.",
            ),
          );
          await load();
        } finally {
          busyRef.current = false;
          setBusy(undefined);
        }
      })();
    },
    [client, load, setMessage, threadId, unconfirmedActions],
  );

  const act = useCallback(
    (task: SideTask, action: SideTaskAction, context?: SideTaskContext) => {
      if (client === undefined) return;
      perform(task, action, (actedFor, id) =>
        action === "start"
          ? client.start(actedFor, id, context)
          : action === "continue"
            ? client.continueHere(actedFor, id)
            : client.dismiss(actedFor, id),
      );
    },
    [client, perform],
  );

  const setReporting = useCallback(
    (task: SideTask, on: boolean) => {
      if (client === undefined) return;
      perform(task, "reporting", (actedFor, id) => client.setReporting(actedFor, id, on));
    },
    [client, perform],
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
    () =>
      client === undefined
        ? undefined
        : { tasks, busy, messages, unconfirmedActions, deliveries, act, setReporting, open },
    [act, busy, client, deliveries, messages, setReporting, unconfirmedActions, open, tasks],
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
  const value = useContext(SideTasksContext);
  const tasks = value?.tasks ?? NO_TASKS;
  const here = sideTasksAfterTurn(tasks, props);
  if (here.length === 0 || value === undefined) return null;
  return (
    <div className="side-tasks">
      <Suspense fallback={null}>
        {here.map((task) => (
          <LazySideTaskCard
            controller={value}
            key={String(task.offer.id)}
            running={props.running}
            task={task}
          />
        ))}
      </Suspense>
    </div>
  );
}
