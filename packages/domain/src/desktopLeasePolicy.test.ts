import { describe, expect, it } from "vitest";
import type { DesktopLeaseOwner } from "@octant/contracts";
import {
  decideDesktopArtifactPath,
  decideDesktopArtifactTransfer,
  decideDesktopLeaseAcquire,
  decideDesktopLeaseExtension,
  desktopLeaseClockEnds,
  desktopLeaseFits,
  desktopLeaseTransitionAllowed,
  desktopProviderExpiryHolds,
} from "./desktopLeasePolicy";

const owner = (threadId: string): DesktopLeaseOwner => ({ mode: "code", threadId });
const threadA = owner("a0000000-0000-4000-8000-000000000001");
const threadB = owner("a0000000-0000-4000-8000-000000000002");
const minute = 60_000;

describe("desktop lease policy", () => {
  it("writes released only from a release attempt, never straight from a running lease", () => {
    expect(desktopLeaseTransitionAllowed("ready", "released")).toBe(false);
    expect(desktopLeaseTransitionAllowed("ready", "releasing")).toBe(true);
    expect(desktopLeaseTransitionAllowed("releasing", "released")).toBe(true);
    expect(desktopLeaseTransitionAllowed("release-failed", "released")).toBe(true);
    expect(desktopLeaseTransitionAllowed("released", "releasing")).toBe(false);
  });

  it("refuses in Plan and makes a person confirm every billed lease, Full access included", () => {
    expect(
      decideDesktopLeaseAcquire({
        executionPolicy: "plan",
        billed: false,
        initiator: "local-user",
      }),
    ).toEqual({ kind: "refused", reason: "plan-mode" });
    expect(
      decideDesktopLeaseAcquire({
        executionPolicy: "full-access",
        billed: true,
        initiator: "agent",
      }),
    ).toEqual({ kind: "ask", asks: "billed" });
    expect(
      decideDesktopLeaseAcquire({
        executionPolicy: "full-access",
        billed: true,
        initiator: "local-user",
      }),
    ).toEqual({ kind: "ask", asks: "billed" });
  });

  it("asks in the thread below Full access and proceeds for Full access on a host-local desktop", () => {
    for (const executionPolicy of ["approval-gated", "auto-accept-edits"] as const) {
      expect(
        decideDesktopLeaseAcquire({ executionPolicy, billed: false, initiator: "agent" }),
      ).toEqual({ kind: "ask", asks: "in-thread" });
    }
    expect(
      decideDesktopLeaseAcquire({
        executionPolicy: "full-access",
        billed: false,
        initiator: "agent",
      }),
    ).toEqual({ kind: "proceed" });
    expect(
      decideDesktopLeaseAcquire({
        executionPolicy: "approval-gated",
        billed: false,
        initiator: "remote-device",
      }),
    ).toEqual({ kind: "proceed" });
  });

  it("caps a thread at two leases and the host at two host-local ones, counting failed releases", () => {
    const two = [
      { owner: threadA, locality: "cloud", state: "ready" },
      { owner: threadA, locality: "cloud", state: "release-failed" },
    ] as const;
    expect(desktopLeaseFits({ holdings: two, owner: threadA, locality: "cloud" })).toBe(false);
    expect(desktopLeaseFits({ holdings: two, owner: threadB, locality: "cloud" })).toBe(true);

    const hostLocal = [
      { owner: threadA, locality: "host-local", state: "ready" },
      { owner: threadB, locality: "host-local", state: "provisioning" },
    ] as const;
    const third = owner("a0000000-0000-4000-8000-000000000003");
    expect(desktopLeaseFits({ holdings: hostLocal, owner: third, locality: "host-local" })).toBe(
      false,
    );
    expect(desktopLeaseFits({ holdings: hostLocal, owner: third, locality: "cloud" })).toBe(true);
    expect(
      desktopLeaseFits({
        holdings: [{ owner: threadA, locality: "host-local", state: "released" }],
        owner: threadA,
        locality: "host-local",
      }),
    ).toBe(true);
  });

  it("ends a lease at its expiry, and when idle only while no tab is open", () => {
    const base = { expiresAt: 30 * minute, idleMinutes: 15, lastActivityAt: 0 };
    expect(desktopLeaseClockEnds({ ...base, now: 30 * minute, openTabs: 1 })).toBe("expired");
    expect(desktopLeaseClockEnds({ ...base, now: 16 * minute, openTabs: 1 })).toBeUndefined();
    expect(desktopLeaseClockEnds({ ...base, now: 16 * minute, openTabs: 0 })).toBe("idle");
    expect(desktopLeaseClockEnds({ ...base, now: 14 * minute, openTabs: 0 })).toBeUndefined();
  });

  it("lets only a person extend, and never past the recipe maximum", () => {
    const lease = { expiresAt: 30 * minute, maximumExpiresAt: 240 * minute };
    expect(decideDesktopLeaseExtension({ ...lease, actor: "agent", byMinutes: 30 })).toEqual({
      kind: "refused",
      reason: "agent-cannot-extend",
    });
    expect(decideDesktopLeaseExtension({ ...lease, actor: "local-user", byMinutes: 30 })).toEqual({
      kind: "allowed",
      expiresAt: 60 * minute,
    });
    expect(
      decideDesktopLeaseExtension({ ...lease, actor: "remote-device", byMinutes: 211 }),
    ).toEqual({ kind: "refused", reason: "beyond-maximum" });
  });

  it("refuses to keep a billed desktop whose provider-side expiry ends before the lease", () => {
    expect(
      desktopProviderExpiryHolds({ billed: true, expiresAt: 100, providerExpiresAt: undefined }),
    ).toBe(false);
    expect(
      desktopProviderExpiryHolds({ billed: true, expiresAt: 100, providerExpiresAt: 99 }),
    ).toBe(false);
    expect(
      desktopProviderExpiryHolds({ billed: true, expiresAt: 100, providerExpiresAt: 160 }),
    ).toBe(true);
    expect(
      desktopProviderExpiryHolds({ billed: false, expiresAt: 100, providerExpiresAt: undefined }),
    ).toBe(true);
  });

  it("names a transfer by one checkout-relative path and refuses absolute, escaping, and .git paths", () => {
    expect(decideDesktopArtifactPath("./dist//app.AppImage")).toEqual({
      kind: "relative",
      path: "dist/app.AppImage",
      segments: ["dist", "app.AppImage"],
      name: "app.AppImage",
    });
    expect(decideDesktopArtifactPath("/etc/passwd")).toEqual({
      kind: "refused",
      reason: "path-absolute",
    });
    for (const escaping of ["../secret", "dist/../../secret", "dist/../app"]) {
      expect(decideDesktopArtifactPath(escaping)).toEqual({
        kind: "refused",
        reason: "path-escapes-root",
      });
    }
    for (const inGit of [".git/config", "vendor/lib/.git/HEAD", ".GIT/config", ".git"]) {
      expect(decideDesktopArtifactPath(inGit)).toEqual({ kind: "refused", reason: "path-in-git" });
    }
    for (const invalid of ["", ".", "./", "dist/app\u0000x", `${"a".repeat(256)}`]) {
      expect(decideDesktopArtifactPath(invalid)).toEqual({
        kind: "refused",
        reason: "path-invalid",
      });
    }
  });

  it("refuses a transfer in Plan, asks below Full access, and always asks before data leaves the machine", () => {
    expect(
      decideDesktopArtifactTransfer({
        executionPolicy: "plan",
        locality: "host-local",
        initiator: "local-user",
      }),
    ).toEqual({ kind: "refused", reason: "plan-mode" });
    for (const executionPolicy of ["approval-gated", "auto-accept-edits"] as const) {
      expect(
        decideDesktopArtifactTransfer({
          executionPolicy,
          locality: "host-local",
          initiator: "agent",
        }),
      ).toEqual({ kind: "ask", asks: "in-thread" });
    }
    expect(
      decideDesktopArtifactTransfer({
        executionPolicy: "full-access",
        locality: "host-local",
        initiator: "agent",
      }),
    ).toEqual({ kind: "proceed" });
    expect(
      decideDesktopArtifactTransfer({
        executionPolicy: "approval-gated",
        locality: "host-local",
        initiator: "remote-device",
      }),
    ).toEqual({ kind: "proceed" });
    for (const initiator of ["agent", "local-user"] as const) {
      expect(
        decideDesktopArtifactTransfer({
          executionPolicy: "full-access",
          locality: "cloud",
          initiator,
        }),
      ).toEqual({ kind: "ask", asks: "off-machine" });
    }
  });
});
