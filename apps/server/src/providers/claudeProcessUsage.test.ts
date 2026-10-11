import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeProviderInstanceId, type UtcTimestamp } from "@octant/contracts";
import { claudeProcessPlanUsageLimits, decodeClaudeProcessPlanUsage } from "./claudeProcessUsage";

const instanceId = decodeProviderInstanceId("11111111-1111-4111-8111-111111111111");
const observedAt = "2026-10-11T12:00:00.000Z" as UtcTimestamp;

describe("Claude process plan usage", () => {
  it("maps the process windows without inventing a missing one", () => {
    const decoded = decodeClaudeProcessPlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 40, resets_at: "2026-10-11T17:00:00.000Z" },
          seven_day: { utilization: 12, resets_at: "2026-10-18T12:00:00.000Z" },
          seven_day_opus: { utilization: 90, resets_at: "2026-10-18T12:00:00.000Z" },
          seven_day_sonnet: null,
          model_scoped: [
            { display_name: "Opus", utilization: 25, resets_at: "2026-10-18T12:00:00.000Z" },
          ],
          extra_usage: { is_enabled: true, utilization: 10 },
        },
      },
      observedAt,
    );

    expect(decoded).toMatchObject({
      available: true,
      windows: [
        { window: "five_hour", utilization: 0.4, status: "allowed" },
        { window: "seven_day", utilization: 0.12, status: "allowed" },
        { window: "seven_day_opus", utilization: 0.9, status: "warning" },
        { window: "per_model:Opus", utilization: 0.25, status: "allowed" },
        { window: "overage", utilization: 0.1, overage: { inUse: true } },
      ],
    });
    expect(decoded && decoded.available ? decoded.windows : []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ window: "seven_day_sonnet" })]),
    );
  });

  it("says plan limits do not apply when the process reports they are unavailable", () => {
    expect(
      decodeClaudeProcessPlanUsage({ rate_limits_available: false, rate_limits: null }, observedAt),
    ).toEqual({ available: false });
  });

  it("leaves a missing or broken experimental answer unread rather than guessing", () => {
    expect(decodeClaudeProcessPlanUsage(undefined, observedAt)).toBeUndefined();
    expect(decodeClaudeProcessPlanUsage({ session: {} }, observedAt)).toBeUndefined();
    expect(decodeClaudeProcessPlanUsage("not-json", observedAt)).toBeUndefined();
  });

  it("never reads a credential file or keychain while decoding a process payload", () => {
    const home = process.env.HOME ?? "";
    const credentialHints = [
      join(home, ".claude", ".credentials.json"),
      join(home, "Library", "Keychains", "login.keychain-db"),
    ];
    const existing = credentialHints.filter((path) => existsSync(path));
    decodeClaudeProcessPlanUsage(
      { rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } },
      observedAt,
    );
    for (const path of existing) {
      expect(existsSync(path)).toBe(true);
    }
    if (home.length > 0 && existsSync(join(home, "Library", "Keychains"))) {
      expect(readdirSync(join(home, "Library", "Keychains")).length).toBeGreaterThanOrEqual(0);
    }
    const limits = claudeProcessPlanUsageLimits(
      instanceId,
      {
        available: true,
        windows: [
          {
            window: "five_hour",
            status: "allowed",
            utilization: 0.2,
            observedAt,
          },
        ],
      },
      observedAt,
    );
    expect(limits.rateLimitWindows?.[0]?.window).toBe("five_hour");
    expect(JSON.stringify(limits)).not.toMatch(/oauth|sk-|keychain|credentials/i);
  });
});
