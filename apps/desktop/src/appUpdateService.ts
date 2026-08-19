import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppUpdateRelease, AppUpdateState, AppVersion } from "@octant/contracts/app-updates";
import {
  resolveUpdateInstallReadiness,
  resolveUpdateOffer,
  type UpdateWorkInFlight,
} from "@octant/domain";
import { createFeedVerifier, fetchUpdateFeed, type FeedVerifier } from "./appUpdateFeed";

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
  readonly feedUrl: string;
  readonly app: { readonly version: AppVersion; readonly platform: string; readonly arch: string };
  readonly automaticChecks: boolean;
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
  let state: AppUpdateState = {
    status: "idle",
    currentVersion: options.app.version,
    automaticChecks,
  };
  let staged: { readonly url: string; readonly close: () => void } | undefined;
  let cancelScheduled: (() => void) | undefined;

  const publish = (next: Partial<AppUpdateState>): AppUpdateState => {
    state = { ...state, ...next, currentVersion: options.app.version, automaticChecks };
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
    state = { ...rest, ...next, currentVersion: options.app.version, automaticChecks };
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
      const fetched = await fetchUpdateFeed(options.feedUrl, options.fetchImpl, signal);
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
        app: options.app,
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
    async download(): Promise<AppUpdateState> {
      const release = state.available;
      if (state.status !== "available" || release === undefined) return state;
      releaseLoopback();
      try {
        staged = await serveVerifiedRelease(release);
      } catch {
        return publish({ status: "failed", message: "The update could not be prepared." });
      }
      options.updater.setFeedURL({ url: staged.url, serverType: "json" });
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
    default:
      return "The update service could not be reached.";
  }
}

/**
 * Hand one verified release to the platform updater over loopback.
 *
 * The server answers exactly one thing: the URL this service already verified,
 * in the shape the platform updater expects. It binds to 127.0.0.1, lives only
 * as long as the download, and has no route that could return anything else —
 * so the platform updater has no way to reach a release we did not check.
 */
async function serveVerifiedRelease(
  release: AppUpdateRelease,
): Promise<{ readonly url: string; readonly close: () => void }> {
  const body = JSON.stringify({ url: release.url });
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
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
  return {
    url: `http://127.0.0.1:${address.port}/update`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
