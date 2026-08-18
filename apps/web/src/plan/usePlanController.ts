import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeThreadPlanCommand,
  type ThreadPlan,
  type ThreadPlanHistoryEntry,
  type ThreadPlanStepId,
  type ThreadPlanStepStatus,
} from "@octant/contracts";
import { PlanClientFailure, type PlanClient } from "@octant/client-runtime/plan-client";

export type PlanStatus = "idle" | "loading" | "ready" | "unauthorized" | "unavailable" | "failure";

export interface PlanStepDraft {
  readonly title: string;
  readonly rationale?: string;
}

export interface UsePlanControllerOptions {
  readonly client: PlanClient | undefined;
  readonly enabled: boolean;
  readonly threadId: string | undefined;
  /** Injectable id source so tests do not depend on the realm's crypto. */
  readonly newId?: () => string;
}

export interface PlanController {
  readonly plan: ThreadPlan | null;
  readonly history: ReadonlyArray<ThreadPlanHistoryEntry>;
  readonly status: PlanStatus;
  readonly commandMessage: string | undefined;
  readonly pending: boolean;
  readonly reload: () => void;
  readonly propose: (title: string, steps: ReadonlyArray<PlanStepDraft>) => Promise<boolean>;
  readonly revise: (title: string, steps: ReadonlyArray<PlanStepDraft>) => Promise<boolean>;
  readonly approve: () => Promise<boolean>;
  readonly withdraw: () => Promise<boolean>;
  readonly setStepStatus: (
    stepId: ThreadPlanStepId,
    status: ThreadPlanStepStatus,
  ) => Promise<boolean>;
}

/**
 * Read/command controller for one thread's plan.
 *
 * The host owns every transition and every version: a command carries the
 * version this window last read, and the reply replaces local state, so no step
 * is shown as started or done before the host accepted it. Approval is built
 * from the revision this window actually has in hand — a plan that moved under
 * the reader is refused rather than approved on wording nobody saw.
 */
export function usePlanController(options: UsePlanControllerOptions): PlanController {
  const [plan, setPlan] = useState<ThreadPlan | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<ThreadPlanHistoryEntry>>([]);
  const [status, setStatus] = useState<PlanStatus>("idle");
  const [commandMessage, setCommandMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const currentPlan = useRef<ThreadPlan | null>(null);
  const idSource = useRef(options.newId);
  idSource.current = options.newId;

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const { client, enabled, threadId } = options;

  useEffect(() => {
    const operation = ++generation.current;
    if (!enabled || client === undefined || threadId === undefined) {
      currentPlan.current = null;
      setPlan(null);
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
        currentPlan.current = projection.plan;
        setPlan(projection.plan);
        setHistory(projection.history);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (generation.current !== operation) return;
        currentPlan.current = null;
        setPlan(null);
        setHistory([]);
        setStatus(classify(error));
      });
    return () => controller.abort();
  }, [client, enabled, threadId, reloadToken]);

  const mintId = useCallback(
    () => (idSource.current ?? (() => globalThis.crypto.randomUUID()))(),
    [],
  );

  const run = useCallback(
    async (build: (current: ThreadPlan | null) => unknown) => {
      if (client === undefined || threadId === undefined) return false;
      const raw = build(currentPlan.current);
      if (raw === undefined) return false;
      const operation = generation.current;
      setPending(true);
      setCommandMessage(undefined);
      try {
        const updated = await client.execute(decodeThreadPlanCommand(raw));
        if (generation.current !== operation) return false;
        currentPlan.current = updated.plan;
        setPlan(updated.plan);
        setHistory(updated.history);
        setStatus("ready");
        return true;
      } catch (error: unknown) {
        if (generation.current !== operation) return false;
        setCommandMessage(commandFailureMessage(error));
        // A stale version means this window is behind the host, so re-read
        // rather than resending a command built on the version it refused.
        if (error instanceof PlanClientFailure && error.category === "stale") reload();
        return false;
      } finally {
        if (generation.current === operation) setPending(false);
      }
    },
    [client, reload, threadId],
  );

  const draftSteps = useCallback(
    (steps: ReadonlyArray<PlanStepDraft>) =>
      steps
        .map((step) => ({ title: step.title.trim(), rationale: step.rationale?.trim() }))
        .filter((step) => step.title !== "")
        .map((step) => ({
          stepId: mintId(),
          title: step.title,
          ...(step.rationale === undefined || step.rationale === ""
            ? {}
            : { rationale: step.rationale }),
        })),
    [mintId],
  );

  const propose = useCallback(
    (title: string, steps: ReadonlyArray<PlanStepDraft>) =>
      run((current) => {
        const laid = draftSteps(steps);
        if (threadId === undefined || laid.length === 0) return undefined;
        if (current !== null && current.status !== "withdrawn") return undefined;
        return {
          kind: "propose-thread-plan",
          threadId,
          expectedVersion: current?.version ?? 0,
          planId: mintId(),
          revisionId: mintId(),
          title: title.trim(),
          steps: laid,
        };
      }),
    [draftSteps, mintId, run, threadId],
  );

  const revise = useCallback(
    (title: string, steps: ReadonlyArray<PlanStepDraft>) =>
      run((current) => {
        const laid = draftSteps(steps);
        if (current === null || laid.length === 0) return undefined;
        return {
          kind: "revise-thread-plan",
          threadId: current.threadId,
          expectedVersion: current.version,
          planId: current.id,
          revisionId: mintId(),
          title: title.trim(),
          steps: laid,
        };
      }),
    [draftSteps, mintId, run],
  );

  const approve = useCallback(
    () =>
      run((current) =>
        current === null
          ? undefined
          : {
              kind: "approve-thread-plan",
              threadId: current.threadId,
              expectedVersion: current.version,
              planId: current.id,
              // The revision in hand, not a fresh one: approving means
              // approving the steps this window is showing.
              revisionId: current.revisionId,
            },
      ),
    [run],
  );

  const withdraw = useCallback(
    () =>
      run((current) =>
        current === null
          ? undefined
          : {
              kind: "withdraw-thread-plan",
              threadId: current.threadId,
              expectedVersion: current.version,
              planId: current.id,
            },
      ),
    [run],
  );

  const setStepStatus = useCallback(
    (stepId: ThreadPlanStepId, stepStatus: ThreadPlanStepStatus) =>
      run((current) =>
        current === null
          ? undefined
          : {
              kind: "set-thread-plan-step-status",
              threadId: current.threadId,
              expectedVersion: current.version,
              planId: current.id,
              stepId,
              status: stepStatus,
            },
      ),
    [run],
  );

  return {
    plan,
    history,
    status,
    commandMessage,
    pending,
    reload,
    propose,
    revise,
    approve,
    withdraw,
    setStepStatus,
  };
}

function classify(error: unknown): PlanStatus {
  if (error instanceof PlanClientFailure) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 0) return "unavailable";
  }
  return "failure";
}

function commandFailureMessage(error: unknown): string {
  if (error instanceof PlanClientFailure) {
    if (error.status === 401) return "This window is not authorized to change the plan.";
    if (error.status === 0) return "The host plan service is unavailable.";
    return error.message;
  }
  return "The plan command was refused as invalid.";
}
