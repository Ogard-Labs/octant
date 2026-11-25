import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { decodeProviderInstance, decodeProviderUsageLimitsSnapshot } from "@octant/contracts";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RailAccount, SidebarProfile } from "../shell/SidebarProfile";
import { PlanUsageProvider } from "./PlanUsageContext";
import { RailUsage } from "./RailUsage";

const observedAt = "2026-10-20T12:00:00.000Z";

interface Account {
  readonly name: string;
  /** How much of each window is used, 0 to 1. */
  readonly windows: Readonly<Record<string, number>>;
  readonly exhausted?: true;
}

/** The account ids run against the person's order, which the host's snapshot never follows. */
function planUsage(accounts: ReadonlyArray<Account>) {
  const rows = accounts.map((account, index) => ({
    ...account,
    id: `10000000-0000-4000-8000-00000000000${String(9 - index)}`,
  }));
  const snapshot = decodeProviderUsageLimitsSnapshot({
    version: 1,
    refreshedAt: observedAt,
    entries: [...rows].reverse().map((row) => ({
      providerInstanceId: row.id,
      status: "available",
      source: "provider-runtime",
      observedAt,
      limits: {
        providerInstanceId: row.id,
        scope: "account",
        requests: { status: "unavailable" },
        tokens: { status: "unavailable" },
        concurrency: { status: "unavailable" },
        retry: { status: "inactive" },
        quota: "available",
        source: "observed-evidence",
        confidence: "high",
        updatedAt: observedAt,
        rateLimitWindows: Object.entries(row.windows).map(([window, utilization]) => ({
          window,
          status: row.exhausted === true ? "exhausted" : "allowed",
          utilization,
          observedAt,
        })),
      },
    })),
  });
  return {
    client: { list: async () => snapshot } as unknown as ProviderUsageLimitsClient,
    instances: rows.map((row) =>
      decodeProviderInstance({
        id: row.id,
        displayName: row.name,
        driverKind: "claude",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
        },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: observedAt,
        updatedAt: observedAt,
      }),
    ),
  };
}

const profile = { ...defaultShellSettings().userProfile, displayName: "Ada" };
const four: ReadonlyArray<Account> = [
  { name: "Personal", windows: { five_hour: 0.2 } },
  { name: "Team", windows: { five_hour: 0.9 } },
  { name: "Lab", windows: { five_hour: 0.1 } },
  { name: "Studio", windows: { five_hour: 0.5 } },
];

