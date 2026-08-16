import { describe, expect, it } from "vitest";
import { classifyCredentialCleanupOutcome, planMigrationBackup } from "./dataLifecyclePolicy";

describe("planMigrationBackup", () => {
  it("reports an up-to-date store with no pending migrations", () => {
    expect(planMigrationBackup({ databaseVersion: 28, knownVersions: [1, 2, 3, 28] })).toEqual({
      kind: "up-to-date",
      version: 28,
    });
  });

  it("plans a backup for a multi-step forward upgrade and lists only pending versions", () => {
    expect(
      planMigrationBackup({ databaseVersion: 5, knownVersions: [1, 2, 3, 4, 5, 6, 7, 8] }),
    ).toEqual({
      kind: "upgrade",
      fromVersion: 5,
      toVersion: 8,
      pendingVersions: [6, 7, 8],
    });
  });

  it("plans a backup for a fresh store starting from version zero", () => {
    expect(planMigrationBackup({ databaseVersion: 0, knownVersions: [1, 2, 3] })).toEqual({
      kind: "upgrade",
      fromVersion: 0,
      toVersion: 3,
      pendingVersions: [1, 2, 3],
    });
  });

  it("refuses a downgrade without proposing any write when the store is newer than the binary", () => {
    expect(planMigrationBackup({ databaseVersion: 30, knownVersions: [1, 2, 3, 28] })).toEqual({
      kind: "downgrade-refused",
      databaseVersion: 30,
      latestKnownVersion: 28,
    });
  });

  it("treats an unordered, duplicated known-version list deterministically", () => {
    expect(planMigrationBackup({ databaseVersion: 2, knownVersions: [3, 1, 2, 3, 4, 1] })).toEqual({
      kind: "upgrade",
      fromVersion: 2,
      toVersion: 4,
      pendingVersions: [3, 4],
    });
  });

  it("treats an empty registry against a fresh store as up-to-date at version zero", () => {
    expect(planMigrationBackup({ databaseVersion: 0, knownVersions: [] })).toEqual({
      kind: "up-to-date",
      version: 0,
    });
  });
});

describe("classifyCredentialCleanupOutcome", () => {
  it("names the macOS Keychain residual when no host credential boundary is available", () => {
    const boundary = classifyCredentialCleanupOutcome({
      platform: "darwin",
      attempt: { kind: "not-integrated" },
    });
    expect(boundary.store).toBe("os-keychain");
    expect(boundary.performed).toBe(false);
    expect(boundary.status).toBe("not-integrated");
    expect(boundary.residualReason).toContain("Keychain");
    expect(boundary.recoveryGuidance).toBeNull();
  });

  it("reports no keychain integration on non-macOS platforms without claiming a cleanup ran", () => {
    const boundary = classifyCredentialCleanupOutcome({
      platform: "linux",
      attempt: { kind: "not-integrated" },
    });
    expect(boundary).toEqual({
      store: "os-keychain",
      performed: false,
      status: "not-integrated",
      deletedCount: 0,
      matchedCount: 0,
      residualReason: "no OS keychain integration is available on this platform",
      recoveryGuidance: null,
    });
  });

  it("reports a dry-run preview without claiming anything was deleted", () => {
    const boundary = classifyCredentialCleanupOutcome({
      platform: "darwin",
      attempt: { kind: "dry-run", matchedCount: 3 },
    });
    expect(boundary).toEqual({
      store: "os-keychain",
      performed: false,
      status: "dry-run",
      deletedCount: 0,
      matchedCount: 3,
      residualReason: null,
      recoveryGuidance: null,
    });
  });

  it("reports a completed purge as performed with the exact deleted count", () => {
    const boundary = classifyCredentialCleanupOutcome({
      platform: "darwin",
      attempt: { kind: "completed", deletedCount: 2 },
    });
    expect(boundary).toEqual({
      store: "os-keychain",
      performed: true,
      status: "completed",
      deletedCount: 2,
      matchedCount: 2,
      residualReason: null,
      recoveryGuidance: null,
    });
  });

  it("never reports a partial purge as performed and gives actionable recovery guidance", () => {
    const boundary = classifyCredentialCleanupOutcome({
      platform: "darwin",
      attempt: { kind: "partial", deletedCount: 1, failedCount: 1 },
    });
    expect(boundary.performed).toBe(false);
    expect(boundary.status).toBe("partial");
    expect(boundary.deletedCount).toBe(1);
    expect(boundary.matchedCount).toBe(2);
    expect(boundary.recoveryGuidance).toBeTruthy();
    expect(boundary.recoveryGuidance).toContain("already removed");
    expect(boundary.recoveryGuidance).toContain("1");
    expect(boundary.recoveryGuidance).toContain("Keychain cleanup is incomplete");
    expect(boundary.recoveryGuidance).not.toMatch(/[0-9a-f-]{36}/); // no credential/UUID leakage
  });

  it.each(["locked", "unavailable", "failed"] as const)(
    "classifies a %s Keychain outcome as not performed with recovery guidance",
    (kind) => {
      const boundary = classifyCredentialCleanupOutcome({
        platform: "darwin",
        attempt: { kind },
      });
      expect(boundary.performed).toBe(false);
      expect(boundary.status).toBe(kind);
      expect(boundary.deletedCount).toBe(0);
      expect(boundary.recoveryGuidance).toBeTruthy();
      expect(boundary.residualReason).toBeNull();
    },
  );

  it("requires reconciliation when a destructive Keychain purge outcome is indeterminate", () => {
    const boundary = classifyCredentialCleanupOutcome({
      platform: "darwin",
      attempt: { kind: "indeterminate" },
    });

    expect(boundary).toMatchObject({
      performed: false,
      status: "indeterminate",
      deletedCount: 0,
      matchedCount: 0,
    });
    expect(boundary.recoveryGuidance).toContain("could not be confirmed");
    expect(boundary.recoveryGuidance).toContain("retry");
  });
});
