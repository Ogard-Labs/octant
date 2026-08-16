import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeThreadGoalCommand,
  type ThreadGoal,
  type ThreadGoalHistoryEntry,
} from "@octant/contracts";
import { GoalClientFailure, type GoalClient } from "@octant/client-runtime/goal-client";

export type GoalStatus = "idle" | "loading" | "ready" | "unauthorized" | "unavailable" | "failure";

export interface UseGoalControllerOptions {
  readonly client: GoalClient | undefined;
  readonly enabled: boolean;
  readonly threadId: string | undefined;
  /** Injectable id source so tests do not depend on the realm's crypto. */
  readonly newId?: () => string;
}

export interface GoalController {
  readonly goal: ThreadGoal | null;
  readonly history: ReadonlyArray<ThreadGoalHistoryEntry>;
  readonly status: GoalStatus;
  /** Message for the last refused command, cleared when the next one starts. */
  readonly commandMessage: string | undefined;
  readonly pending: boolean;
  readonly reload: () => void;
  readonly create: (objective: string) => Promise<boolean>;
  readonly pause: () => Promise<boolean>;
  readonly resume: () => Promise<boolean>;
  readonly revise: (objective: string) => Promise<boolean>;
  readonly complete: () => Promise<boolean>;
}

/**
 * Read/command controller for the authoritative thread Goal surface.
 *
 * The host owns Goal transitions and versions: every command carries the
 * version this window last read and the reply replaces local state, so nothing
 * is shown as done before the host accepted it. A superseded load is discarded
 * by generation, so a slow response for a previous thread can never repaint
 * another thread's Goal, and a version conflict re-reads instead of retrying on
 * a version the host already refused.
 */
export function useGoalController(options: UseGoalControllerOptions): GoalController {
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<ThreadGoalHistoryEntry>>([]);
  const [status, setStatus] = useState<GoalStatus>("idle");
  const [commandMessage, setCommandMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const currentGoal = useRef<ThreadGoal | null>(null);
  const idSource = useRef(options.newId);
  idSource.current = options.newId;

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const { client, enabled, threadId } = options;

  useEffect(() => {
    const operation = ++generation.current;
    if (!enabled || client === undefined || threadId === undefined) {
      currentGoal.current = null;
      setGoal(null);
      setHistory([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    void client
      .read(threadId, controller.signal)
      .then((projection) => {
        if (generation.current !== operation) return;
        currentGoal.current = projection.goal;
        setGoal(projection.goal);
        setHistory(projection.history);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (generation.current !== operation) return;
        currentGoal.current = null;
        setGoal(null);
        setHistory([]);
        setStatus(classify(error));
      });
    return () => {
      controller.abort();
    };
  }, [client, enabled, threadId, reloadToken]);

  const mintId = useCallback(
    () => (idSource.current ?? (() => globalThis.crypto.randomUUID()))(),
    [],
  );

  /**
   * Builds the command from the Goal this window last read, decodes it against
   * the shared contract, and adopts the host's reply. Building from the read
   * Goal keeps `expectedVersion` honest instead of asserting a version.
   */
  const run = useCallback(
    async (build: (current: ThreadGoal | null) => unknown) => {
      if (client === undefined || threadId === undefined) return false;
      const raw = build(currentGoal.current);
      if (raw === undefined) return false;
      const operation = generation.current;
      setPending(true);
      setCommandMessage(undefined);
      try {
        const updated = await client.execute(decodeThreadGoalCommand(raw));
        if (generation.current !== operation) return false;
        currentGoal.current = updated.goal;
        setGoal(updated.goal);
        setHistory(updated.history);
        setStatus("ready");
        return true;
      } catch (error: unknown) {
        if (generation.current !== operation) return false;
        setCommandMessage(commandFailureMessage(error));
        // A stale version means this window is behind the host, so re-read
        // rather than resending a command built on the version it refused.
        if (error instanceof GoalClientFailure && error.category === "stale") reload();
        return false;
      } finally {
        if (generation.current === operation) setPending(false);
      }
    },
    [client, reload, threadId],
  );

  const create = useCallback(
    (objective: string) =>
      run((current) =>
        threadId === undefined || (current !== null && current.status !== "complete")
          ? undefined
          : {
              kind: "create-thread-goal",
              threadId,
              expectedVersion: current?.version ?? 0,
              goalId: mintId(),
              revisionId: mintId(),
              objective,
              budget: {},
            },
      ),
    [mintId, run, threadId],
  );

  const transition = useCallback(
    (kind: "pause-thread-goal" | "resume-thread-goal" | "complete-thread-goal") => () =>
      run((current) =>
        current === null
          ? undefined
          : {
              kind,
              threadId: current.threadId,
              expectedVersion: current.version,
              goalId: current.id,
            },
      ),
    [run],
  );

  const pause = useCallback(() => transition("pause-thread-goal")(), [transition]);
  const resume = useCallback(() => transition("resume-thread-goal")(), [transition]);
  const complete = useCallback(() => transition("complete-thread-goal")(), [transition]);

  const revise = useCallback(
    (objective: string) =>
      run((current) =>
        current === null
          ? undefined
          : {
              kind: "revise-thread-goal",
              threadId: current.threadId,
              expectedVersion: current.version,
              goalId: current.id,
              revisionId: mintId(),
              objective,
            },
      ),
    [mintId, run],
  );

  return {
    goal,
    history,
    status,
    commandMessage,
    pending,
    reload,
    create,
    pause,
    resume,
    revise,
    complete,
  };
}

function classify(error: unknown): GoalStatus {
  if (error instanceof GoalClientFailure) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 0) return "unavailable";
  }
  return "failure";
}

function commandFailureMessage(error: unknown): string {
  if (error instanceof GoalClientFailure) {
    if (error.status === 401) return "This window is not authorized to change the Goal.";
    if (error.status === 0) return "The host Goal service is unavailable.";
    return error.message;
  }
  return "The Goal command was refused as invalid.";
}
