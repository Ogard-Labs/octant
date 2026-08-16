import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type {
  ComputerUseSessionScope,
  ComputerUseSessionView,
} from "@octant/contracts/computer-use";
import { useCallback, useEffect, useState } from "react";

export interface ComputerUseLifecycleController {
  readonly status: "loading" | "ready" | "unavailable" | "interrupted" | "failed";
  readonly view?: ComputerUseSessionView;
  readonly errorMessage?: string;
  readonly busy: boolean;
  readonly approve: () => Promise<void>;
  readonly deny: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly retry: () => void;
}

export function useComputerUseLifecycle(options: {
  readonly client: ComputerUseClient;
  readonly scope: ComputerUseSessionScope;
  readonly enabled?: boolean;
}): ComputerUseLifecycleController {
  const [status, setStatus] = useState<ComputerUseLifecycleController["status"]>("loading");
  const [view, setView] = useState<ComputerUseSessionView | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const enabled = options.enabled ?? true;

  const fail = useCallback((error: unknown) => {
    const category = failureCategory(error);
    setStatus(
      category === "interrupted"
        ? "interrupted"
        : category === "unavailable"
          ? "unavailable"
          : "failed",
    );
    setErrorMessage(
      error instanceof Error ? error.message : "Computer-use lifecycle is unavailable.",
    );
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setStatus("unavailable");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    setErrorMessage(undefined);
    options.client
      .inspect(options.scope, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setView(next);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        fail(error);
      });
    return () => controller.abort();
  }, [attempt, enabled, fail, options.client, options.scope]);

  const decide = useCallback(
    async (decision: "approved" | "denied") => {
      const pending = view?.pendingApproval;
      if (pending === undefined || busy) return;
      setBusy(true);
      setErrorMessage(undefined);
      try {
        const next = await options.client.decide({
          ...options.scope,
          actionId: pending.actionId,
          approvalId: pending.approvalId,
          decision,
        });
        setView(next);
        setStatus("ready");
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
    },
    [busy, fail, options.client, options.scope, view?.pendingApproval],
  );

  const stop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      const next = await options.client.stop(options.scope);
      setView(next);
      setStatus("ready");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }, [busy, fail, options.client, options.scope]);

  return {
    status,
    ...(view === undefined ? {} : { view }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    busy,
    approve: () => decide("approved"),
    deny: () => decide("denied"),
    stop,
    retry,
  };
}

function failureCategory(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "category" in error
    ? String(error.category)
    : undefined;
}
