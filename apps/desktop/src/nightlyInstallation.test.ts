import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalReleaseBytes } from "@octant/domain";
import { decodeAppUpdateRelease } from "@octant/contracts/app-updates";
import { createFeedVerifier } from "./appUpdateFeed";
import { createNightlyInstallation } from "./nightlyInstallation";
import type { NativeNightlyInstallation } from "./nightlyInstallationNative";

const keys = generateKeyPairSync("ed25519");
const key = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const bytes = new Uint8Array([1, 2, 3]);
const version = "0.1.0-preview.20261104.1";
const release = decodeAppUpdateRelease({
  version,
  ring: "preview",
  platform: "darwin",
  arch: "arm64",
  url: "https://updates.example.test/Nightly.zip",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  releasedAt: "2026-11-04T10:00:00.000Z",
});
function fixture() {
  let installed = false;
  let current = true;
  const native = {
    inspect: vi.fn<NativeNightlyInstallation["inspect"]>(async () =>
      installed
        ? { kind: "installed" as const, version, running: false }
        : { kind: "absent" as const },
    ),
    prepareInstall: vi.fn<NativeNightlyInstallation["prepareInstall"]>(async () => ({
      kind: "prepared" as const,
    })),
    commitInstall: vi.fn<NativeNightlyInstallation["commitInstall"]>(async () => {
      installed = true;
      return { kind: "installed" as const, version, running: false };
    }),
    open: vi.fn<NativeNightlyInstallation["open"]>(async () => ({ kind: "opened" as const })),
    remove: vi.fn<NativeNightlyInstallation["remove"]>(async () => {
      installed = false;
      return { kind: "removed" as const };
    }),
    cancel: vi.fn<NativeNightlyInstallation["cancel"]>(async () => ({
      kind: "cancelled" as const,
    })),
    close: vi.fn<NativeNightlyInstallation["close"]>(async () => ({ kind: "closed" as const })),
  } satisfies NativeNightlyInstallation;
  const document = {
    schemaVersion: 1,
    release,
    signature: sign(null, canonicalReleaseBytes(release), keys.privateKey).toString("base64"),
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request) =>
    String(url).includes(".json") ? Response.json(document) : new Response(bytes),
  );
  const service = createNightlyInstallation({
    native,
    app: { packaged: true, platform: "darwin", arch: "arm64", version: "0.1.0" },
    feedBaseUrl: "https://updates.example.test",
    fetchImpl,
    verifier: createFeedVerifier({ stable: [key], preview: [key], candidate: [key] }),
  });
  const owner = { key: {}, current: () => current };
  return {
    native,
    document,
    fetchImpl,
    service,
    owner,
    retire: () => {
      current = false;
    },
    setInstalled: (value: boolean) => {
      installed = value;
    },
  };
}

