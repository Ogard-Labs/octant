import { act, fireEvent, render, screen } from "@testing-library/react";
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
    // Two accounts of one provider pool into one row; each account's full
    // reading stays behind "Each account".
    await userEvent.click(await screen.findByText("Each account"));
    expect(screen.getAllByText("Home Claude").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Work Claude").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Last updated/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Overage in use/)).toBeVisible();
    expect(screen.getAllByText(/Resets in /).length).toBeGreaterThanOrEqual(2);
  });

  it("renders provider-neutral capture controls, Gemini and Claude & GPT labels, and reloads automatically after launching interactive refresh", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-23T12:00:00.000Z") });
    try {
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
      const makeSnapshot = (updatedAt: string, utilization: number) =>
        decodeProviderUsageLimitsSnapshot({
          version: 1,
          refreshedAt: updatedAt,
          entries: [
            {
              providerInstanceId: agyId,
              status: "available",
              source: "provider-runtime",
              observedAt: updatedAt,
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
                updatedAt,
                rateLimitWindows: [
                  {
                    window: "gemini:five_hour",
                    status: "allowed",
                    utilization,
                    resetsAt: "2026-08-23T14:00:00.000Z",
                    observedAt: updatedAt,
                  },
                  {
                    window: "claude_gpt:seven_day",
                    status: "allowed",
                    utilization: 0,
                    observedAt: updatedAt,
                  },
                ],
              },
            },
          ],
        });
      const initial = makeSnapshot("2026-08-23T11:59:00.000Z", 0.04);
      const preLaunch = makeSnapshot("2026-08-23T11:59:30.000Z", 0.07);
      const updated = makeSnapshot("2026-08-23T12:00:03.000Z", 0.1);
      let listCalls = 0;
      const list = vi.fn(async () => {
        listCalls += 1;
        if (listCalls === 1) return initial;
        if (listCalls === 2) return preLaunch;
        return updated;
      });
      const triggerRefresh = vi.fn(async () => ({ launched: true }));
      const captureStatus = {
        connected: true,
        planTier: "Google AI Ultra",
        summary: "Antigravity CLI status line · shared Google AI quota",
        disconnectedHint: "Connect hook.",
        connectedHint: "Connected.",
        connectLabel: "Connect status line",
        refreshActionLabel: "Open agy in terminal",
      };
      const disconnect = vi.fn(async () => ({
        restored: true,
        status: { ...captureStatus, connected: false },
      }));
      await act(async () => {
        render(
          <ProviderUsageLimitsPanel
            client={{
              list,
              refresh: async () => updated,
              listLimitsCaptures: async () => ({ [String(agyId)]: captureStatus }),
              connectLimitsCapture: async () => captureStatus,
              disconnectLimitsCapture: disconnect,
              triggerLimitsCaptureRefresh: triggerRefresh,
            }}
            instances={[agyInstance]}
          />,
        );
      });
      expect(screen.getByText("Gemini · 5-hour window")).toBeVisible();
      expect(screen.getByText("Claude & GPT · 7-day window")).toBeVisible();
      expect(screen.getByText("96% left")).toBeVisible();
      expect(screen.getByText(/Google AI Ultra/)).toBeVisible();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open agy in terminal" }));
      });
      expect(triggerRefresh).toHaveBeenCalledExactlyOnceWith(String(agyId));

      // First poll returns a pre-launch reading: keep polling until a post-launch reading arrives.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(screen.getByText("93% left")).toBeVisible();
      expect(screen.getByText(/Waiting for fresh limits/)).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(screen.getByText("90% left")).toBeVisible();
      expect(screen.getByText("Updated limits received.")).toBeVisible();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      });
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(String(agyId));
    } finally {
      vi.useRealTimers();
    }
  });

  it("groups two Claude accounts into one window bar with two segments", async () => {
    const secondId = "33333333-3333-4333-8333-333333333333" as ProviderInstanceId;
    const account = (id: ProviderInstanceId, utilization: number, resetsAt: string) => ({
      providerInstanceId: id,
      status: "available" as const,
      source: "provider-runtime" as const,
      observedAt: "2026-08-23T12:00:00.000Z",
      limits: {
        providerInstanceId: id,
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
            status: "allowed",
            utilization,
            resetsAt,
            observedAt: "2026-08-23T12:00:00.000Z",
          },
        ],
      },
    });
    const data = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        account(providerInstanceId, 0.6, "2026-08-23T16:00:00.000Z"),
        account(secondId, 0.1, "2026-08-23T14:00:00.000Z"),
      ],
    });
    render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => data, refresh: async () => data }}
        instances={[
          { ...provider, driverKind: "claude", displayName: "Home Claude" } as ProviderInstance,
          {
            ...provider,
            driverKind: "claude",
            id: secondId,
            displayName: "Work Claude",
          } as ProviderInstance,
        ]}
      />,
    );
    await screen.findByText("Each account");
    const bars = document.querySelectorAll("[data-pooled-window]");
    expect(bars).toHaveLength(1);
    const bar = bars[0] as HTMLElement;
    const segments = bar.querySelectorAll("meter");
    expect(segments).toHaveLength(2);
    // The account that refills first leads, and the bar names that reset.
    expect(segments[0]?.getAttribute("aria-label")).toBe("Work Claude, 5-hour window remaining");
    expect(segments[0]?.getAttribute("value")).toBe("90");
    expect(segments[1]?.getAttribute("value")).toBe("40");
    expect(
      bar.querySelector(".provider-limits__window-heading time")?.getAttribute("dateTime"),
    ).toBe("2026-08-23T14:00:00.000Z");
    expect(screen.getByText(/2 accounts · each account counted on its own/)).toBeVisible();
  });

  it("says a pooled reading whose reset passed is awaiting updated limits, and draws a spent account as an empty meter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-23T15:00:00.000Z"));
    const secondId = "55555555-5555-4555-8555-555555555555" as ProviderInstanceId;
    const account = (id: ProviderInstanceId, window: Record<string, unknown>) => ({
      providerInstanceId: id,
      status: "available" as const,
      source: "provider-runtime" as const,
      observedAt: "2026-08-23T12:00:00.000Z",
      limits: {
        providerInstanceId: id,
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
          { window: "five_hour", observedAt: "2026-08-23T12:00:00.000Z", ...window },
        ],
      },
    });
    const data = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt: "2026-08-23T12:00:00.000Z",
      entries: [
        account(providerInstanceId, {
          status: "allowed",
          utilization: 0.4,
          resetsAt: "2026-08-23T14:00:00.000Z",
        }),
        account(secondId, { status: "exhausted", resetsAt: "2026-08-23T18:00:00.000Z" }),
      ],
    });
    try {
      render(
        <ProviderUsageLimitsPanel
          client={{ list: async () => data, refresh: async () => data }}
          instances={[provider, { ...provider, id: secondId, displayName: "Spent account" }]}
        />,
      );
      await screen.findByText("Each account");
      const bar = document.querySelector('[data-pooled-window="five_hour"]') as HTMLElement;
      expect(bar).toHaveTextContent("Awaiting updated limits");
      expect(bar).not.toHaveTextContent("Remaining not reported");
      expect(bar.querySelector('[data-state="awaiting"]')).not.toBeNull();
      const spent = bar.querySelector('meter[data-state="exhausted"]');
      expect(spent?.getAttribute("value")).toBe("0");
      expect(bar.querySelector('[data-state="missing"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an account without a reading is labelled, not counted as zero", async () => {
    const secondId = "44444444-4444-4444-8444-444444444444" as ProviderInstanceId;
    const data = decodeProviderUsageLimitsSnapshot({
      ...snapshot("available"),
      entries: [
        ...snapshot("available").entries,
        {
          providerInstanceId: secondId,
          status: "failed",
          source: "provider-runtime",
          observedAt: "2026-08-23T12:05:00.000Z",
          failure: { category: "timeout", message: "Provider limits could not be read." },
        },
      ],
    });
    render(
      <ProviderUsageLimitsPanel
        client={{ list: async () => data, refresh: async () => data }}
        instances={[provider, { ...provider, id: secondId, displayName: "Second account" }]}
      />,
    );
    await screen.findByText("Each account");
    const bar = document.querySelector('[data-pooled-window="five_hour"]') as HTMLElement;
    expect(bar.querySelectorAll("meter")).toHaveLength(1);
    expect(bar.querySelector('[data-state="missing"]')).not.toBeNull();
    const missing = bar.querySelector('[data-segment="missing"]');
    expect(missing).toHaveTextContent("Second account");
    expect(missing).toHaveTextContent("No reading");
    expect(missing).not.toHaveTextContent("0%");
  });
});
