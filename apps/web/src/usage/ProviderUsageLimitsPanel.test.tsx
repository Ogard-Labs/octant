import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeProviderUsageLimitsSnapshot,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderUsageLimitsSnapshot,
} from "@octant/contracts";
import { ProviderUsageLimitsPanel } from "./ProviderUsageLimitsPanel";

const providerInstanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const provider = {
  id: providerInstanceId,
  displayName: "Primary provider",
  driverKind: "codex",
  enabled: true,
  environmentPolicy: "inherit-host",
  configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
  version: 1,
  createdAt: "2026-08-23T12:00:00.000Z",
  updatedAt: "2026-08-23T12:00:00.000Z",
} as ProviderInstance;

function snapshot(
  status: "available" | "unavailable" | "failed" = "available",
): ProviderUsageLimitsSnapshot {
  return decodeProviderUsageLimitsSnapshot({
    version: 1,
    refreshedAt: "2026-08-23T12:00:00.000Z",
    entries: [
      status === "available"
        ? {
            providerInstanceId,
            status,
            source: "provider-runtime",
            observedAt: "2026-08-23T12:00:00.000Z",
            limits: {
              providerInstanceId,
              scope: "account",
              requests: {
                status: "available",
                limit: 100,
                remaining: 25,
                resetsAt: "2026-08-23T13:00:00.000Z",
              },
              tokens: { status: "unavailable" },
              concurrency: { status: "unavailable" },
              retry: { status: "inactive" },
              quota: "available",
              source: "observed-evidence",
              confidence: "high",
              updatedAt: "2026-08-23T12:00:00.000Z",
              rateLimitWindows: [
                {
                  window: "five_hour",
                  status: "warning",
                  utilization: 0.75,
                  resetsAt: "2026-08-23T13:00:00.000Z",
                  observedAt: "2026-08-23T12:00:00.000Z",
                },
              ],
            },
          }
        : status === "unavailable"
          ? {
              providerInstanceId,
              status,
              source: "provider-runtime",
              reason: "unsupported",
              observedAt: "2026-08-23T12:00:00.000Z",
            }
          : {
              providerInstanceId,
              status,
              source: "provider-runtime",
              observedAt: "2026-08-23T12:05:00.000Z",
              failure: {
                category: "rate-limited",
                message: "Provider limits could not be refreshed.",
                retryAt: "2026-08-23T12:10:00.000Z",
              },
              staleLimits: {
                providerInstanceId,
                scope: "account",
                requests: { status: "available", limit: 100, remaining: 25 },
                tokens: { status: "unavailable" },
                concurrency: { status: "unavailable" },
                retry: { status: "inactive" },
                quota: "available",
                source: "observed-evidence",
                confidence: "high",
                updatedAt: "2026-08-23T12:00:00.000Z",
              },
              lastSuccessfulAt: "2026-08-23T12:00:00.000Z",
            },
    ],
  });
}

