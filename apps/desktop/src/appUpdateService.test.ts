import { generateKeyPairSync, sign } from "node:crypto";
import type { AppUpdateRelease, AppVersion } from "@octant/contracts/app-updates";
import { OCTANT_UPDATE_CHECK_DISCLOSURE } from "@octant/contracts/app-updates";
import { canonicalReleaseBytes } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { createFeedVerifier, fetchUpdateFeed, UPDATE_CHECK_USER_AGENT } from "./appUpdateFeed";
import { createAppUpdateService, type AppUpdaterPort } from "./appUpdateService";

const keys = generateKeyPairSync("ed25519");
const publicKeyBase64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

const release = {
  version: "0.3.0",
  platform: "darwin",
  arch: "arm64",
  url: "https://updates.example.test/Octant-0.3.0-arm64.zip",
  sha256: "a".repeat(64),
  releasedAt: "2026-08-19T09:00:00.000Z",
} as unknown as AppUpdateRelease;

function signedFeed(over: Partial<Record<string, unknown>> = {}): unknown {
  const payload = { ...release, ...over } as AppUpdateRelease;
  return {
    schemaVersion: 1,
    release: payload,
    signature: sign(null, canonicalReleaseBytes(payload), keys.privateKey).toString("base64"),
  };
}

function updater(): AppUpdaterPort & {
  readonly emit: (event: string) => void;
  readonly calls: { setFeedURL: string[]; checkForUpdates: number; quitAndInstall: number };
} {
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  const calls = { setFeedURL: [] as string[], checkForUpdates: 0, quitAndInstall: 0 };
  return {
    calls,
    emit: (event) => listeners.get(event)?.(),
    on: (event, listener) => void listeners.set(event, listener),
    setFeedURL: (options) => void calls.setFeedURL.push(options.url),
    checkForUpdates: () => void (calls.checkForUpdates += 1),
    quitAndInstall: () => void (calls.quitAndInstall += 1),
  };
}

