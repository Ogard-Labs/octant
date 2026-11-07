import { describe, expect, it, vi } from "vitest";
import {
  decodeCodeThreadId,
  decodeDesktopLease,
  decodeDesktopLeaseId,
  decodeEventActor,
} from "@octant/contracts";
import { createFakeDesktopProvider } from "../../../../packages/plugin-api/src/fakeDesktopProvider";
import type { DesktopProvider } from "@octant/plugin-api/desktop-provider";
import { createDesktopPreviewService } from "./desktopPreviewService";

const threadId = "f7000000-0000-4000-8000-000000000001";
const leaseId = decodeDesktopLeaseId("f7000000-0000-4000-8000-000000000002");
const start = Date.parse("2026-11-07T12:00:00Z");

function fixture() {
  let time = start;
  let revision = "original";
  let available = true;
  const close = vi.fn(async (): Promise<"closed" | "unconfirmed"> => "closed");
  const open = vi.fn<NonNullable<DesktopProvider["openPreview"]>>(async (handle, input) => ({
    status: "ready",
    guestUrl: `http://127.0.0.1:${input.port}/`,
    close,
  }));
  const provider = { ...createFakeDesktopProvider().provider, openPreview: open };
  const handle = { leaseId, resource: "one-lease" };
  const lease = decodeDesktopLease({
    leaseId,
    owner: { mode: "code", threadId },
    providerId: "fake-desktop",
    locality: "host-local",
    billed: false,
    state: "ready",
    requestedAt: new Date(start).toISOString(),
    expiresAt: new Date(start + 1_800_000).toISOString(),
    maximumExpiresAt: new Date(start + 3_600_000).toISOString(),
    updatedAt: new Date(start).toISOString(),
    idleMinutes: 15,
  });
  const caller = {
    owner: { mode: "code" as const, threadId },
    actor: decodeEventActor({
      kind: "local-user",
      actorId: "f7000000-0000-4000-8000-000000000003",
    }),
    scopeId: "f7000000-0000-4000-8000-000000000004",
    leaseId,
  };
  const observe = vi.fn(async () => ({
    status: "listed" as const,
    ownership: "octant-owned" as const,
    health: "listening" as const,
    threadId: decodeCodeThreadId(threadId),
    endpoint: { url: "http://127.0.0.1:5173/", port: 5173, pid: 42, processName: "node" },
  }));
  const audit = vi.fn();
  const service = createDesktopPreviewService({
    lease: () => (available ? { lease, provider, handle, authority: "approval-gated" } : undefined),
    revision: () => revision,
    observe,
    audit,
    now: () => time,
  });
  const request = (kind: "preview-review" | "preview-read") =>
    kind === "preview-review"
      ? service.request(caller, { kind, threadId, leaseId, port: 5173 })
      : service.request(caller, { kind, threadId, leaseId });
  return {
    service,
    caller,
    request,
    open,
    close,
    audit,
    observe,
    change: () => {
      revision = "changed";
    },
    expire: () => {
      time += 120_001;
    },
    revoke: () => {
      available = false;
    },
  };
}

