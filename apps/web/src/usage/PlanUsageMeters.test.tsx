import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { decodeProviderUsageLimitsSnapshot } from "@octant/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPlanUsage } from "./ComposerPlanUsage";
import { PlanUsageProvider } from "./PlanUsageContext";
import { PlanUsageMeters, pixelBarCells } from "./PlanUsageMeters";

afterEach(cleanup);

const codex = "10000000-0000-4000-8000-000000000001";
const claude = "10000000-0000-4000-8000-000000000002";
const observedAt = "2026-10-20T12:00:00.000Z";

function window(id: string, utilization: number) {
  return { window: id, status: "allowed", utilization, observedAt };
}

function entry(providerInstanceId: string, windows: ReadonlyArray<unknown>) {
  return {
    providerInstanceId,
    status: "available",
    source: "provider-runtime",
    observedAt,
    limits: {
      providerInstanceId,
      scope: "account",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      quota: "available",
      source: "observed-evidence",
      confidence: "high",
      updatedAt: observedAt,
      rateLimitWindows: windows,
    },
  };
}

function clientOf(entries: ReadonlyArray<unknown>): ProviderUsageLimitsClient {
  const snapshot = decodeProviderUsageLimitsSnapshot({
    version: 1,
    refreshedAt: observedAt,
    entries,
  });
  return { list: vi.fn(() => Promise.resolve(snapshot)) } as unknown as ProviderUsageLimitsClient;
}

describe("plan usage above the composer", () => {
  it("shows the share left of the selected provider's shortest and longest windows", async () => {
    const client = clientOf([
      entry(codex, [window("codex:secondary_7d", 0.57), window("codex:primary_5h", 0.15)]),
      entry(claude, [window("five_hour", 0.9), window("seven_day", 0.9)]),
    ]);
    render(
      <PlanUsageProvider barStyle="smooth" client={client}>
        <ComposerPlanUsage providerInstanceId={codex} />
      </PlanUsageProvider>,
    );

    const group = await screen.findByRole("group", { name: "Plan usage left" });
    expect(within(group).getByText("5h")).toBeVisible();
    expect(within(group).getByText("85%")).toBeVisible();
    expect(within(group).getByText("wk")).toBeVisible();
    expect(within(group).getByText("43%")).toBeVisible();
    // Another account's windows never stand in for the one the thread will use.
    expect(within(group).queryByText("10%")).toBeNull();
  });

  it("shows nothing when the provider reports no plan window", async () => {
    const client = clientOf([
      {
        providerInstanceId: claude,
        status: "unavailable",
        source: "provider-runtime",
        reason: "unsupported",
        observedAt,
      },
    ]);
    render(
      <PlanUsageProvider barStyle="smooth" client={client}>
        <ComposerPlanUsage providerInstanceId={claude} />
      </PlanUsageProvider>,
    );

    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Plan usage left" })).toBeNull();
  });

  it("shows nothing before a provider is chosen", async () => {
    const client = clientOf([entry(codex, [window("codex:primary_5h", 0.15)])]);
    render(
      <PlanUsageProvider barStyle="smooth" client={client}>
        <ComposerPlanUsage providerInstanceId={undefined} />
      </PlanUsageProvider>,
    );

    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Plan usage left" })).toBeNull();
  });
});

describe("usage bar style", () => {
  const windows = [
    { window: "five_hour", short: "5h", name: "5-hour limit", percent: 85, level: "ok" as const },
    { window: "seven_day", short: "Week", name: "7-day limit", percent: 43, level: "ok" as const },
  ];

  it("draws a smooth fill by default", () => {
    const { container } = render(<PlanUsageMeters windows={windows} />);
    expect(container.querySelectorAll(".plan-usage__bar--smooth")).toHaveLength(2);
    expect(container.querySelector(".plan-usage__bar--pixelated")).toBeNull();
  });

  it("draws square cells when the setting is Pixelated", () => {
    const { container } = render(
      <PlanUsageProvider barStyle="pixelated">
        <PlanUsageMeters windows={windows} />
      </PlanUsageProvider>,
    );
    expect(container.querySelectorAll(".plan-usage__bar--pixelated")).toHaveLength(2);
    expect(container.querySelector(".plan-usage__bar--smooth")).toBeNull();
    expect(container.querySelectorAll('rect[data-lit="true"]').length).toBeGreaterThan(0);
  });

  it("thins the lit cells out toward the leading edge, and fills a full bar solid", () => {
    const columns = (percent: number) => {
      const lit = new Map<number, number>();
      for (const cell of pixelBarCells(percent)) {
        if (cell.lit) lit.set(cell.column, (lit.get(cell.column) ?? 0) + 1);
      }
      return lit;
    };
    const half = columns(50);
    // Deep inside the fill every cell is lit; the last column keeps a stipple.
    expect(half.get(0)).toBe(3);
    expect(half.get(7)).toBeLessThan(3);
    expect(half.has(9)).toBe(false);
    expect(pixelBarCells(100).every((cell) => cell.lit)).toBe(true);
    expect(pixelBarCells(0).some((cell) => cell.lit)).toBe(false);
  });
});
