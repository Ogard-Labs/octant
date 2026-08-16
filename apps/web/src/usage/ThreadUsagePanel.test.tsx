import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UsageDashboardRequest, UsageDashboardResponse } from "@octant/contracts";
import { UsageDashboardClientFailure, type UsageDashboardClient } from "@octant/client-runtime";
import { ThreadUsagePanel } from "./ThreadUsagePanel";

function dashboard(totalRequests: number): UsageDashboardResponse {
  return {
    summary: {
      totals: {
        totalInputTokens: 800,
        totalOutputTokens: 200,
        totalRequests,
        exactCount: totalRequests,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
      requestsWithUnavailableUsage: 1,
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

describe("ThreadUsagePanel", () => {
  it("reads the host with the thread pre-filtered", async () => {
    const load = vi.fn().mockResolvedValue(dashboard(4));
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        subjectId="thread-1"
        subjectType="chat-thread"
      />,
    );

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const request = load.mock.calls[0]![0] as UsageDashboardRequest;
    expect(request.filter).toEqual({
      subjectAggregateType: "chat-thread",
      subjectAggregateId: "thread-1",
    });
  });

  it("shows the host totals for the thread", async () => {
    const load = vi.fn().mockResolvedValue(dashboard(4));
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        subjectId="thread-1"
        subjectType="chat-thread"
      />,
    );

    await waitFor(() => expect(screen.getByText("800")).toBeInTheDocument());
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Requests without reported usage")).toBeInTheDocument();
  });

  it("hands the same filter to the full dashboard", async () => {
    const load = vi.fn().mockResolvedValue(dashboard(4));
    const onOpenUsageDashboard = vi.fn();
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        onOpenUsageDashboard={onOpenUsageDashboard}
        subjectId="thread-1"
        subjectType="chat-thread"
      />,
    );

    await waitFor(() => expect(screen.getByText("800")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Open in Usage dashboard" }));
    expect(onOpenUsageDashboard).toHaveBeenCalledWith({
      subjectAggregateType: "chat-thread",
      subjectAggregateId: "thread-1",
    });
  });

  it("says a thread has no recorded usage yet", async () => {
    const load = vi.fn().mockResolvedValue(dashboard(0));
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        subjectId="thread-1"
        subjectType="chat-thread"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("note")).toHaveTextContent("No usage has been recorded"),
    );
  });

  it("reports a host failure instead of an empty total", async () => {
    const load = vi.fn().mockRejectedValue(new UsageDashboardClientFailure("Host is down.", 0));
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        subjectId="thread-1"
        subjectType="chat-thread"
      />,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Host is down."));
    expect(screen.queryByText("800")).not.toBeInTheDocument();
  });
});