describe("RailUsage", () => {
  it("draws one ring for each account that reports a window and opens Usage from it", async () => {
    const onOpenUsage = vi.fn();
    render(
      <PlanUsageProvider
        {...planUsage([
          { name: "Claude Max", windows: { seven_day: 0.2, five_hour: 0.4 } },
          { name: "API key", windows: {} },
        ])}
      >
        <RailUsage onOpenUsage={onOpenUsage} />
      </PlanUsageProvider>,
    );

    const group = await screen.findByRole("group", { name: "Plan usage" });
    const rings = within(group).getAllByRole("button");
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveAccessibleName("Claude Max plan usage, 5h 60% left, Week 80% left");

    await userEvent.click(rings[0]!);
    expect(onOpenUsage).toHaveBeenCalledOnce();
  });

  it("draws nothing while no account reports a window", () => {
    const { container } = render(
      <PlanUsageProvider {...planUsage([{ name: "API key", windows: {} }])}>
        <RailUsage onOpenUsage={vi.fn()} />
      </PlanUsageProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows every window and its share in a card when the pointer rests on a ring", async () => {
    render(
      <PlanUsageProvider
        {...planUsage([{ name: "Claude Max", windows: { seven_day: 0.2, five_hour: 0.4 } }])}
      >
        <RailUsage onOpenUsage={vi.fn()} />
      </PlanUsageProvider>,
    );

    await userEvent.hover(await screen.findByRole("button", { name: /^Claude Max plan usage/ }));
    const card = await screen.findByRole("group", { name: "Claude Max plan usage" });
    expect(await within(card).findByText("60% left")).toBeVisible();
    expect(card).toHaveTextContent("80% left");
  });

  it("offers nothing as left of a window the provider calls exhausted, whatever it left unused", async () => {
    render(
      <PlanUsageProvider
        {...planUsage([
          { name: "Codex", windows: { five_hour: 0.4 }, exhausted: true },
          { name: "Claude Team", windows: { five_hour: 0.4 } },
        ])}
      >
        <RailUsage onOpenUsage={vi.fn()} />
      </PlanUsageProvider>,
    );

    const arcOf = (ring: HTMLElement) => ring.querySelector(".rail-usage-ring__arc");
    const spent = await screen.findByRole("button", {
      name: "Codex plan usage, 5h limit reached",
    });
    expect(arcOf(spent)).toBeNull();
    expect(
      arcOf(screen.getByRole("button", { name: "Claude Team plan usage, 5h 60% left" })),
    ).not.toBeNull();

    await userEvent.hover(spent);
    const card = await screen.findByRole("group", { name: "Codex plan usage" });
    expect(await within(card).findByText("limit reached")).toBeVisible();
    expect(card).not.toHaveTextContent("60%");
    expect(card.querySelector<HTMLElement>(".rail-usage-card__bar > span")?.style.width).toBe(
      "0px",
    );
  });

  it("rings an account at its limit before those that only have less unused", async () => {
    const user = userEvent.setup();
    render(
      <PlanUsageProvider
        {...planUsage([
          { name: "Codex", windows: { five_hour: 0.1 }, exhausted: true },
          ...four.filter((account) => account.name !== "Lab"),
        ])}
      >
        <RailUsage onOpenUsage={vi.fn()} />
        <RailAccount onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />
      </PlanUsageProvider>,
    );

    const group = await screen.findByRole("group", { name: "Plan usage" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((ring) => ring.getAttribute("aria-label")?.split(" plan usage")[0]),
    ).toEqual(["Codex", "Team", "Studio"]);

    await user.click(screen.getByRole("button", { name: "Account menu, Ada" }));
    expect(
      await screen.findByRole("menuitem", { name: "Codex, 5h limit reached" }),
    ).toHaveTextContent("5h limit");
  });

  it("keeps the three accounts with the least left, in the person's order, and lists them all in the account menu", async () => {
    const user = userEvent.setup();
    render(
      <PlanUsageProvider {...planUsage(four)}>
        <RailUsage onOpenUsage={vi.fn()} />
        <RailAccount onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />
      </PlanUsageProvider>,
    );

    const group = await screen.findByRole("group", { name: "Plan usage" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((ring) => ring.getAttribute("aria-label")?.split(" plan usage")[0]),
    ).toEqual(["Personal", "Team", "Studio"]);

    await user.click(screen.getByRole("button", { name: "Account menu, Ada" }));
    expect(await screen.findByRole("menuitem", { name: "Lab, 5h 90% left" })).toBeVisible();
  });

  it("leaves plan usage out of the rail's account menu while the rings show every account", async () => {
    const user = userEvent.setup();
    const usage = planUsage(four.slice(0, 2));
    const { unmount } = render(
      <PlanUsageProvider {...usage}>
        <RailUsage onOpenUsage={vi.fn()} />
        <RailAccount onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />
      </PlanUsageProvider>,
    );
    await screen.findByRole("group", { name: "Plan usage" });
    await user.click(screen.getByRole("button", { name: "Account menu, Ada" }));
    await screen.findByRole("menuitem", { name: "Settings" });
    expect(screen.queryByRole("menuitem", { name: /% left$/ })).toBeNull();
    unmount();

    // Without a rail there are no rings, so the sidebar's row keeps the group.
    render(
      <PlanUsageProvider {...usage}>
        <SidebarProfile onOpenNavigator={vi.fn()} onOpenSettings={vi.fn()} profile={profile} />
      </PlanUsageProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Account menu, Ada" }));
    expect(await screen.findByRole("menuitem", { name: "Team, 5h 10% left" })).toBeVisible();
  });
});
