import { createCodeClient, type CodeClient } from "@octant/client-runtime/code-client";
import type { CodeRunOutcome, LinkedThreadAggregate } from "@octant/contracts";
import { compareParallelRuns, type ParallelRunComparison } from "@octant/domain";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface ParallelRunOutcomesOptions {
  readonly aggregate: LinkedThreadAggregate | undefined;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build the client elsewhere. */
  readonly client?: Pick<CodeClient, "executeOperation" | "bootstrap">;
  readonly uuid?: () => string;
}

export interface ParallelRunOutcomes {
  readonly comparison: ParallelRunComparison;
  readonly outcomes: ReadonlyMap<string, CodeRunOutcome>;
  readonly available: boolean;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly refresh: () => Promise<void>;
  /** Merge one attempt into the Project's checkout. Approval is the host's. */
  readonly bringHome: (threadId: string) => Promise<boolean>;
}

const MAX_DIFF_BYTES = 256 * 1024;

/**
 * What each attempt on one task produced, and the one gesture that takes one.
 *
 * Every outcome here was measured by the host: this hook asks each attempt's
 * thread to review its own run and keeps the answers. It never merges on its
 * own — bringing a run home is an explicit gesture per attempt, and the host
 * re-reads the run and the Project's checkout before it moves anything.
 */
export function useParallelRunOutcomes(options: ParallelRunOutcomesOptions): ParallelRunOutcomes {
  const { aggregate, serverUrl, windowCapability } = options;
  const injected = options.client;
  const uuid = options.uuid ?? globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const client = useMemo(() => {
    if (injected !== undefined) return injected;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createCodeClient({ baseUrl: serverUrl, fetch, windowCapability });
    } catch {
      return undefined;
    }
  }, [injected, serverUrl, windowCapability]);

  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, CodeRunOutcome>>(new Map());
  // Which checkout each attempt is bound to is the host's answer, read from the
  // Code bootstrap rather than assumed from the aggregate.
  const [checkouts, setCheckouts] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const attempts = useMemo(
    () =>
      (aggregate?.results ?? []).flatMap((result) =>
        result.threadId === undefined
          ? []
          : [{ threadId: String(result.threadId), label: result.label }],
      ),
    [aggregate],
  );

  const refresh = useCallback(async () => {
    if (client === undefined || attempts.length === 0) return;
    setBusy(true);
    setMessage(undefined);
    let bound: ReadonlyMap<string, string>;
    try {
      const bootstrap = await client.bootstrap();
      bound = new Map(
        bootstrap.threads.map((thread) => [String(thread.id), String(thread.checkoutId)]),
      );
    } catch {
      setBusy(false);
      setMessage("The host's Code threads could not be read.");
      return;
    }
    setCheckouts(bound);
    const next = new Map<string, CodeRunOutcome>();
    for (const attempt of attempts) {
      const checkoutId = bound.get(attempt.threadId);
      if (checkoutId === undefined) continue;
      try {
        const result = await client.executeOperation({
          kind: "review-run",
          operationId: uuid() as never,
          threadId: attempt.threadId as never,
          checkoutId: checkoutId as never,
          gitOperationId: uuid() as never,
          maxDiffBytes: MAX_DIFF_BYTES,
        });
        // An attempt the host cannot review is left without an outcome rather
        // than shown as an empty one: "nothing to bring" and "not read yet"
        // are different answers.
        if (result.kind === "run-reviewed") next.set(attempt.threadId, result.outcome);
      } catch {
        continue;
      }
    }
    setOutcomes(next);
    setBusy(false);
  }, [attempts, client, uuid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bringHome = useCallback(
    async (threadId: string): Promise<boolean> => {
      const outcome = outcomes.get(threadId);
      const checkoutId = checkouts.get(threadId);
      if (client === undefined || outcome === undefined || checkoutId === undefined) return false;
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await client.executeOperation({
          kind: "merge-run",
          operationId: uuid() as never,
          threadId: threadId as never,
          checkoutId: checkoutId as never,
          gitOperationId: uuid() as never,
          confirmation: {
            branch: outcome.branch,
            // The base branch is the one the run's own outcome names, so the
            // confirmation describes the merge the host just measured.
            baseBranch: outcome.baseRef.split("/").at(-1) ?? outcome.baseRef,
            expectedHeadOid: outcome.head,
          },
          authorization: { kind: "full-access" },
        });
        if (result.kind === "operation-failed") {
          setMessage(result.failure.message);
          return false;
        }
        await refresh();
        return true;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The merge could not be run.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [checkouts, client, outcomes, refresh, uuid],
  );

  return {
    comparison: useMemo(
      () =>
        compareParallelRuns(
          attempts.map((attempt) => {
            const outcome = outcomes.get(attempt.threadId);
            return {
              threadId: attempt.threadId,
              label: attempt.label,
              ...(outcome === undefined ? {} : { outcome }),
            };
          }),
        ),
      [attempts, outcomes],
    ),
    outcomes,
    available: client !== undefined && attempts.length > 0,
    busy,
    message,
    refresh,
    bringHome,
  };
}
