import { describe, expect, it } from "vitest";
import { ProviderUsageLimitsSnapshot, decodeHostAnswer } from "@octant/contracts";
import { mobileUsageAccounts, readMobileProviderUsageLimits } from "./mobileUsageLimitsClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const observedAt = "2026-11-26T09:59:00.000Z";
const later = "2026-11-26T15:00:00.000Z";
const earlier = "2026-11-26T08:00:00.000Z";
const instance = "00000000-0000-4000-8000-000000000301";

function limits(windows: ReadonlyArray<Record<string, unknown>>) {
  return {
    providerInstanceId: instance,
    scope: "account",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "unavailable" },
    retry: { status: "inactive" },
    quota: "available",
    source: "runtime-reported",
    confidence: "high",
    updatedAt: observedAt,
    rateLimitWindows: windows,
  };
}

function window(extra: Record<string, unknown>) {
  return { window: "five_hour", status: "allowed", observedAt, ...extra };
}

function snapshot(entry: Record<string, unknown>): ProviderUsageLimitsSnapshot {
  return decodeHostAnswer(ProviderUsageLimitsSnapshot)({
    version: 1,
    refreshedAt: observedAt,
    entries: [{ providerInstanceId: instance, source: "provider-runtime", observedAt, ...entry }],
  });
}

describe("mobile usage accounts", () => {
  it("reads a window below the warning share as ok, and names it by its length", () => {
    const [account] = mobileUsageAccounts(
      snapshot({
        status: "available",
        limits: limits([window({ utilization: 0.42, resetsAt: later })]),
      }),
      NOW,
    );
    expect(account).toEqual({
      providerInstanceId: instance,
      state: "windows",
      rows: [
        {
          window: "five_hour",
          name: "5-hour limit",
          usedPercent: 42,
          level: "ok",
          resetsAt: later,
        },
      ],
    });
  });

  it("reads a window at eighty percent or reported as warning as near, and an exhausted one as spent", () => {
    const [account] = mobileUsageAccounts(
      snapshot({
        status: "available",
        limits: limits([
          window({ window: "five_hour", utilization: 0.8, resetsAt: later }),
          window({ window: "seven_day", status: "warning", utilization: 0.5, resetsAt: later }),
          window({ window: "monthly", status: "exhausted", utilization: 1, resetsAt: later }),
        ]),
      }),
      NOW,
    );
    expect(account?.state === "windows" ? account.rows.map((row) => row.level) : []).toEqual([
      "near",
      "near",
      "spent",
    ]);
  });

  it("drops a window whose reset has passed and one with no utilization", () => {
    const [account] = mobileUsageAccounts(
      snapshot({
        status: "available",
        limits: limits([
          window({ utilization: 0.9, resetsAt: earlier }),
          window({ window: "seven_day", resetsAt: later }),
        ]),
      }),
      NOW,
    );
    expect(account).toEqual({
      providerInstanceId: instance,
      state: "unavailable",
      reason: "No usage figures are reported right now.",
    });
  });

  it("shows a spent window with no figure as a reached limit, not as no figures", () => {
    const [account] = mobileUsageAccounts(
      snapshot({
        status: "available",
        limits: limits([window({ status: "exhausted", resetsAt: later })]),
      }),
      NOW,
    );
    expect(account?.state === "windows" ? account.rows.map((row) => row.level) : []).toEqual([
      "spent",
    ]);
  });

  it("says in a sentence why an account reports no limits", () => {
    const [account] = mobileUsageAccounts(
      snapshot({ status: "unavailable", reason: "local-runtime" }),
      NOW,
    );
    expect(account).toEqual({
      providerInstanceId: instance,
      state: "unavailable",
      reason: "This model runs on the computer, so there is no plan to measure.",
    });
  });

  it("keeps the last good windows, marked old, beside a failed read", () => {
    const [account] = mobileUsageAccounts(
      snapshot({
        status: "failed",
        failure: { category: "timeout", message: "The provider took too long." },
        staleLimits: limits([
          window({ utilization: 0.3, resetsAt: later }),
          window({ window: "seven_day", utilization: 0.3, resetsAt: earlier }),
        ]),
      }),
      NOW,
    );
    expect(account).toMatchObject({
      state: "failed",
      message: "The provider took too long.",
      staleRows: [{ window: "five_hour", usedPercent: 30, old: true }],
    });
  });
});

function transport(response: MobileRemoteTransport["authenticatedFetch"]): MobileRemoteTransport {
  return { hostId: "host", authenticatedFetch: response };
}

describe("reading a computer's plan usage", () => {
  it("reads a snapshot the computer shares", async () => {
    const body = snapshot({ status: "unavailable", reason: "unsupported" });
    const result = await readMobileProviderUsageLimits(
      transport(async () => Response.json(body)),
      { refresh: false },
    );
    expect(result).toEqual({ status: "read", snapshot: body });
  });

  it("asks the computer to look again when refreshing", async () => {
    const seen: string[] = [];
    await readMobileProviderUsageLimits(
      transport(async (input) => {
        seen.push(`${input.method} ${input.path}`);
        return new Response("{}", { status: 500 });
      }),
      { refresh: true },
    );
    expect(seen).toEqual(["POST /api/provider-usage-limits/refresh"]);
  });

  it("reports a refusal when the computer does not share usage with this phone", async () => {
    const result = await readMobileProviderUsageLimits(
      transport(async () => new Response("{}", { status: 403 })),
      { refresh: false },
    );
    expect(result).toEqual({ status: "refused" });
  });

  it("reports an answer it cannot read as unavailable", async () => {
    const result = await readMobileProviderUsageLimits(
      transport(async () => Response.json({ version: 2 })),
      { refresh: false },
    );
    expect(result.status).toBe("unavailable");
  });

  it("reports an unreachable computer as unavailable", async () => {
    const result = await readMobileProviderUsageLimits(
      transport(async () => {
        throw new Error("offline");
      }),
      { refresh: false },
    );
    expect(result).toEqual({
      status: "unavailable",
      message: "The computer could not be reached.",
    });
  });
});
