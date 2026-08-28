import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { AppUpdateRelease, AppVersion } from "@octant/contracts/app-updates";
import {
  OCTANT_UPDATE_CHECK_DISCLOSURE,
  OCTANT_UPDATE_CHECK_INFERENCE,
} from "@octant/contracts/app-updates";
import { canonicalReleaseBytes } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import {
  createFeedVerifier,
  DEFAULT_OCTANT_UPDATE_FEED_BASE_URL,
  OCTANT_UPDATE_PUBLIC_KEY,
  fetchUpdateFeed,
  fetchVerifiedArtifact,
  resolveUpdateFeedBaseUrl,
  UPDATE_CHECK_USER_AGENT,
  UPDATE_FEED_BASE_URL_ENVIRONMENT_VARIABLE,
  updateFeedUrl,
} from "./appUpdateFeed";
import { createAppUpdateService, type AppUpdaterPort } from "./appUpdateService";

const keys = generateKeyPairSync("ed25519");
const publicKeyBase64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

const artifactBytes = Buffer.from("octant-0.3.0-arm64-release");
const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex");

/** A response body from bytes, in the shape `Response` accepts. */
function served(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const release = {
  version: "0.3.0",
  platform: "darwin",
  arch: "arm64",
  ring: "stable",
  url: "https://updates.example.test/Octant-0.3.0-arm64.zip",
  sha256: artifactDigest,
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

const FEED_BASE_URL = "https://updates.example.test";
const FEED_URL = `${FEED_BASE_URL}/stable/darwin-arm64.json`;

function service(
  options: {
    readonly document?: unknown;
    readonly fetchFails?: boolean;
    readonly publicKey?: string;
    readonly currentVersion?: string;
    readonly feedBaseUrl?: string;
    readonly ring?: "stable" | "preview";
    /** What the artifact host actually serves, when it disagrees with the signed hash. */
    readonly serves?: Buffer;
    readonly artifactUnreachable?: boolean;
  } = {},
) {
  const port = updater();
  const feedBaseUrl = options.feedBaseUrl ?? FEED_BASE_URL;
  const feedUrl = updateFeedUrl(feedBaseUrl, {
    ring: options.ring ?? "stable",
    platform: "darwin",
    arch: "arm64",
  });
  const fetchImpl = vi.fn(async (input: string) => {
    if (options.fetchFails === true) throw new Error("offline");
    if (input.startsWith(feedUrl)) {
      return new Response(JSON.stringify(options.document ?? signedFeed()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (options.artifactUnreachable === true) return new Response("", { status: 404 });
    return new Response(served(options.serves ?? artifactBytes), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const updates = createAppUpdateService({
    updater: port,
    feedBaseUrl,
    app: {
      version: (options.currentVersion ?? "0.2.0") as AppVersion,
      platform: "darwin",
      arch: "arm64",
    },
    ...(options.ring === undefined ? {} : { ring: options.ring }),
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

  it("holds a feed served from somewhere else to exactly the same bar", async () => {
    // Somebody self-hosting, or a team pointing Octant at their own endpoint,
    // changes where the answer comes from and nothing about what it must prove.
    const other = generateKeyPairSync("ed25519");
    const payload = release;
    const { updates } = service({
      feedBaseUrl: "https://updates.acme-internal.test",
      document: {
        schemaVersion: 1,
        release: payload,
        signature: sign(null, canonicalReleaseBytes(payload), other.privateKey).toString("base64"),
      },
    });

    expect(await updates.check()).toMatchObject({
      status: "refused",
      refusal: "untrusted-signature",
    });
  });
});

describe("release rings", () => {
  it("follows the ring a build's own version says it was made on", async () => {
    // Nothing configured it: the version carries the ring, so a preview build
    // reads the preview feed on its first check.
    const { fetchImpl, updates } = service({ currentVersion: "0.2.0-preview.20260828.4" });
    await updates.check();
    const [requested] = vi.mocked(fetchImpl).mock.calls[0] as [string];

    expect(updates.state().ring).toBe("preview");
    expect(requested).toContain("/preview/darwin-arm64.json");
  });

  it("refuses a stable feed's release while following preview", async () => {
    // The stable document is genuinely signed; it is simply not this ring's.
    const { updates } = service({ ring: "preview" });

    expect(await updates.check()).toMatchObject({ status: "refused", refusal: "wrong-ring" });
  });

  it("drops a verified offer when the ring changes", async () => {
    // The offer was verified against the ring being followed then. Carrying it
    // across would let a preview release install after somebody chose stable.
    const { updates } = service();
    expect(await updates.check()).toMatchObject({ status: "available" });

    const switched = updates.setRing("preview");

    expect(switched.ring).toBe("preview");
    expect(switched.status).toBe("idle");
    expect(switched.available).toBeUndefined();
  });
});

describe("where the feed is", () => {
  it("uses the published endpoint when nothing is configured", () => {
    expect(resolveUpdateFeedBaseUrl({})).toBe(DEFAULT_OCTANT_UPDATE_FEED_BASE_URL);
    expect(DEFAULT_OCTANT_UPDATE_FEED_BASE_URL.startsWith("https://")).toBe(true);
  });

  it("lets a team point Octant at their own endpoint", () => {
    // The endpoint is configuration: the signature is what is trusted, so
    // moving the feed is a deployment choice rather than a security one.
    expect(
      resolveUpdateFeedBaseUrl({
        [UPDATE_FEED_BASE_URL_ENVIRONMENT_VARIABLE]: "https://updates.acme-internal.test/octant",
      }),
    ).toBe("https://updates.acme-internal.test/octant");
  });

  it("addresses a feed by ring and machine, so a ring is a directory rather than a rewrite", () => {
    // The shape the publisher writes and the app reads. Adding a platform is a
    // new file at a known path, not a change to how anything is addressed.
    expect(
      updateFeedUrl("https://octant.sh/updates", {
        ring: "preview",
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe("https://octant.sh/updates/preview/darwin-arm64.json");
    expect(
      updateFeedUrl("https://octant.sh/updates/", {
        ring: "stable",
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe("https://octant.sh/updates/stable/darwin-arm64.json");
  });

  it("refuses a configured endpoint it cannot reach securely rather than falling back", () => {
    // Silently using the public feed would update somebody from a place they
    // did not choose, which is worse than not updating.
    expect(() =>
      resolveUpdateFeedBaseUrl({
        [UPDATE_FEED_BASE_URL_ENVIRONMENT_VARIABLE]: "http://updates.test",
      }),
    ).toThrow(/https/);
  });
});

describe("artifact integrity", () => {
  it("accepts bytes that hash to the signed release", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(served(artifactBytes), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const outcome = await fetchVerifiedArtifact(
      { url: release.url, sha256: artifactDigest, maxBytes: 1024 },
      fetchImpl,
    );

    expect(outcome.kind).toBe("verified");
  });

  it("rejects bytes the artifact host substituted", async () => {
    // The host serving the download is not trusted, wherever it is: the signed
    // hash is what decides whether these are the bytes that were published.
    const fetchImpl = vi.fn(
      async () => new Response(served(Buffer.from("something else entirely")), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    expect(
      await fetchVerifiedArtifact(
        { url: release.url, sha256: artifactDigest, maxBytes: 1024 },
        fetchImpl,
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("refuses to read a body far larger than a release", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(served(Buffer.alloc(4096)), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    expect(
      await fetchVerifiedArtifact(
        { url: release.url, sha256: artifactDigest, maxBytes: 64 },
        fetchImpl,
      ),
    ).toEqual({ kind: "corrupt" });
  });
});

describe("download hand-off", () => {
  it("never lets the platform updater see a URL that was not verified", async () => {
    // The platform updater is handed a loopback feed of ours naming bytes we
    // already downloaded and hashed, not the public one: pointing it at the
    // public feed would have it download before we had checked anything.
    const { port, updates } = service();
    await updates.check();

    await updates.download();

    expect(port.calls.setFeedURL).toHaveLength(1);
    const handedOver = port.calls.setFeedURL[0] ?? "";
    expect(handedOver).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(port.calls.checkForUpdates).toBe(1);
    const answer = (await (await fetch(handedOver)).json()) as { url: string };
    expect(answer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/artifact\/0\.3\.0\.zip$/);
    expect(Buffer.from(await (await fetch(answer.url)).arrayBuffer())).toEqual(artifactBytes);
    updates.dispose();
  });

  it("refuses an artifact whose bytes are not the ones that were signed", async () => {
    // A genuine notice and a substituted delivery: the signature was fine and
    // the bytes were not, which is a different thing to tell somebody.
    const { port, updates } = service({ serves: Buffer.from("not the release") });
    await updates.check();

    const state = await updates.download();

    expect(state).toMatchObject({ status: "refused", refusal: "corrupt-artifact" });
    expect(port.calls.setFeedURL).toHaveLength(0);
    expect(port.calls.checkForUpdates).toBe(0);
  });

  it("says the artifact could not be fetched rather than staging nothing quietly", async () => {
    const { port, updates } = service({ artifactUnreachable: true });
    await updates.check();

    expect(await updates.download()).toMatchObject({ status: "refused", refusal: "unreachable" });
    expect(port.calls.setFeedURL).toHaveLength(0);
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
      feedBaseUrl: FEED_BASE_URL,
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
    const { fetchImpl, port, updates } = service({ publicKey: "" });
    await updates.check();

    await updates.download();

    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("refuses update checks on Linux until a signed channel exists", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const updates = createAppUpdateService({
      updater: updater(),
      feedBaseUrl: FEED_BASE_URL,
      app: { version: "0.2.0" as AppVersion, platform: "linux", arch: "x64" },
      automaticChecks: false,
      fetchImpl,
    });
    const state = await updates.check();
    expect(state).toMatchObject({
      status: "refused",
      refusal: "untrusted-signature",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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
      feedBaseUrl: FEED_BASE_URL,
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
  const identity = { version: "0.2.0", platform: "darwin", arch: "arm64" };

  it("sends the version and the machine it needs a build for, and nothing else", async () => {
    // Three parameters select a release. Anything beyond them would be
    // something this path had no reason to carry.
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    await fetchUpdateFeed(FEED_URL, identity, fetchImpl);

    const [sent, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    const parameters = new URL(sent).searchParams;
    expect([...parameters.keys()].sort()).toEqual(["arch", "platform", "version"]);
    expect(parameters.get("version")).toBe("0.2.0");
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(UPDATE_CHECK_USER_AGENT);
    // Not the default agent string, which would add the Electron and OS build.
    expect(headers["user-agent"]).not.toMatch(/\d/);
    expect(init.credentials).toBe("omit");
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
  });

  it("compiles a usable release public key", () => {
    expect(OCTANT_UPDATE_PUBLIC_KEY).not.toBe("");
    expect(createFeedVerifier().configured).toBe(true);
    expect(createFeedVerifier("").configured).toBe(false);
  });

  it("refuses to fetch a feed over plain HTTP", async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;

    expect(
      await fetchUpdateFeed("http://updates.example.test/feed.json", identity, fetchImpl),
    ).toEqual({ kind: "unreachable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the documented disclosure to what the request actually sends", () => {
    // If the request ever carries more than this, the list is wrong.
    expect(OCTANT_UPDATE_CHECK_DISCLOSURE).toHaveLength(5);
    expect(OCTANT_UPDATE_CHECK_DISCLOSURE.join(" ")).not.toMatch(
      /account|identifier|thread|Project|usage/i,
    );
  });

  it("says what a server can work out, not only what is sent", () => {
    // "We send almost nothing" is easy to say; the inference is the part
    // somebody assessing this actually needs.
    expect(OCTANT_UPDATE_CHECK_INFERENCE.join(" ")).toMatch(/IP address/);
    expect(OCTANT_UPDATE_CHECK_INFERENCE.join(" ")).toMatch(/no cookie/i);
  });
});