function service(
  options: {
    readonly document?: unknown;
    readonly fetchFails?: boolean;
    readonly publicKey?: string;
    readonly currentVersion?: string;
  } = {},
) {
  const port = updater();
  const fetchImpl = vi.fn(async () => {
    if (options.fetchFails === true) throw new Error("offline");
    return new Response(JSON.stringify(options.document ?? signedFeed()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  const updates = createAppUpdateService({
    updater: port,
    feedUrl: "https://updates.example.test/feed.json",
    app: {
      version: (options.currentVersion ?? "0.2.0") as AppVersion,
      platform: "darwin",
      arch: "arm64",
    },
    automaticChecks: true,
    verifier: createFeedVerifier(options.publicKey ?? publicKeyBase64),
    fetchImpl,
    clock: () => "2026-08-19T10:00:00.000Z",
  });
  return { fetchImpl, port, updates };
}

describe("update verification", () => {
  it("offers a release its own key signed", async () => {
    const { updates } = service();

    const state = await updates.check();

    expect(state.status).toBe("available");
    expect(String(state.available?.version)).toBe("0.3.0");
  });

  it("refuses a release signed by a key that is not ours", async () => {
    const other = generateKeyPairSync("ed25519");
    const payload = release;
    const { updates } = service({
      document: {
        schemaVersion: 1,
        release: payload,
        signature: sign(null, canonicalReleaseBytes(payload), other.privateKey).toString("base64"),
      },
    });

    const state = await updates.check();

    expect(state).toMatchObject({ status: "refused", refusal: "untrusted-signature" });
  });

  it("refuses a release whose payload was swapped after signing", async () => {
    // The signature covers where the bytes come from, so redirecting the
    // download invalidates it rather than riding along on it.
    const feed = signedFeed() as { release: AppUpdateRelease; signature: string };
    const { updates } = service({
      document: {
        ...feed,
        release: { ...feed.release, url: "https://attacker.invalid/Octant.zip" },
      },
    });

    const state = await updates.check();

    expect(state).toMatchObject({ status: "refused", refusal: "untrusted-signature" });
  });

  it("refuses everything when the build carries no signing key", async () => {
    // A build that cannot prove provenance offers nothing rather than trusting
    // whatever answers.
    const { updates } = service({ publicKey: "" });

    const state = await updates.check();

    expect(state).toMatchObject({ status: "refused", refusal: "untrusted-signature" });
    expect(state.message).toContain("no update signing key");
  });

  it("says the server is unreachable rather than calling it a bad signature", async () => {
    // A person deciding whether to worry needs the difference.
    const { updates } = service({ fetchFails: true });

    expect(await updates.check()).toMatchObject({ status: "refused", refusal: "unreachable" });
  });

  it("reports being up to date when the feed offers what is already running", async () => {
    const { updates } = service({ currentVersion: "0.3.0" });

    expect(await updates.check()).toMatchObject({ status: "up-to-date", refusal: "not-newer" });
  });
});

describe("download hand-off", () => {
  it("never lets the platform updater see a URL that was not verified", async () => {
    // The platform updater is handed a loopback feed of ours, not the public
    // one: pointing it at the public feed would have it download before we had
    // checked anything.
    const { port, updates } = service();
    await updates.check();

    await updates.download();

    expect(port.calls.setFeedURL).toHaveLength(1);
    expect(port.calls.setFeedURL[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(port.calls.checkForUpdates).toBe(1);
    const answer = await fetch(port.calls.setFeedURL[0]!);
    expect(await answer.json()).toEqual({ url: release.url });
    updates.dispose();
  });

  it("forgets a release once a later check withdraws the offer", async () => {
    // State should not remember an offer that has been withdrawn, so no later
    // reader can take a stale one for a current answer.
    const { port, updates } = service();
    await updates.check();
    expect(updates.state().available).toBeDefined();

    // Same service, now answering with a feed signed by somebody else.
    const other = generateKeyPairSync("ed25519");
    const stale = createAppUpdateService({
      updater: port,
      feedUrl: "https://updates.example.test/feed.json",
      app: { version: "0.2.0" as AppVersion, platform: "darwin", arch: "arm64" },
      automaticChecks: false,
      verifier: createFeedVerifier(publicKeyBase64),
      fetchImpl: (() => {
        let call = 0;
        return async () =>
          new Response(
            JSON.stringify(
              call++ === 0
                ? signedFeed()
                : {
                    schemaVersion: 1,
                    release,
                    signature: sign(
                      null,
                      canonicalReleaseBytes(release),
                      other.privateKey,
                    ).toString("base64"),
                  },
            ),
            { status: 200 },
          );
      })() as unknown as typeof globalThis.fetch,
      clock: () => "2026-08-19T10:00:00.000Z",
    });
    await stale.check();
    expect(stale.state().available).toBeDefined();

    await stale.check();

    expect(stale.state().status).toBe("refused");
    expect(stale.state().available).toBeUndefined();
  });

  it("downloads nothing when the check refused", async () => {
    const { port, updates } = service({ publicKey: "" });
    await updates.check();

    await updates.download();

    expect(port.calls.setFeedURL).toHaveLength(0);
    expect(port.calls.checkForUpdates).toBe(0);
  });

  it("stages a downloaded update instead of applying it", async () => {
    const { port, updates } = service();
    await updates.check();
    await updates.download();

    port.emit("update-downloaded");

    expect(updates.state().status).toBe("ready");
    expect(port.calls.quitAndInstall).toBe(0);
  });
});

describe("applying an update", () => {
  async function staged() {
    const { port, updates } = service();
    await updates.check();
    await updates.download();
    port.emit("update-downloaded");
    return { port, updates };
  }

  it("applies only when the person asks and nothing is running", async () => {
    const { port, updates } = await staged();

    expect(updates.install({ activeAgentCount: 0, attentionRequired: false })).toEqual({
      kind: "installing",
    });
    expect(port.calls.quitAndInstall).toBe(1);
  });

  it("refuses to replace the app under work in flight", async () => {
    const { port, updates } = await staged();

    expect(updates.install({ activeAgentCount: 1, attentionRequired: false })).toEqual({
      kind: "wait",
      activeAgentCount: 1,
      attentionRequired: false,
    });
    expect(port.calls.quitAndInstall).toBe(0);
  });

  it("refuses to apply an update that was never staged", async () => {
    const { port, updates } = service();
    await updates.check();

    expect(updates.install({ activeAgentCount: 0, attentionRequired: false })).toEqual({
      kind: "not-ready",
    });
    expect(port.calls.quitAndInstall).toBe(0);
  });
});

describe("automatic checking", () => {
  function scheduled(automaticChecks: boolean) {
    const port = updater();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(signedFeed()), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const timers: Array<() => void> = [];
    const updates = createAppUpdateService({
      updater: port,
      feedUrl: "https://updates.example.test/feed.json",
      app: { version: "0.2.0" as AppVersion, platform: "darwin", arch: "arm64" },
      automaticChecks,
      verifier: createFeedVerifier(publicKeyBase64),
      fetchImpl,
      clock: () => "2026-08-19T10:00:00.000Z",
      schedule: (_delayMs, callback) => {
        timers.push(callback);
        return () => void timers.splice(timers.indexOf(callback), 1);
      },
    });
    return { fetchImpl, timers, updates };
  }

  it("schedules nothing until the persisted preference says it may", () => {
    // The host starts with automatic checks off, so a person who turned them
    // off does not get one check per launch before the setting is read.
    const { timers } = scheduled(false);

    expect(timers).toHaveLength(0);
  });

  it("checks on a schedule once switched on", async () => {
    const { fetchImpl, timers, updates } = scheduled(false);
    updates.setAutomaticChecks(true);

    expect(timers).toHaveLength(1);
    timers[0]?.();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    updates.dispose();
  });

  it("makes no request at all once switched off", async () => {
    // Off is not a check whose answer is discarded: nothing leaves the machine.
    const { fetchImpl, timers, updates } = scheduled(false);
    updates.setAutomaticChecks(true);
    updates.setAutomaticChecks(false);

    expect(timers).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    updates.dispose();
  });
});

describe("what an update check discloses", () => {
  it("sends no version, no identifier, and no credentials", async () => {
    // The feed is static and the comparison happens here, so the request has
    // nothing it needs to carry. This is the claim the user guide makes.
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    await fetchUpdateFeed("https://updates.example.test/feed.json", fetchImpl);

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(UPDATE_CHECK_USER_AGENT);
    expect(headers["user-agent"]).not.toMatch(/\d/);
    expect(init.credentials).toBe("omit");
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
  });

  it("refuses to fetch a feed over plain HTTP", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;

    expect(await fetchUpdateFeed("http://updates.example.test/feed.json", fetchImpl)).toEqual({
      kind: "unreachable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the documented disclosure to what the request actually sends", () => {
    // If the request ever carries more than this, the list is wrong.
    expect(OCTANT_UPDATE_CHECK_DISCLOSURE).toHaveLength(3);
    expect(OCTANT_UPDATE_CHECK_DISCLOSURE.join(" ")).not.toMatch(
      /version number|identifier|device/i,
    );
  });
});
