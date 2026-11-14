import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { decodeProviderUsageLimitsSnapshot } from "@octant/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPlanUsage } from "./ComposerPlanUsage";
import { PlanUsageProvider } from "./PlanUsageContext";
import { PlanUsageMeters, closestToLimit, pixelBarCells } from "./PlanUsageMeters";

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
  it("lists each window of the selected account with what is left and when it resets", async () => {
    const soon = new Date(Date.now() + 4 * 60 * 60_000 + 59 * 60_000 + 10_000).toISOString();
    const later = new Date(Date.now() + 19 * 60 * 60_000 + 24 * 60 * 60_000 + 10_000).toISOString();
    const client = clientOf([
      entry(codex, [
        { ...window("codex:primary_5h", 0.15), resetsAt: soon },
        { ...window("codex:secondary_7d", 0.57), resetsAt: later },
      ]),
      entry(claude, [window("five_hour", 0.9), window("seven_day", 0.9)]),
    ]);
    render(
      <PlanUsageProvider barStyle="smooth" client={client}>
        <ComposerPlanUsage providerInstanceId={codex} />
      </PlanUsageProvider>,
    );

    const group = await screen.findByRole("group", { name: "Plan usage left" });
    expect(group).toHaveTextContent("85% 4h 59m · 43% 1d 19h");
    expect(
      within(group).getByRole("img", { name: "5-hour window, codex: 85% left, resets in 4h 59m" }),
    ).toBeVisible();
    expect(
      within(group).getByRole("img", { name: "7-day window, codex: 43% left, resets in 1d 19h" }),
    ).toBeVisible();
    // Another account's windows never stand in for the one the thread will use.
    expect(group).not.toHaveTextContent("10%");
  });

  it("says a window close to its limit in the warning ink and a spent one as reached in words, with no notice above the box", async () => {
    const resetsAt = new Date(Date.now() + 3 * 60 * 60_000 + 17 * 60_000 + 10_000).toISOString();
    const client = clientOf([
      entry(codex, [
        { ...window("codex:primary_5h", 0.92), resetsAt },
        { ...window("codex:secondary_7d", 1), status: "exhausted", resetsAt },
      ]),
    ]);
    render(
      <PlanUsageProvider barStyle="smooth" client={client}>
        <ComposerPlanUsage providerInstanceId={codex} />
      </PlanUsageProvider>,
    );

    const group = await screen.findByRole("group", { name: "Plan usage left" });
    const near = within(group).getByRole("img", {
      name: "5-hour window, codex: 8% left, close to its limit, resets in 3h 17m",
    });
    expect(near).toHaveAttribute("data-level", "near");
    expect(near).toHaveTextContent("8% 3h 17m");
    const spent = within(group).getByRole("img", {
      name: "7-day window, codex: limit reached, resets in 3h 17m",
    });
    expect(spent).toHaveAttribute("data-level", "spent");
    expect(screen.queryByRole("alert")).toBeNull();
    // The words are on the line itself, so the danger ink is never the only sign.
    expect(spent).toHaveTextContent("0% limit 3h 17m");
  });

  it("keeps the line's figures tabular and lets it shrink instead of pushing its neighbours", () => {
    const css = readFileSync(resolve(process.cwd(), "src/usage/plan-usage-line.css"), "utf8");
    const rule = css.match(/\.plan-usage-line \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/font-variant-numeric: tabular-nums/);
    expect(rule).toMatch(/min-width: 0/);
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

describe("the compact plan meter beside the composer's row", () => {
  const five = {
    window: "five_hour",
    short: "5h",
    name: "5-hour limit",
    percent: 85,
    level: "ok",
  } as const;
  const week = {
    window: "seven_day",
    short: "Week",
    name: "7-day limit",
    percent: 43,
    level: "ok",
  } as const;

  it("draws one meter for the window closest to its limit and names both windows", () => {
    render(<PlanUsageMeters compact windows={[five, week]} />);
    const group = screen.getByRole("group", { name: "Plan usage left" });
    const meters = within(group).getAllByRole("img");
    expect(meters).toHaveLength(1);
    expect(meters[0]).toHaveAccessibleName("5-hour limit, 85% left; 7-day limit, 43% left");
    expect(meters[0]).toHaveTextContent("43%");
  });

  it("speaks for the shorter window when both have the same share left", () => {
    render(<PlanUsageMeters compact windows={[five, { ...week, percent: 85 }]} />);
    expect(screen.getByRole("img")).toHaveTextContent("85%");
    expect(closestToLimit([five, { ...week, percent: 85 }])).toBe(five);
  });

  it("keeps one window as it was, named by its own window", () => {
    render(<PlanUsageMeters compact windows={[week]} />);
    expect(screen.getByRole("img")).toHaveAccessibleName("7-day limit, 43% left");
  });
});