describe("lease-bound preview permission", () => {
  it("does not open anything during review and revokes the approved relay when task authority changes", async () => {
    const f = fixture();
    const review = await f.request("preview-review");
    expect(review.status).toBe("preview-review");
    expect(f.open).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
    if (review.status !== "preview-review") throw new Error("review missing");
    const answer = await f.service.request(f.caller, {
      kind: "preview-grant",
      threadId,
      leaseId,
      reviewId: review.reviewId,
    });
    expect(answer.status).toBe("preview-ready");
    expect(f.open).toHaveBeenCalledOnce();
    f.change();
    await f.service.sweep();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.audit.mock.calls.map(([kind]) => kind)).toEqual(["granted", "closed"]);
    expect(await f.request("preview-read")).toEqual({ status: "preview-state", available: true });
    await f.service.close();
  });

  it("refuses another window and an expired review without opening the desktop port", async () => {
    const f = fixture();
    const review = await f.request("preview-review");
    if (review.status !== "preview-review") throw new Error("review missing");
    await expect(
      f.service.request(
        { ...f.caller, scopeId: "other-window" },
        { kind: "preview-grant", threadId, leaseId, reviewId: review.reviewId },
      ),
    ).resolves.toEqual({ status: "preview-refused", reason: "stale" });
    f.expire();
    await expect(
      f.service.request(f.caller, {
        kind: "preview-grant",
        threadId,
        leaseId,
        reviewId: review.reviewId,
      }),
    ).resolves.toEqual({ status: "preview-refused", reason: "stale" });
    expect(f.open).not.toHaveBeenCalled();
    await f.service.close();
  });

  it("rechecks a review after observing the server and consumes the approval only once", async () => {
    const f = fixture();
    const review = await f.request("preview-review");
    if (review.status !== "preview-review") throw new Error("review missing");
    const answers = await Promise.all(
      [0, 1].map(() =>
        f.service.request(f.caller, {
          kind: "preview-grant",
          threadId,
          leaseId,
          reviewId: review.reviewId,
        }),
      ),
    );
    expect(answers.filter((answer) => answer.status === "preview-ready")).toHaveLength(1);
    expect(f.open).toHaveBeenCalledOnce();
    f.revoke();
    await f.service.sweep();
    expect(f.close).toHaveBeenCalledOnce();
    await f.service.close();
  });

  it("keeps revoked access closed while unconfirmed guest cleanup blocks another grant", async () => {
    const f = fixture();
    const review = await f.request("preview-review");
    if (review.status !== "preview-review") throw new Error("review missing");
    const granted = await f.service.request(f.caller, {
      kind: "preview-grant",
      threadId,
      leaseId,
      reviewId: review.reviewId,
    });
    if (granted.status !== "preview-ready") throw new Error("grant missing");
    f.close.mockResolvedValue("unconfirmed");
    await expect(
      f.service.request(f.caller, {
        kind: "preview-revoke",
        threadId,
        leaseId,
        grantId: granted.grant.grantId,
      }),
    ).resolves.toEqual({ status: "preview-refused", reason: "cleanup-unconfirmed" });
    await expect(f.request("preview-review")).resolves.toEqual({
      status: "preview-refused",
      reason: "busy",
    });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.audit.mock.calls.map(([kind]) => kind)).toEqual(["granted"]);
    f.close.mockResolvedValue("closed");
    await f.service.sweep();
    expect(f.audit.mock.calls.map(([kind]) => kind)).toEqual(["granted", "closed"]);
    await f.service.close();
  });
  it("reserves the lease after a timed-out opening until the late guest confirms cleanup", async () => {
    const f = fixture();
    const review = await f.request("preview-review");
    if (review.status !== "preview-review") throw new Error("review missing");
    let finish:
      | ((value: Awaited<ReturnType<NonNullable<DesktopProvider["openPreview"]>>>) => void)
      | undefined;
    f.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.close.mockResolvedValue("unconfirmed");
    vi.useFakeTimers();
    try {
      const granting = f.service.request(f.caller, {
        kind: "preview-grant",
        threadId,
        leaseId,
        reviewId: review.reviewId,
      });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await granting).toEqual({ status: "preview-refused", reason: "cleanup-unconfirmed" });
      expect(await f.request("preview-review")).toEqual({
        status: "preview-refused",
        reason: "busy",
      });
      finish?.({ status: "ready", guestUrl: "http://127.0.0.1:5173/", close: f.close });
      await vi.advanceTimersByTimeAsync(1);
      await f.service.sweep();
      expect(f.audit.mock.calls.map(([kind]) => kind)).toEqual(["granted"]);
      f.close.mockResolvedValue("closed");
      await f.service.sweep();
      expect(f.audit.mock.calls.map(([kind]) => kind)).toEqual(["granted", "closed"]);
    } finally {
      vi.useRealTimers();
      await f.service.close();
    }
  });
  it("retains an unavailable opening's cleanup ownership until the guest confirms it stopped", async () => {
    const f = fixture();
    f.close.mockResolvedValue("unconfirmed");
    f.open.mockResolvedValue({ status: "unavailable", close: f.close });
    const review = await f.request("preview-review");
    if (review.status !== "preview-review") throw new Error("review missing");
    expect(
      await f.service.request(f.caller, {
        kind: "preview-grant",
        threadId,
        leaseId,
        reviewId: review.reviewId,
      }),
    ).toEqual({ status: "preview-refused", reason: "cleanup-unconfirmed" });
    expect(await f.request("preview-review")).toEqual({
      status: "preview-refused",
      reason: "busy",
    });
    expect(f.audit.mock.calls.map(([kind]) => kind)).toEqual(["granted"]);
    f.close.mockResolvedValue("closed");
    await f.service.sweep();
    expect(f.audit.mock.calls.map(([kind]) => kind)).toEqual(["granted", "closed"]);
    await f.service.close();
  });
});