describe("ProviderUsageLimitsPanel", () => {
  it("expires a quota at its reset boundary instead of waiting another minute", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-23T12:00:00.000Z") });
    try {
      const original = snapshot();
      const data = decodeProviderUsageLimitsSnapshot({
        ...original,
        entries: original.entries.map((entry) =>
          entry.status !== "available"
            ? entry
            : {
                ...entry,
                limits: {
                  ...entry.limits,
                  rateLimitWindows: [
                    {
                      window: "five_hour",
                      status: "allowed",
                      utilization: 0.5,
                      resetsAt: "2026-08-23T12:00:05.000Z",
                      observedAt: "2026-08-23T12:00:00.000Z",
                    },
                  ],
                },
              },
        ),
      });
      await act(async () => {
        render(
          <ProviderUsageLimitsPanel
            client={{ list: async () => data, refresh: async () => data }}
            instances={[provider]}
          />,
        );
      });
      expect(screen.getByRole("meter", { name: "5-hour window remaining" })).toBeVisible();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        screen.queryByRole("meter", { name: "5-hour window remaining" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Awaiting updated limits")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("states an exhausted window without inventing a percentage", async () => {
    const original = snapshot();
    const data = decodeProviderUsageLimitsSnapshot({
      ...original,
      entries: original.entries.map((entry) =>
        entry.status !== "available"
          ? entry
          : {
              ...entry,
              limits: {
                ...entry.limits,
                rateLimitWindows: [
                  {
                    window: "five_hour",
                    status: "exhausted",
                    observedAt: "2026-08-23T12:00:00.000Z",
                  },
                ],
              },
            },
      ),
    });
    render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => data, refresh: async () => data }}
        instances={[provider]}
      />,
    );
    expect(await screen.findByText("Limit reached")).toBeVisible();
    expect(
      screen.queryByRole("meter", { name: "5-hour window remaining" }),
    ).not.toBeInTheDocument();
  });

  it("does not show another host's quota when a new client fails", async () => {
    const first = { list: async () => snapshot(), refresh: async () => snapshot() };
    const { rerender } = render(<ProviderUsageLimitsPanel client={first} instances={[provider]} />);
    await screen.findByRole("meter", { name: "5-hour window remaining" });
    const second = {
      list: async () => {
        throw new Error("offline");
      },
      refresh: async () => snapshot(),
    };
    rerender(<ProviderUsageLimitsPanel client={second} instances={[provider]} />);
    expect(await screen.findByText("Provider limits are unavailable.")).toBeVisible();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh provider limits" }));
    expect(await screen.findByRole("meter", { name: "5-hour window remaining" })).toBeVisible();
    expect(screen.queryByText("Provider limits are unavailable.")).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-23T12:00:00.000Z"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows remaining quota and reset time without treating a reset as a refill", async () => {
    const client = { list: async () => snapshot(), refresh: async () => snapshot() };
    const { unmount } = render(<ProviderUsageLimitsPanel client={client} instances={[provider]} />);
    const meter = await screen.findByRole("meter", { name: "5-hour window remaining" });
    expect(meter).toHaveAttribute("value", "25");
    expect(screen.getAllByText("25% left")).toHaveLength(2);
    expect(screen.getAllByText(/Resets in 1h/)).toHaveLength(2);
    unmount();
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-23T13:01:00.000Z"));
    render(<ProviderUsageLimitsPanel client={client} instances={[provider]} />);
    expect(await screen.findAllByText("Awaiting updated limits")).toHaveLength(2);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByText("100% left")).not.toBeInTheDocument();
  });
  it("renders remaining capacity and refreshes only on explicit action", async () => {
    const list = vi.fn(async () => snapshot());
    const refresh = vi.fn(async () => snapshot());
    render(<ProviderUsageLimitsPanel client={{ list, refresh }} instances={[provider]} />);

    expect(await screen.findByText(/25 remaining of 100 requests/)).toBeVisible();
    expect(screen.getByRole("meter", { name: "5-hour window remaining" })).toHaveAttribute(
      "value",
      "25",
    );
    expect(refresh).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh provider limits" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("says limits are not reported yet rather than showing zero", async () => {
    render(
      <ProviderUsageLimitsPanel
        client={{
          list: async () => snapshot("unavailable"),
          refresh: async () => snapshot("unavailable"),
        }}
        instances={[provider]}
      />,
    );

    expect(await screen.findByText(/Not reported yet/)).toBeVisible();
    expect(screen.queryByText(/0 remaining/)).not.toBeInTheDocument();
  });

  it("labels stale values and the provider retry window", async () => {
    render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => snapshot("failed"), refresh: async () => snapshot("failed") }}
        instances={[provider]}
      />,
    );

    expect(await screen.findByText("Stale · refresh failed")).toBeVisible();
    expect(screen.getByText(/Retry after/)).toBeVisible();
    expect(screen.getByText(/Last successful read/)).toBeVisible();
    expect(screen.getByText(/25 remaining of 100 requests/)).toBeVisible();
  });

  it.each([
    {
      reason: "runtime-does-not-report" as const,
      driverKind: "opencode" as const,
      copy: /Not reported by OpenCode/,
    },
    {
      reason: "local-runtime" as const,
      driverKind: "ollama" as const,
      copy: /Runs locally, no account limits/,
    },
    {
      reason: "endpoint-silent" as const,
      driverKind: "openai-compatible" as const,
      copy: /No rate-limit headers on the last request/,
    },
  ])(
    "names the runtime and closes the question for $reason",
    async ({ reason, driverKind, copy }) => {
      const unavailable = decodeProviderUsageLimitsSnapshot({
        version: 1,
        refreshedAt: "2026-08-23T12:00:00.000Z",
        entries: [
          {
            providerInstanceId,
            status: "unavailable",
            source: "provider-runtime",
            reason,
            observedAt: "2026-08-23T12:00:00.000Z",
          },
        ],
      });
      render(
        <ProviderUsageLimitsPanel
          client={{ list: async () => unavailable, refresh: async () => unavailable }}
          instances={[{ ...provider, driverKind } as ProviderInstance]}
        />,
      );

      expect(await screen.findByText(copy)).toBeVisible();
      expect(screen.queryByText(/Not reported yet/)).not.toBeInTheDocument();
    },
  );

  it("collapses providers that cannot report limits into one closing row", async () => {
    const offId = "33333333-3333-4333-8333-333333333333" as ProviderInstanceId;
    const localId = "44444444-4444-4444-8444-444444444444" as ProviderInstanceId;
    const data = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        ...snapshot().entries,
        {
          providerInstanceId: offId,
          status: "unavailable",
          source: "provider-runtime",
          reason: "not-configured",
          observedAt: "2026-08-23T12:00:00.000Z",
        },
        {
          providerInstanceId: localId,
          status: "unavailable",
          source: "provider-runtime",
          reason: "local-runtime",
          observedAt: "2026-08-23T12:00:00.000Z",
        },
      ],
    });
    const { container } = render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => data, refresh: async () => data }}
        instances={[
          provider,
          { ...provider, id: offId, displayName: "Off provider" },
          {
            ...provider,
            id: localId,
            displayName: "Local model",
            driverKind: "ollama",
          } as ProviderInstance,
        ]}
      />,
    );

    await screen.findByRole("meter", { name: "5-hour window remaining" });
    const quiet = screen.getByText("Not reporting limits").closest("li");
    expect(quiet).not.toBeNull();
    expect(container.querySelectorAll(".provider-limits__row")).toHaveLength(2);
    expect(quiet).toHaveTextContent("Off provider · Provider off");
    expect(quiet).toHaveTextContent("Local model · Runs locally, no account limits");
    expect(screen.getByText("Primary provider")).toBeVisible();
    expect(screen.getByText("Account limits · includes other apps")).toBeVisible();
  });

  it("keeps the closing row and skips the empty note when nothing reports limits", async () => {
    render(
      <ProviderUsageLimitsPanel
        client={{
          list: async () => snapshot("unavailable"),
          refresh: async () => snapshot("unavailable"),
        }}
        instances={[provider]}
      />,
    );

    expect(await screen.findByText("Not reporting limits")).toBeVisible();
    expect(screen.getByText(/Primary provider · Not reported yet/)).toBeVisible();
    expect(
      screen.queryByText("No configured providers have reported limits."),
    ).not.toBeInTheDocument();
  });

  it("labels Codex account windows by their length", async () => {
    const codex = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        {
          providerInstanceId,
          status: "available",
          source: "provider-runtime",
          observedAt: "2026-08-23T12:00:00.000Z",
          limits: {
            providerInstanceId,
            scope: "provider-instance",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "unknown",
            source: "runtime-reported",
            confidence: "high",
            updatedAt: "2026-08-23T12:00:00.000Z",
            rateLimitWindows: [
              {
                window: "primary_5h",
                status: "allowed",
                utilization: 0.4,
                observedAt: "2026-08-23T12:00:00.000Z",
              },
              {
                window: "secondary_7d",
                status: "warning",
                utilization: 0.85,
                observedAt: "2026-08-23T12:00:00.000Z",
              },
            ],
          },
        },
      ],
    });
    render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => codex, refresh: async () => codex }}
        instances={[provider]}
      />,
    );

    expect(
      await screen.findByRole("meter", { name: "5-hour window (primary) remaining" }),
    ).toHaveAttribute("value", "60");
    expect(
      screen.getByRole("meter", { name: "7-day window (secondary) remaining" }),
    ).toHaveAttribute("value", "15");
  });

  it("shows remaining monthly Vibe Code allowance, reset time, and PAYG as a label", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T12:00:00.000Z") });
    const vibe = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-11-25T12:00:00.000Z",
      entries: [
        {
          providerInstanceId,
          status: "available",
          source: "provider-runtime",
          observedAt: "2026-11-25T12:00:00.000Z",
          limits: {
            providerInstanceId,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "runtime-reported",
            confidence: "high",
            updatedAt: "2026-11-25T12:00:00.000Z",
            rateLimitWindows: [
              {
                window: "monthly",
                status: "allowed",
                utilization: 0.12,
                resetsAt: "2026-12-01T00:00:00.000Z",
                observedAt: "2026-11-25T12:00:00.000Z",
                overage: { status: "allowed", disabledReason: "Pay as you go on" },
              },
            ],
          },
        },
      ],
    });
    try {
      await act(async () => {
        render(
          <ProviderUsageLimitsPanel
            client={{ list: async () => vibe, refresh: async () => vibe }}
            instances={[
              {
                ...provider,
                driverKind: "mistral-vibe",
                displayName: "Mistral Vibe",
              } as ProviderInstance,
            ]}
          />,
        );
      });

      expect(screen.getByRole("meter", { name: "Monthly window remaining" })).toHaveAttribute(
        "value",
        "88",
      );
      expect(screen.getByText("88% left")).toBeVisible();
      expect(screen.getByText("Pay as you go on")).toBeVisible();
      expect(screen.getByText(/Resets in /)).toBeVisible();
      expect(screen.queryByText(/0% left/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a spent Vibe included window with PAYG on as 0% left, not an account limit", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T12:00:00.000Z") });
    const vibe = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-11-25T12:00:00.000Z",
      entries: [
        {
          providerInstanceId,
          status: "available",
          source: "provider-runtime",
          observedAt: "2026-11-25T12:00:00.000Z",
          limits: {
            providerInstanceId,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "runtime-reported",
            confidence: "high",
            updatedAt: "2026-11-25T12:00:00.000Z",
            rateLimitWindows: [
              {
                window: "monthly",
                status: "exhausted",
                utilization: 1,
                resetsAt: "2026-12-01T00:00:00.000Z",
                observedAt: "2026-11-25T12:00:00.000Z",
                overage: { status: "allowed", disabledReason: "Pay as you go on" },
              },
            ],
          },
        },
      ],
    });
    try {
      await act(async () => {
        render(
          <ProviderUsageLimitsPanel
            client={{ list: async () => vibe, refresh: async () => vibe }}
            instances={[
              {
                ...provider,
                driverKind: "mistral-vibe",
                displayName: "Mistral Vibe",
              } as ProviderInstance,
            ]}
          />,
        );
      });

      expect(screen.getByRole("meter", { name: "Monthly window remaining" })).toHaveAttribute(
        "value",
        "0",
      );
      expect(screen.getByText("0% left")).toBeVisible();
      expect(screen.getByText("Pay as you go on")).toBeVisible();
      expect(screen.queryByText("Account limit reached")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says plan limits do not apply instead of drawing empty bars", async () => {
    const unavailable = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        {
          providerInstanceId,
          status: "unavailable",
          source: "provider-runtime",
          reason: "plan-limits-do-not-apply",
          observedAt: "2026-08-23T12:00:00.000Z",
        },
      ],
    });
    render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => unavailable, refresh: async () => unavailable }}
        instances={[{ ...provider, driverKind: "claude" } as ProviderInstance]}
      />,
    );
    expect(await screen.findByText(/Plan limits do not apply/)).toBeVisible();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("labels each account and shows last updated plus a local reset time", async () => {
    const secondId = "22222222-2222-4222-8222-222222222222" as ProviderInstanceId;
    const data = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        {
          providerInstanceId,
          status: "available",
          source: "provider-runtime",
          observedAt: "2026-08-23T12:00:00.000Z",
          limits: {
            providerInstanceId,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "runtime-reported",
            confidence: "high",
            updatedAt: "2026-08-23T12:00:00.000Z",
            rateLimitWindows: [
              {
                window: "five_hour",
                status: "warning",
                utilization: 0.75,
                resetsAt: "2026-08-23T17:00:00.000Z",
                observedAt: "2026-08-23T12:00:00.000Z",
                overage: { status: "allowed", inUse: true },
              },
            ],
          },
        },
        {
          providerInstanceId: secondId,
          status: "available",
          source: "provider-runtime",
          observedAt: "2026-08-23T11:00:00.000Z",
          limits: {
            providerInstanceId: secondId,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "runtime-reported",
            confidence: "high",
            updatedAt: "2026-08-23T11:00:00.000Z",
            rateLimitWindows: [
              {
                window: "seven_day",
                status: "allowed",
                utilization: 0.2,
                resetsAt: "2026-08-30T12:00:00.000Z",
                observedAt: "2026-08-23T11:00:00.000Z",
              },
            ],
          },
        },
      ],
    });
    render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => data, refresh: async () => data }}
        instances={[
          { ...provider, displayName: "Home Claude" },
          { ...provider, id: secondId, displayName: "Work Claude" },
        ]}
      />,
    );
    expect(await screen.findByText("Home Claude")).toBeVisible();
    expect(screen.getByText("Work Claude")).toBeVisible();
    expect(screen.getAllByText(/Last updated/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Overage in use/)).toBeVisible();
    expect(screen.getAllByText(/Resets in /).length).toBeGreaterThanOrEqual(2);
  });

  it("renders Antigravity status-line windows with Gemini and Claude & GPT labels and connect/terminal controls", async () => {
    const agyId = "33333333-3333-4333-8333-333333333333" as ProviderInstanceId;
    const agyInstance = {
      id: agyId,
      displayName: "Google Antigravity",
      driverKind: "antigravity",
      enabled: true,
      environmentPolicy: "inherit-host",
      configuration: { kind: "antigravity-acp", binaryPath: "/usr/local/bin/agy" },
      version: 1,
      createdAt: "2026-08-23T12:00:00.000Z",
      updatedAt: "2026-08-23T12:00:00.000Z",
    } as ProviderInstance;
    const data = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        {
          providerInstanceId: agyId,
          status: "available",
          source: "provider-runtime",
          observedAt: "2026-08-23T12:00:00.000Z",
          limits: {
            providerInstanceId: agyId,
            scope: "account",
            requests: { status: "unavailable" },
            tokens: { status: "unavailable" },
            concurrency: { status: "unavailable" },
            retry: { status: "inactive" },
            quota: "available",
            source: "runtime-reported",
            confidence: "high",
            updatedAt: "2026-08-23T12:00:00.000Z",
            rateLimitWindows: [
              {
                window: "gemini:five_hour",
                status: "allowed",
                utilization: 0.04,
                resetsAt: "2026-08-23T14:00:00.000Z",
                observedAt: "2026-08-23T12:00:00.000Z",
              },
              {
                window: "claude_gpt:seven_day",
                status: "allowed",
                utilization: 0,
                observedAt: "2026-08-23T12:00:00.000Z",
              },
            ],
          },
        },
      ],
    });
    const openTerminal = vi.fn(async () => ({ opened: true }));
    const disconnect = vi.fn(async () => ({ restored: true, status: { connected: false } }));
    render(
      <ProviderUsageLimitsPanel
        client={{
          list: async () => data,
          refresh: async () => data,
          antigravityStatusLineStatus: async () => ({
            connected: true,
            planTier: "Google AI Ultra",
          }),
          connectAntigravityStatusLine: async () => ({ connected: true }),
          disconnectAntigravityStatusLine: disconnect,
          openAntigravityTerminal: openTerminal,
        }}
        instances={[agyInstance]}
      />,
    );
    expect(await screen.findByText("Gemini · 5-hour window")).toBeVisible();
    expect(screen.getByText("Claude & GPT · 7-day window")).toBeVisible();
    expect(screen.getByText(/Google AI Ultra/)).toBeVisible();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open agy in terminal" }));
    expect(openTerminal).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