describe("manual Nightly installation", () => {
  it("preserves an explicit native close deadline failure", async () => {
    const f = fixture();
    f.native.close.mockResolvedValueOnce({ kind: "failed", reason: "deadline-exceeded" });
    expect(await f.service.close()).toEqual({ kind: "failed", reason: "deadline-exceeded" });
  });

  it("does not report cleanup complete while the native close is still pending", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const closing = Promise.withResolvers<{ readonly kind: "closed" }>();
    f.native.close.mockImplementation(() => closing.promise);
    try {
      const pending = f.service.close();
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({ kind: "failed", reason: "deadline-exceeded" });
      expect(f.service.snapshot()).toMatchObject({ status: "unavailable", reason: "closed" });
    } finally {
      closing.resolve({ kind: "closed" });
      vi.useRealTimers();
    }
  });

  it("keeps a completed installation visible when cancellation arrives after the OS commit boundary", async () => {
    const f = fixture();
    const committed = Promise.withResolvers<{
      readonly kind: "installed";
      readonly version: string;
      readonly running: boolean;
    }>();
    const cancelled = Promise.withResolvers<{ readonly kind: "cancelled" }>();
    f.native.commitInstall.mockImplementation(() => committed.promise);
    f.native.cancel.mockImplementation(() => cancelled.promise);
    await f.service.refresh();
    const installing = f.service.install(f.owner);
    await vi.waitFor(() => expect(f.native.commitInstall).toHaveBeenCalledOnce());
    f.setInstalled(true);
    const stopping = f.service.cancel(f.owner);
    committed.resolve({ kind: "installed", version, running: false });
    cancelled.resolve({ kind: "cancelled" });
    expect(await stopping).toMatchObject({
      status: "ready",
      application: { kind: "installed", version },
    });
    expect(await installing).toMatchObject({ status: "ready", application: { kind: "installed" } });
    expect(f.native.remove).not.toHaveBeenCalled();
    await f.service.close();
  });

  it("checks no feed until the person installs, then verifies the separate preview without comparing it with Stable's version", async () => {
    const f = fixture();
    await f.service.refresh();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    const result = await f.service.install(f.owner);
    expect(result).toMatchObject({ status: "ready", application: { kind: "installed", version } });
    expect(Array.from(f.native.prepareInstall.mock.calls[0]?.[0] ?? [])).toEqual(Array.from(bytes));
    expect(f.native.prepareInstall.mock.calls[0]?.[1]).toBe(version);
    expect(f.native.commitInstall).toHaveBeenCalledOnce();
    expect(f.fetchImpl.mock.calls[0]?.[0]).toContain("/preview/darwin-arm64.preview-key.json");
    await f.service.close();
  });

  it("does not trust a packaged flag or start a download when native signed Stable admission refuses", async () => {
    const f = fixture();
    f.native.inspect.mockResolvedValueOnce({ kind: "refused", reason: "unsigned-build" });
    expect(await f.service.refresh()).toMatchObject({
      status: "unavailable",
      reason: "unsigned-build",
    });
    await f.service.install(f.owner);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.native.prepareInstall).not.toHaveBeenCalled();
    await f.service.close();
  });

  it("refuses a substituted artifact before native preparation", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async (url) =>
      String(url).includes(".json") ? Response.json(f.document) : new Response("substituted"),
    );
    await f.service.refresh();
    expect(await f.service.install(f.owner)).toMatchObject({
      status: "refused",
      reason: "corrupt-artifact",
    });
    expect(f.native.prepareInstall).not.toHaveBeenCalled();
    await f.service.close();
  });

  it("withdraws the requesting window after preparation and drains cancellation before settling", async () => {
    const f = fixture();
    const prepared = Promise.withResolvers<{ readonly kind: "prepared" }>();
    const cancelled = Promise.withResolvers<{ readonly kind: "cancelled" }>();
    f.native.prepareInstall.mockImplementation(() => prepared.promise);
    f.native.cancel.mockImplementation(() => cancelled.promise);
    await f.service.refresh();
    const pending = f.service.install(f.owner);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(f.native.prepareInstall).toHaveBeenCalledOnce());
    f.retire();
    prepared.resolve({ kind: "prepared" });
    await vi.waitFor(() => expect(f.native.cancel).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(f.native.commitInstall).not.toHaveBeenCalled();
    cancelled.resolve({ kind: "cancelled" });
    expect(await pending).toMatchObject({ status: "refused", reason: "owner-lost" });
    await f.service.close();
  });

  it("keeps one transaction and does not let another window cancel its owner", async () => {
    const f = fixture();
    const prepared = Promise.withResolvers<{ readonly kind: "prepared" }>();
    f.native.prepareInstall.mockImplementation(() => prepared.promise);
    await f.service.refresh();
    const first = f.service.install(f.owner);
    expect(f.service.install(f.owner)).toBe(first);
    await vi.waitFor(() => expect(f.native.prepareInstall).toHaveBeenCalledOnce());
    await f.service.cancel({ key: {}, current: () => true });
    expect(f.native.cancel).not.toHaveBeenCalled();
    prepared.resolve({ kind: "prepared" });
    await first;
    await f.service.close();
  });
});

describe("manual Nightly acquisition authority", () => {
  it.each(["signature", "ring", "platform"] as const)(
    "refuses a feed with the wrong %s before staging native bytes",
    async (fault) => {
      const f = fixture();
      await f.service.refresh();
      if (fault === "signature") f.document.signature = Buffer.alloc(64).toString("base64");
      else {
        f.document.release =
          fault === "ring"
            ? decodeAppUpdateRelease({
                ...release,
                ring: "candidate",
                version: "0.1.0-candidate.1",
              })
            : decodeAppUpdateRelease({ ...release, platform: "linux" });
        f.document.signature = sign(
          null,
          canonicalReleaseBytes(f.document.release),
          keys.privateKey,
        ).toString("base64");
      }
      const result = await f.service.install(f.owner);
      expect(result).toMatchObject({
        status: "refused",
        reason:
          fault === "signature"
            ? "untrusted-signature"
            : fault === "ring"
              ? "wrong-ring"
              : "wrong-platform",
      });
      expect(f.native.prepareInstall).not.toHaveBeenCalled();
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("revalidates installed identity on every Open and Remove rather than trusting the displayed snapshot", async () => {
    const f = fixture();
    f.setInstalled(true);
    await f.service.refresh();
    f.native.inspect.mockResolvedValue({ kind: "refused", reason: "invalid-peer" });
    expect(await f.service.open(f.owner)).toMatchObject({
      status: "refused",
      reason: "invalid-peer",
    });
    expect(await f.service.remove(f.owner)).toMatchObject({
      status: "refused",
      reason: "invalid-peer",
    });
    expect(f.native.open).not.toHaveBeenCalled();
    expect(f.native.remove).not.toHaveBeenCalled();
  });
  it("reports an unconfirmed native cancellation and refuses a new operation until cleanup is confirmed", async () => {
    const f = fixture();
    await f.service.refresh();
    f.native.prepareInstall.mockResolvedValue({ kind: "refused", reason: "invalid-artifact" });
    f.native.cancel.mockResolvedValueOnce({ kind: "failed", reason: "deadline-exceeded" });
    expect(await f.service.install(f.owner)).toMatchObject({
      status: "unavailable",
      reason: "deadline-exceeded",
    });
    await f.service.install(f.owner);
    expect(f.native.prepareInstall).toHaveBeenCalledTimes(1);
    await f.service.refresh();
    expect(f.service.snapshot()).toMatchObject({
      status: "ready",
      application: { kind: "absent" },
    });
    await f.service.install(f.owner);
    expect(f.native.prepareInstall).toHaveBeenCalledTimes(2);
  });
});
