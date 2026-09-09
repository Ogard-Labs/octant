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

  it("names a token ceiling refusal and a recovery on Environment", async () => {
    const load = vi.fn().mockResolvedValue(dashboard(4));
    const snapshot = vi.fn().mockResolvedValue({
      refusal: {
        kind: "exhausted",
        scopeKind: "thread",
        scopeId: "73000000-0000-4000-8000-000000000001",
        dimension: "tokens",
        remainingTokens: 0,
        ceilingTokens: 1_000,
        recovery: ["raise-ceiling", "clear-ceiling", "open-usage", "pause-work"],
        message:
          "This thread's token spend ceiling has 0 tokens remaining of 1,000. Raise or clear the ceiling, open Usage for this thread, or pause work.",
      },
    });
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        spendCeilingClient={{ snapshot, execute: vi.fn() } as never}
        subjectId="thread-1"
        subjectType="chat-thread"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Raise or clear the ceiling"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("open Usage");
  });

  it("shows the tighter remaining capacity when thread and Project ceilings both exist", async () => {
    const load = vi.fn().mockResolvedValue(dashboard(4));
    const execute = vi.fn().mockResolvedValue({ kind: "raised" });
    const snapshot = vi.fn().mockResolvedValue({
      thread: { version: 3 },
      project: { version: 9 },
      threadRemaining: {
        remainingTokens: 800,
        ceilingTokens: 1_000,
        committedTokens: 200,
        reservedTokens: 0,
        window: { kind: "lifetime" },
        version: 3,
      },
      projectRemaining: {
        remainingTokens: 150,
        ceilingTokens: 500,
        committedTokens: 350,
        reservedTokens: 0,
        window: { kind: "calendar", period: "day", timeZone: "UTC" },
        version: 9,
      },
    });
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        spendCeilingClient={{ snapshot, execute } as never}
        subjectId="73000000-0000-4000-8000-000000000001"
        subjectType="chat-thread"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("150 of 500 tokens remaining"),
    );
    expect(document.querySelector("form")).toHaveAttribute("novalidate");
    expect(screen.getByRole("button", { name: "Raise token ceiling" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear ceiling" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Token spend ceiling"), "2000");
    await userEvent.click(screen.getByRole("button", { name: "Raise token ceiling" }));
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute.mock.calls[0]![0]).toMatchObject({
      kind: "raise-spend-ceiling",
      expectedVersion: 3,
      tokenBudget: 2000,
    });
  });

  it("sets a thread ceiling without using the Project version when only a Project cap exists", async () => {
    const load = vi.fn().mockResolvedValue(dashboard(4));
    const execute = vi.fn().mockResolvedValue({ kind: "set" });
    const snapshot = vi.fn().mockResolvedValue({
      project: { version: 9 },
      projectRemaining: {
        remainingTokens: 150,
        ceilingTokens: 500,
        committedTokens: 350,
        reservedTokens: 0,
        window: { kind: "calendar", period: "day", timeZone: "UTC" },
        version: 9,
      },
    });
    render(
      <ThreadUsagePanel
        client={{ load } as UsageDashboardClient}
        spendCeilingClient={{ snapshot, execute } as never}
        subjectId="73000000-0000-4000-8000-000000000001"
        subjectType="chat-thread"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("150 of 500 tokens remaining"),
    );
    expect(document.querySelector("form")).toHaveAttribute("novalidate");
    expect(screen.getByRole("button", { name: "Set token ceiling" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear ceiling" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Token spend ceiling"), "400");
    await userEvent.click(screen.getByRole("button", { name: "Set token ceiling" }));
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute.mock.calls[0]![0]).toMatchObject({
      kind: "set-spend-ceiling",
      expectedVersion: 0,
      policy: { tokenBudget: 400 },
    });
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
