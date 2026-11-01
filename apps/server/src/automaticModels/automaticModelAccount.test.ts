import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderUsageLimitsSnapshot,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { createAutomaticModelAccountCheck } from "./automaticModelAccount";

const id = "work-claude" as ProviderInstanceId;
const instance = (enabled: boolean) =>
  ({ id, enabled, displayName: "Work Claude" }) as unknown as ProviderInstance;
const snapshot = (windowStatus: "allowed" | "exhausted", resetsAt?: string) =>
  ({
    version: 1,
    refreshedAt: "2026-11-01T10:00:00.000Z",
    entries: [
      {
        providerInstanceId: id,
        status: "available",
        limits: {
          quota: "available",
          rateLimitWindows: [
            { window: "5h", status: windowStatus, ...(resetsAt ? { resetsAt } : {}) },
          ],
        },
      },
    ],
  }) as unknown as ProviderUsageLimitsSnapshot;

const check = (input: {
  enabled?: boolean;
  readiness?: "ready" | "unauthenticated";
  limits?: ProviderUsageLimitsSnapshot;
}) =>
  createAutomaticModelAccountCheck({
    readProviderInstance: () => instance(input.enabled ?? true),
    readiness: () => input.readiness ?? "ready",
    limits: () => input.limits ?? snapshot("allowed"),
    nowMs: () => Date.parse("2026-11-01T10:00:00.000Z"),
  })(id);

describe("the account chosen for an automatic call", () => {
  it("may be asked while it is on, ready and under its limit", () => {
    expect(check({})).toBeUndefined();
  });

  it("says why it cannot be asked when it is off, not ready or at its limit", () => {
    expect(check({ enabled: false })).toBe("Work Claude is turned off.");
    expect(check({ readiness: "unauthenticated" })).toBe("Work Claude is not ready.");
    expect(check({ limits: snapshot("exhausted", "2026-11-01T12:00:00.000Z") })).toBe(
      "Work Claude is at its usage limit.",
    );
  });

  it("may be asked again once the spent window has reset", () => {
    expect(check({ limits: snapshot("exhausted", "2026-11-01T09:00:00.000Z") })).toBeUndefined();
  });
});
