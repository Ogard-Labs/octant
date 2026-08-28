import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AppReleaseRing,
  AppUpdateRelease,
  AppUpdateState,
  AppVersion,
} from "@octant/contracts/app-updates";
import {
  resolveUpdateInstallReadiness,
  resolveUpdateOffer,
  ringForVersion,
  type UpdateWorkInFlight,
} from "@octant/domain";
import {
  createFeedVerifier,
  fetchUpdateFeed,
  fetchVerifiedArtifact,
  type FeedVerifier,
  updateFeedUrl,
} from "./appUpdateFeed";

/**
 * Platforms that publish a signed desktop update feed today.
 *
 * Linux desktop builds (unpackaged or AppImage) must fail closed: an updater on
 * an unsigned artifact is an unauthenticated code-delivery channel. A signed
 * Linux feed matrix is a separate deliverable.
 */
export function supportsSignedDesktopUpdateChannel(platform: string): boolean {
  return platform === "darwin";
}

/**
 * The slice of Electron's `autoUpdater` this service drives.
 *
 * A port rather than the module itself, so the ordering below — verify, then
 * and only then let the platform updater see a URL — is testable without an
 * Electron runtime.
 */
export interface AppUpdaterPort {
  setFeedURL(options: { readonly url: string; readonly serverType?: "json" | "default" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(
    event: "update-downloaded" | "error" | "update-not-available",
    listener: (...args: readonly unknown[]) => void,
  ): void;
}

export interface AppUpdateServiceOptions {
  readonly updater: AppUpdaterPort;
  /**
   * The base every feed address is built from. Not a single URL: the ring can
   * change while the app runs, and each ring is its own feed.
   */
  readonly feedBaseUrl: string;
  /**
   * The largest release Octant will read into memory to verify. A release is a
   * known size; a body far past it is not one.
   */
  readonly maxArtifactBytes?: number;
  readonly app: { readonly version: AppVersion; readonly platform: string; readonly arch: string };
  readonly automaticChecks: boolean;
  /**
   * The ring to follow before the persisted preference arrives. Defaults to
   * the ring this build belongs to, which is read from its own version — a
   * preview build follows previews unless it is told otherwise.
   */
  readonly ring?: AppReleaseRing;
  readonly verifier?: FeedVerifier;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly clock?: () => string;
  /** Injected so the automatic schedule is testable without waiting on a clock. */
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
  readonly onState?: (state: AppUpdateState) => void;
}

/**
 * Check for, stage, and apply an update — in that order, and never past a gate
 * that refused.
 *
 * Two independent checks stand between the feed and a running binary. This
 * service owns the first: an Ed25519 signature over the release, and a version
 * that is strictly newer and built for this machine. The platform updater owns
 * the second, verifying the replacement's code signature against the running
 * app's designated requirement before it swaps anything.
 *
 * Neither substitutes for the other, so the platform updater is never given a
 * URL this service has not verified. That is why the verified URL is handed
 * over through a loopback feed of our own rather than by pointing the platform
 * updater at the public feed: if it fetched the feed itself it would download
 * before we had checked anything, which is the ordering the whole design exists
 * to prevent.
 */
export function createAppUpdateService(options: AppUpdateServiceOptions) {
  const verifier = options.verifier ?? createFeedVerifier();
  const clock = options.clock ?? (() => new Date().toISOString());
  const schedule =
    options.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      // Never hold the app open for a version check.
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  let automaticChecks = options.automaticChecks;
  let ring: AppReleaseRing = options.ring ?? ringForVersion(options.app.version);
  let state: AppUpdateState = {
    status: "idle",
    currentVersion: options.app.version,
    automaticChecks,
    ring,
  };
  let staged: { readonly feedUrl: string; readonly close: () => void } | undefined;
  let cancelScheduled: (() => void) | undefined;

  const publish = (next: Partial<AppUpdateState>): AppUpdateState => {
    state = { ...state, ...next, currentVersion: options.app.version, automaticChecks, ring };
    options.onState?.(state);
    return state;
  };

  /**
   * Publish a state that offers nothing, dropping any release a previous check
   * had verified.
   *
   * `download` already refuses unless the status says a release is on offer, so
   * this is not the thing standing between a refusal and a download. It is so
   * that no caller can later read a stale `available` and take it for a current
   * answer — the state should not remember an offer that has been withdrawn.
   */
  const publishWithoutOffer = (next: Partial<AppUpdateState>): AppUpdateState => {
    const { available: _withdrawn, ...rest } = state;
    state = { ...rest, ...next, currentVersion: options.app.version, automaticChecks, ring };
    options.onState?.(state);
    return state;
  };

  options.updater.on("update-downloaded", () => {
    // Staged, not applied. Relaunching is the person's to ask for.
    releaseLoopback();
    publish({ status: "ready" });
  });
  options.updater.on("error", () => {
    releaseLoopback();
    publish({ status: "failed", message: "The update could not be downloaded." });
  });

  function releaseLoopback(): void {
    staged?.close();
    staged = undefined;
  }

  function scheduleNextCheck(delayMs: number): void {
    cancelScheduled = schedule(delayMs, () => {
      cancelScheduled = undefined;
      if (!automaticChecks) return;
      void service.check().finally(() => {
        if (automaticChecks) scheduleNextCheck(AUTOMATIC_CHECK_INTERVAL_MS);
      });
    });
  }

  const service = Object.freeze({
    state: (): AppUpdateState => state,

    /**
     * Follow a different ring from now on.
     *
     * Any release this service had verified is dropped: it was verified
     * against the ring that was being followed then, and carrying it across
     * would let a preview offer install after someone chose stable. The next
     * check answers for the new ring from scratch.
     */
    setRing(next: AppReleaseRing): AppUpdateState {
      if (next === ring) return state;
      ring = next;
      releaseLoopback();
      return publishWithoutOffer({ status: "idle" });
    },

    setAutomaticChecks(enabled: boolean): AppUpdateState {
      // Off means no request is made at all, not a quiet check whose answer is
      // withheld: the point of the switch is what leaves the machine. So the
      // schedule is torn down rather than left running with its result
      // discarded.
      automaticChecks = enabled;
      cancelScheduled?.();
      cancelScheduled = undefined;
      // Turning it on is also what starts the schedule, so the host never
      // checks before the persisted preference has reached it.
      if (enabled) scheduleNextCheck(FIRST_AUTOMATIC_CHECK_DELAY_MS);
      return publish({});
    },

    async check(signal?: AbortSignal): Promise<AppUpdateState> {
      publish({ status: "checking" });
      if (!supportsSignedDesktopUpdateChannel(options.app.platform)) {
        return publishWithoutOffer({
          status: "refused",
          refusal: "untrusted-signature",
          checkedAt: clock() as AppUpdateState["checkedAt"],
          message:
            "This platform has no signed update channel yet, so Octant will not install an update.",
        });
      }
      if (!verifier.configured) {
        // No release key compiled in means nothing can be proven, so nothing is
        // offered. A build in this state is not a build that updates quietly.
        return publishWithoutOffer({
          status: "refused",
          refusal: "untrusted-signature",
          checkedAt: clock() as AppUpdateState["checkedAt"],
          message: "This build carries no update signing key, so it cannot verify an update.",
        });
      }
      const fetched = await fetchUpdateFeed(
        updateFeedUrl(options.feedBaseUrl, {
          ring,
          platform: options.app.platform,
          arch: options.app.arch,
        }),
        {
          version: String(options.app.version),
          platform: options.app.platform,
          arch: options.app.arch,
        },
        options.fetchImpl,
        signal,
      );
      if (fetched.kind !== "fetched") {
        return publishWithoutOffer({
          status: "refused",
          refusal: fetched.kind,
          checkedAt: clock() as AppUpdateState["checkedAt"],
          message:
            fetched.kind === "unreachable"
              ? "The update service could not be reached."
              : "The update service answered with something Octant could not read.",
        });
      }
      const offer = resolveUpdateOffer({
        document: fetched.document,
        app: { ...options.app, ring },
        verifySignature: verifier.verify,
      });
      if (offer.kind === "refuse") {
        return publishWithoutOffer({
          status: offer.refusal === "not-newer" ? "up-to-date" : "refused",
          refusal: offer.refusal,
          checkedAt: clock() as AppUpdateState["checkedAt"],
          ...(offer.refusal === "not-newer" ? {} : { message: refusalMessage(offer.refusal) }),
        });
      }
      return publish({
        status: "available",
        available: offer.release,
        checkedAt: clock() as AppUpdateState["checkedAt"],
      });
    },

    /**
     * Download the release this service already verified.
     *
     * Refuses unless the current state is one it produced from a verified feed,
     * so a caller cannot skip the check and ask for bytes directly.
     */
    async download(signal?: AbortSignal): Promise<AppUpdateState> {
      const release = state.available;
      if (state.status !== "available" || release === undefined) return state;
      releaseLoopback();
      publish({ status: "downloading" });
      // Downloaded and hashed here, before the platform updater is told
      // anything. The feed said where the bytes are and what they must hash to,
      // and both were inside the signature — checking it is what turns a signed
      // notice into a verified artifact. Whoever serves the download, on
      // whatever host, cannot substitute anything.
      const artifact = await fetchVerifiedArtifact(
        {
          url: release.url,
          sha256: release.sha256,
          maxBytes: options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES,
        },
        options.fetchImpl,
        signal,
      );
      if (artifact.kind !== "verified") {
        return publishWithoutOffer({
          status: "refused",
          refusal: artifact.kind === "corrupt" ? "corrupt-artifact" : "unreachable",
          message:
            artifact.kind === "corrupt"
              ? "The downloaded update did not match the signed release, so it was discarded."
              : "The update could not be downloaded.",
        });
      }
      try {
        staged = await serveVerifiedArtifact(release, artifact.bytes);
      } catch {
        return publish({ status: "failed", message: "The update could not be prepared." });
      }
      options.updater.setFeedURL({ url: staged.feedUrl, serverType: "json" });
      options.updater.checkForUpdates();
      return publish({ status: "downloading" });
    },

    /**
     * Apply a staged update, or say what is still running.
     *
     * Never a delay that expires: while a turn or agent run is live this
     * refuses, and the person finishes or checkpoints the work first.
     */
    install(work: UpdateWorkInFlight):
      | { readonly kind: "installing" }
      | {
          readonly kind: "wait";
          readonly activeAgentCount: number;
          readonly attentionRequired: boolean;
        }
      | { readonly kind: "not-ready" } {
      if (state.status !== "ready") return { kind: "not-ready" };
      const readiness = resolveUpdateInstallReadiness(work);
      if (readiness.kind === "wait") return readiness;
      options.updater.quitAndInstall();
      return { kind: "installing" };
    },

    dispose(): void {
      cancelScheduled?.();
      cancelScheduled = undefined;
      releaseLoopback();
    },
  });
  return service;
}

/**
 * How long after launch the first automatic check waits, and how often it
 * repeats.
 *
 * Once a day is enough to learn about a release, and infrequent enough that the
 * request says almost nothing about when the app is used. The delay keeps a
 * version check out of the way of starting up.
 */
const FIRST_AUTOMATIC_CHECK_DELAY_MS = 10 * 60 * 1000;
const AUTOMATIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function refusalMessage(refusal: string): string {
  switch (refusal) {
    case "untrusted-signature":
      return "The update was not signed by Octant, so it was refused.";
    case "malformed":
      return "The update service answered with something Octant could not read.";
    case "wrong-platform":
      return "That update is for a different kind of Mac.";
    case "wrong-ring":
      return "That update belongs to a different release ring, so it was refused.";
    default:
      return "The update service could not be reached.";
  }
}

/**
 * Serve one already-verified artifact to the platform updater over loopback.
 *
 * The bytes here have been downloaded and hashed against the signed release, so
 * this hands over the verified artifact itself rather than a URL to fetch
 * again. That closes the gap a second fetch would open — nothing can change
 * between the check and the install — and it means the platform updater never
 * makes a network request of its own, so wherever the artifact was hosted, it
 * is contacted exactly once.
 *
 * The server binds to 127.0.0.1, lives only as long as the install, and has two
 * routes: the feed the platform updater expects, and the bytes it names.
 */
async function serveVerifiedArtifact(
  release: AppUpdateRelease,
  bytes: Uint8Array,
): Promise<{ readonly feedUrl: string; readonly close: () => void }> {
  const artifactPath = `/artifact/${String(release.version)}.zip`;
  const body = Buffer.from(bytes);
  let feed = "";
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.url === artifactPath) {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(body.byteLength),
      });
      response.end(body);
      return;
    }
    if (request.url === "/feed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ url: feed }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    server.close();
    throw new Error("Octant could not prepare the update hand-off.");
  }
  feed = `http://127.0.0.1:${address.port}${artifactPath}`;
  return {
    feedUrl: `http://127.0.0.1:${address.port}/feed`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * How large a release Octant will read in to verify it. Generous for a packaged
 * Electron app and far below what would exhaust memory.
 */
const MAX_ARTIFACT_BYTES = 600 * 1024 * 1024;
