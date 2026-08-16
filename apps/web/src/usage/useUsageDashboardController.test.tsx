import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UsageDashboardResponse } from "@octant/contracts";
import { UsageDashboardClientFailure, type UsageDashboardClient } from "@octant/client-runtime";
import { useUsageDashboardController } from "./useUsageDashboardController";

function dashboard(totalRequests = 1): UsageDashboardResponse {
  return {
    summary: {
      totals: {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalRequests,
        exactCount: totalRequests,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
      requestsWithUnavailableUsage: 0,
      coverage: [],
      excludedRecordCount: 0,
    },
    activity: [],
    activityTruncated: false,
    breakdown: [],
    detail: [],
    detailTruncated: false,
    hosts: [],
    dimensionSources: [],
    timeZone: "UTC",
    queryAt: "2026-07-24T12:00:00.000Z",
  } as unknown as UsageDashboardResponse;
}

function clientReturning(response: UsageDashboardResponse): UsageDashboardClient {
  return { load: vi.fn().mockResolvedValue(response) };
}

describe("useUsageDashboardController", () => {
  it("reads the host dashboard for the current request", async () => {
    const client = clientReturning(dashboard());
    const { result } = renderHook(() =>
      useUsageDashboardController({ client, request: { timeZone: "UTC" } }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.dashboard?.summary.totals.totalRequests).toBe(1);
    expect(client.load).toHaveBeenCalledWith({ timeZone: "UTC" }, expect.anything());
  });

  it("stays idle without a client", async () => {
    const { result } = renderHook(() =>
      useUsageDashboardController({ client: undefined, request: {} }),
    );
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.dashboard).toBeUndefined();
  });

  it("re-reads when the request changes and not when it merely re-renders", async () => {
    const client = clientReturning(dashboard());
    const { result, rerender } = renderHook(
      (props: { timeZone: string }) =>
        useUsageDashboardController({ client, request: { timeZone: props.timeZone } }),
      { initialProps: { timeZone: "UTC" } },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ timeZone: "UTC" });
    expect(client.load).toHaveBeenCalledTimes(1);

    rerender({ timeZone: "Europe/Oslo" });
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(2));
  });

  it("keeps the loaded dashboard visible while refreshing", async () => {
    const client = clientReturning(dashboard(2));
    const { result } = renderHook(() => useUsageDashboardController({ client, request: {} }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.reload();
    });
    expect(result.current.dashboard?.summary.totals.totalRequests).toBe(2);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(client.load).toHaveBeenCalledTimes(2);
  });

  it("maps an unauthorized host failure to its own status", async () => {
    const client: UsageDashboardClient = {
      load: vi.fn().mockRejectedValue(new UsageDashboardClientFailure("Not authorized.", 401)),
    };
    const { result } = renderHook(() => useUsageDashboardController({ client, request: {} }));

    await waitFor(() => expect(result.current.status).toBe("unauthorized"));
    expect(result.current.errorMessage).toBe("Not authorized.");
    expect(result.current.dashboard).toBeUndefined();
  });

  it("maps an unreachable host to the unavailable status", async () => {
    const client: UsageDashboardClient = {
      load: vi.fn().mockRejectedValue(new UsageDashboardClientFailure("Host is down.", 0)),
    };
    const { result } = renderHook(() => useUsageDashboardController({ client, request: {} }));

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("treats an unexpected rejection as a failure without inventing data", async () => {
    const client: UsageDashboardClient = { load: vi.fn().mockRejectedValue(new Error("boom")) };
    const { result } = renderHook(() => useUsageDashboardController({ client, request: {} }));

    await waitFor(() => expect(result.current.status).toBe("failure"));
    expect(result.current.dashboard).toBeUndefined();
  });

  it("drops the loaded dashboard when a changed request fails", async () => {
    const client: UsageDashboardClient = {
      load: vi
        .fn()
        .mockResolvedValueOnce(dashboard(7))
        .mockRejectedValue(new UsageDashboardClientFailure("Project is out of scope.", 403)),
    };
    const { result, rerender } = renderHook(
      (props: { mode: string }) =>
        useUsageDashboardController({ client, request: { filter: { mode: props.mode } } as never }),
      { initialProps: { mode: "chat" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ mode: "work" });

    await waitFor(() => expect(result.current.status).toBe("failure"));
    // Chat's totals under a Work filter the host never answered would read
    // as usage attributed to that filter.
    expect(result.current.dashboard).toBeUndefined();
    expect(result.current.stale).toBe(false);
    expect(result.current.errorMessage).toBe("Project is out of scope.");
  });

  it("keeps the last successful read when the same request fails to reload, marked stale", async () => {
    const client: UsageDashboardClient = {
      load: vi
        .fn()
        .mockResolvedValueOnce(dashboard(7))
        .mockRejectedValue(new UsageDashboardClientFailure("Host is down.", 0)),
    };
    const { result, rerender } = renderHook(
      (props: { mode: string }) =>
        useUsageDashboardController({ client, request: { filter: { mode: props.mode } } as never }),
      { initialProps: { mode: "chat" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    // A refresh that failed does not invalidate what the host already answered
    // for this exact query — but the surface must say the figures are older.
    expect(result.current.dashboard?.summary.totals.totalRequests).toBe(7);
    expect(result.current.stale).toBe(true);

    rerender({ mode: "work" });

    // The claim was about the Chat query; it cannot describe the Work one.
    expect(result.current.stale).toBe(false);
  });

  it("loads rather than refreshes after a cleared failure", async () => {
    const client: UsageDashboardClient = {
      load: vi
        .fn()
        .mockResolvedValueOnce(dashboard(7))
        .mockRejectedValueOnce(new UsageDashboardClientFailure("Project is out of scope.", 403))
        .mockResolvedValue(dashboard(3)),
    };
    const { result, rerender } = renderHook(
      (props: { mode: string }) =>
        useUsageDashboardController({ client, request: { filter: { mode: props.mode } } as never }),
      { initialProps: { mode: "chat" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ mode: "work" });
    await waitFor(() => expect(result.current.status).toBe("failure"));

    act(() => {
      result.current.reload();
    });

    // Nothing is on screen to refresh, so the retry must read as a first load.
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.stale).toBe(false);
  });

  it("discards a superseded response", async () => {
    let resolveFirst: ((value: UsageDashboardResponse) => void) | undefined;
    const client: UsageDashboardClient = {
      load: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<UsageDashboardResponse>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(dashboard(9)),
    };

    const { result, rerender } = renderHook(
      (props: { timeZone: string }) =>
        useUsageDashboardController({ client, request: { timeZone: props.timeZone } }),
      { initialProps: { timeZone: "UTC" } },
    );

    rerender({ timeZone: "Europe/Oslo" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      resolveFirst?.(dashboard(1));
    });

    expect(result.current.dashboard?.summary.totals.totalRequests).toBe(9);
  });
});
