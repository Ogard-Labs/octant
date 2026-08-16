import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageDashboardRequest, UsageDashboardResponse } from "@octant/contracts";
import type { UsageDashboardClient } from "@octant/client-runtime";
import { UsageDashboardClientFailure } from "@octant/client-runtime";

export type UsageDashboardStatus =
  | "idle"
  | "loading"
  | "refreshing"
  | "ready"
  | "unauthorized"
  | "unavailable"
  | "failure";

export interface UseUsageDashboardControllerOptions {
  readonly client: UsageDashboardClient | undefined;
  readonly request: UsageDashboardRequest;
  readonly enabled?: boolean;
}

export interface UsageDashboardController {
  readonly dashboard: UsageDashboardResponse | undefined;
  readonly status: UsageDashboardStatus;
  readonly errorMessage: string | undefined;
  /**
   * The dashboard on screen is an earlier answer to *this* request whose latest
   * read failed. Only ever true beside an error status and a defined dashboard,
   * so the surface can say the figures are older instead of implying the host
   * just confirmed them.
   */
  readonly stale: boolean;
  readonly reload: () => void;
}

/**
 * Read-side controller for the host-authoritative usage dashboard.
 *
 * Every number the dashboard shows is re-read from the host; the renderer never
 * derives, estimates, or carries a total across a query. A superseded response
 * is discarded by generation so a slow answer for an earlier filter can never
 * repaint the current one, and the previous dashboard stays on screen while a
 * refresh is in flight so a filter change does not blank the surface.
 *
 * A read that fails is where those two rules part. A failed *reload of the same
 * request* — the serialized request the shown dashboard answered, re-read by
 * the refresh control or a remount — leaves that dashboard on screen and marks
 * it stale: the host already answered this exact query, and a later refusal
 * does not unsay it. A failed read of a *changed* request clears it, because
 * the host never answered the query the filters now claim, and leaving the
 * previous totals under the new filters attributes usage to a query that was
 * refused.
 */
export function useUsageDashboardController(
  options: UseUsageDashboardControllerOptions,
): UsageDashboardController {
  const [dashboard, setDashboard] = useState<UsageDashboardResponse>();
  const [status, setStatus] = useState<UsageDashboardStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [stale, setStale] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  /** The serialized request the dashboard on screen answered, when there is one. */
  const loadedKey = useRef<string>(undefined);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const { client, request } = options;
  const enabled = options.enabled ?? true;
  // The request is a plain value object rebuilt on each render, so identity
  // cannot drive the effect; its serialization is the stable dependency.
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    const operation = ++generation.current;
    if (!enabled || client === undefined) {
      setStatus("idle");
      setDashboard(undefined);
      setErrorMessage(undefined);
      setStale(false);
      loadedKey.current = undefined;
      return;
    }

    const controller = new AbortController();
    setStatus(loadedKey.current === undefined ? "loading" : "refreshing");
    setErrorMessage(undefined);
    // A staleness claim is about one query, so it survives that query's own
    // retry and no other. Carrying it onto a changed request would label the
    // previous query's figures as this one's older answer.
    setStale((current) => current && loadedKey.current === requestKey);
    void client
      .load(JSON.parse(requestKey) as UsageDashboardRequest, controller.signal)
      .then((response) => {
        if (generation.current !== operation) return;
        loadedKey.current = requestKey;
        setDashboard(response);
        setStale(false);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (generation.current !== operation) return;
        // Only the query the shown dashboard actually answered may survive its
        // own failed re-read; anything else would attribute those totals to a
        // query the host refused.
        const reloadOfShownRequest = loadedKey.current === requestKey;
        if (!reloadOfShownRequest) {
          loadedKey.current = undefined;
          setDashboard(undefined);
        }
        setStale(reloadOfShownRequest);
        if (error instanceof UsageDashboardClientFailure) {
          setErrorMessage(error.message);
          setStatus(
            error.status === 401 ? "unauthorized" : error.status === 0 ? "unavailable" : "failure",
          );
          return;
        }
        setErrorMessage("The usage dashboard could not be loaded.");
        setStatus("failure");
      });

    return () => {
      controller.abort();
    };
  }, [client, enabled, requestKey, reloadToken]);

  return { dashboard, status, errorMessage, stale, reload };
}
