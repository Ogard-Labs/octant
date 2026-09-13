import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type {
  ComputerUseSessionScope,
  ComputerUseSessionView,
} from "@octant/contracts/computer-use";
import { useCallback, useEffect, useRef, useState } from "react";

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
  /**
   * The host's own session sequence. A new value means the host has new
   * session content — an approval request, a state change — even though the
   * scope is unchanged, so the pane must re-inspect.
   */
  readonly revision?: number;
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

  // The activity surface polls and rebuilds each session's scope object every
  // tick. Depending only on that object re-inspected once per poll and reset
  // the pane to "Loading computer use…" while its view was still in memory;
  // depending only on the scope's content missed a pending approval that
  // arrives without an authority change. Key on the session, its authority,
  // and the host's own sequence: the effect re-runs exactly when the host has
  // new content, and a same-session refresh keeps the current view on screen.
  const scope = options.scope;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const sessionId = String(scope.sessionId);
  const scopeKey = `${sessionId}\0${String(scope.threadId)}\0${JSON.stringify(scope.authority)}\0${String(options.revision ?? 0)}`;
  const currentSessionRef = useRef(sessionId);

  useEffect(() => {
    if (!enabled) {
      setStatus("unavailable");
      return;
    }
    const controller = new AbortController();
    const sameSession = currentSessionRef.current === sessionId;
    currentSessionRef.current = sessionId;
    if (sameSession) {
      // Keep the view we hold while the re-inspection runs, so approval
      // controls already on screen stay until the host's update lands.
      setErrorMessage(undefined);
    } else {
      setView(undefined);
      setStatus("loading");
      setErrorMessage(undefined);
    }
    options.client
      .inspect(scopeRef.current, controller.signal)
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
  }, [attempt, enabled, fail, options.client, scopeKey, sessionId]);

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
