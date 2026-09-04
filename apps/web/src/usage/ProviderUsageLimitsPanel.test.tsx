import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
  it("renders remaining capacity and refreshes only on explicit action", async () => {
    const list = vi.fn(async () => snapshot());
    const refresh = vi.fn(async () => snapshot());
    render(<ProviderUsageLimitsPanel client={{ list, refresh }} instances={[provider]} />);

    expect(await screen.findByText(/25 remaining of 100 requests/)).toBeVisible();
    expect(screen.getByText(/5-hour window · Warning · 75% used/)).toBeVisible();
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

    expect(await screen.findByText(/5-hour window \(primary\) · Allowed · 40% used/)).toBeVisible();
    expect(screen.getByText(/7-day window \(secondary\) · Warning · 85% used/)).toBeVisible();
  });
});
