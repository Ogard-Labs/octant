import { describe, expect, it, vi } from "vitest";
import { ownNightlyInstallationNative } from "./nightlyInstallationNative";

function binding() {
  return {
    inspect: vi.fn(async (): Promise<unknown> => ({ kind: "absent" })),
    prepareInstall: vi.fn(async (): Promise<unknown> => ({ kind: "prepared" })),
    commitInstall: vi.fn(
      async (): Promise<unknown> => ({ kind: "installed", version: "0.1.2", running: false }),
    ),
    open: vi.fn(async (): Promise<unknown> => ({ kind: "opened" })),
    remove: vi.fn(async (): Promise<unknown> => ({ kind: "removed" })),
    cancel: vi.fn(async (): Promise<unknown> => ({ kind: "cancelled" })),
    close: vi.fn(async (): Promise<unknown> => ({ kind: "closed" })),
  };
}

describe("the closed native Nightly installation port", () => {
  it("passes only bytes and a bounded exact version to preparation, and exposes no destination", async () => {
    const raw = binding();
    const native = ownNightlyInstallationNative(raw);
    const bytes = new Uint8Array([80, 75, 3, 4]);
    expect(await native.prepareInstall(bytes, "0.1.2")).toEqual({ kind: "prepared" });
    expect(raw.prepareInstall).toHaveBeenCalledWith(bytes, "0.1.2");
    expect(await native.prepareInstall(bytes, "../other")).toEqual({
      kind: "refused",
      reason: "invalid-artifact",
    });
    expect(raw.prepareInstall).toHaveBeenCalledTimes(1);
    expect(await native.commitInstall()).toEqual({
      kind: "installed",
      version: "0.1.2",
      running: false,
    });
    expect(raw.commitInstall).toHaveBeenCalledWith();
  });

  it("refuses malformed native identities and never returns untrusted native diagnostics", async () => {
    const raw = binding();
    raw.inspect.mockResolvedValue({
      kind: "installed",
      version: "private/path",
      running: false,
      diagnostic: "private",
    });
    const native = ownNightlyInstallationNative(raw);
    expect(await native.inspect()).toEqual({ kind: "refused", reason: "native-unavailable" });
    raw.open.mockRejectedValue(new Error("private native diagnostic"));
    expect(await native.open()).toEqual({ kind: "refused", reason: "native-unavailable" });
  });

  it("keeps failed close distinct from confirmed closed and refuses subsequent admissions", async () => {
    const raw = binding();
    raw.close.mockResolvedValue({ kind: "failed", reason: "deadline-exceeded" });
    const native = ownNightlyInstallationNative(raw);
    expect(await native.close()).toEqual({ kind: "failed", reason: "deadline-exceeded" });
    expect(await native.inspect()).toEqual({ kind: "refused", reason: "closed" });
    expect(await native.close()).toEqual({ kind: "failed", reason: "deadline-exceeded" });
    expect(raw.close).toHaveBeenCalledTimes(1);
    // Cleanup can finish late native staging, but never reopens admission.
    expect(await native.cancel()).toEqual({ kind: "cancelled" });
    expect(await native.prepareInstall(new Uint8Array([1]), "0.1.2")).toEqual({
      kind: "refused",
      reason: "closed",
    });
    expect(await native.commitInstall()).toEqual({ kind: "refused", reason: "closed" });
    expect(await native.open()).toEqual({ kind: "refused", reason: "closed" });
    expect(await native.remove()).toEqual({ kind: "refused", reason: "closed" });
    expect(raw.prepareInstall).not.toHaveBeenCalled();
    expect(raw.commitInstall).not.toHaveBeenCalled();
    expect(raw.open).not.toHaveBeenCalled();
    expect(raw.remove).not.toHaveBeenCalled();
  });

  it("does not turn an unknown cancellation result into confirmed cleanup", async () => {
    const raw = binding();
    raw.cancel.mockResolvedValue({ kind: "closed" });
    expect(await ownNightlyInstallationNative(raw).cancel()).toEqual({
      kind: "failed",
      reason: "native-unavailable",
    });
  });
});
