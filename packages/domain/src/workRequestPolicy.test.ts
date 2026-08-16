import { describe, expect, it } from "vitest";
import {
  classifyWorkRequestProviderAuthority,
  classifyWorkRequestTransition,
  workRequestSettledIdempotently,
} from "./workRequestPolicy";

describe("classifyWorkRequestTransition", () => {
  it("allows a transition from a pending request", () => {
    expect(classifyWorkRequestTransition({ currentStatus: "pending" })).toBe("allow");
  });

  it("denies a transition from a resolved request", () => {
    expect(classifyWorkRequestTransition({ currentStatus: "resolved" })).toBe("deny");
  });

  it("denies a transition from a cancelled request", () => {
    expect(classifyWorkRequestTransition({ currentStatus: "cancelled" })).toBe("deny");
  });

  it("denies a transition from an interrupted request", () => {
    expect(classifyWorkRequestTransition({ currentStatus: "interrupted" })).toBe("deny");
  });

  it("denies a transition from an expired request", () => {
    expect(classifyWorkRequestTransition({ currentStatus: "expired" })).toBe("deny");
  });
});

describe("classifyWorkRequestProviderAuthority", () => {
  it("allows when the request provider matches the thread's current provider", () => {
    expect(
      classifyWorkRequestProviderAuthority({
        requestProviderInstanceId: "provider-a",
        threadProviderInstanceId: "provider-a",
      }),
    ).toBe("allow");
  });

  it("denies when the request provider no longer matches the thread's current provider", () => {
    expect(
      classifyWorkRequestProviderAuthority({
        requestProviderInstanceId: "provider-a",
        threadProviderInstanceId: "provider-b",
      }),
    ).toBe("deny");
  });

  it("denies when the thread has no current provider", () => {
    expect(
      classifyWorkRequestProviderAuthority({
        requestProviderInstanceId: "provider-a",
        threadProviderInstanceId: undefined,
      }),
    ).toBe("deny");
  });
});

describe("workRequestSettledIdempotently", () => {
  it("reports idempotent when the current status already matches a resolved attempt with the same resolution", () => {
    expect(
      workRequestSettledIdempotently({
        current: { status: "resolved", resolution: { kind: "approval", approved: true } },
        attempted: { kind: "resolved", resolution: { kind: "approval", approved: true } },
      }),
    ).toBe(true);
  });

  it("reports a conflict when the current resolution differs from the attempted resolution", () => {
    expect(
      workRequestSettledIdempotently({
        current: { status: "resolved", resolution: { kind: "approval", approved: true } },
        attempted: { kind: "resolved", resolution: { kind: "approval", approved: false } },
      }),
    ).toBe(false);
  });

  it("reports idempotent when the current status already matches a cancelled attempt", () => {
    expect(
      workRequestSettledIdempotently({
        current: { status: "cancelled" },
        attempted: { kind: "cancelled" },
      }),
    ).toBe(true);
  });

  it("reports idempotent when the current status already matches an interrupted attempt", () => {
    expect(
      workRequestSettledIdempotently({
        current: { status: "interrupted" },
        attempted: { kind: "interrupted" },
      }),
    ).toBe(true);
  });

  it("reports idempotent when the current status already matches an expired attempt", () => {
    expect(
      workRequestSettledIdempotently({
        current: { status: "expired" },
        attempted: { kind: "expired" },
      }),
    ).toBe(true);
  });

  it("reports a conflict when the current terminal status differs from the attempted transition", () => {
    expect(
      workRequestSettledIdempotently({
        current: { status: "cancelled" },
        attempted: { kind: "expired" },
      }),
    ).toBe(false);
  });

  it("reports a conflict when the request is still pending", () => {
    expect(
      workRequestSettledIdempotently({
        current: { status: "pending" },
        attempted: { kind: "cancelled" },
      }),
    ).toBe(false);
  });
});
