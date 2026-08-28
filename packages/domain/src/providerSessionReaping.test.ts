import { describe, expect, it } from "vitest";
import { decodeUtcTimestamp } from "@octant/contracts";
import { reapsStaleProviderSession } from "./providerSessionReaping";

const updatedAt = decodeUtcTimestamp("2026-07-19T22:00:00.000Z");
const now = Date.parse("2026-07-19T22:10:00.000Z");

describe("reapsStaleProviderSession", () => {
  it("retains terminal and waiting attempts", () => {
    for (const outcome of ["completed", "failed", "cancelled", "interrupted", "waiting"] as const) {
      expect(
        reapsStaleProviderSession({
          attempt: { outcome, updatedAt },
          ownedByThisProcess: false,
          now,
          staleAfterMs: 0,
        }),
      ).toEqual({ kind: "retain" });
    }
  });

  it("retains a nonterminal attempt while this process owns its provider turn", () => {
    expect(
      reapsStaleProviderSession({
        attempt: { outcome: "streaming", updatedAt },
        ownedByThisProcess: true,
        now,
        staleAfterMs: 0,
      }),
    ).toEqual({ kind: "retain" });
  });

  it("reaps a stale streaming attempt and preserves whether it can resume", () => {
    expect(
      reapsStaleProviderSession({
        attempt: {
          outcome: "streaming",
          updatedAt,
          resumeCursor: { driverKind: "openai-compatible", value: "cursor" },
        },
        ownedByThisProcess: false,
        now,
        staleAfterMs: 10 * 60 * 1_000,
      }),
    ).toEqual({ kind: "reap", resumable: true });
  });

  it("retains a non-owned attempt until its stale threshold", () => {
    expect(
      reapsStaleProviderSession({
        attempt: { outcome: "queued", updatedAt },
        ownedByThisProcess: false,
        now,
        staleAfterMs: 10 * 60 * 1_000 + 1,
      }),
    ).toEqual({ kind: "retain" });
  });

  it("reaps an attempt with an unparseable timestamp as a safe recovery choice", () => {
    expect(
      reapsStaleProviderSession({
        attempt: { outcome: "queued", updatedAt: "not-a-timestamp" as typeof updatedAt },
        ownedByThisProcess: false,
        now,
        staleAfterMs: 10 * 60 * 1_000,
      }),
    ).toEqual({ kind: "reap", resumable: false });
  });
});
