import { DESKTOP_FLAVOR_IDENTITIES } from "@octant/host-runtime";
import { canonicalReleaseBytes, ringForVersion } from "@octant/domain";
import {
  decodeAppUpdateFeed,
  decodeAppVersion,
  type AppUpdateRelease,
} from "@octant/contracts/app-updates";
import type {
  NightlyInstallationApplication,
  NightlyInstallationOperation,
  NightlyInstallationPhase,
  NightlyInstallationReason,
  NightlyInstallationState,
} from "@octant/contracts/nightly-installation";
import {
  createFeedVerifier,
  fetchUpdateFeed,
  fetchVerifiedArtifact,
  updateFeedUrl,
  type FeedVerifier,
} from "./appUpdateFeed";
import type {
  NativeNightlyInstallation,
  NightlyInstallationInspection,
  FailedNightlyInstallationClose,
} from "./nightlyInstallationNative";

const PRODUCT = DESKTOP_FLAVOR_IDENTITIES.nightly.productName;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_BOUND_MS = 120_000;
const CLOSE_BOUND_MS = 3_000;

type Owner = {
  readonly key: object;
  readonly current: () => boolean;
  readonly signal?: AbortSignal;
};
type CloseResult = { readonly kind: "closed" } | FailedNightlyInstallationClose;
type Cancellation = Awaited<ReturnType<NativeNightlyInstallation["cancel"]>>;
type Operation = {
  readonly owner: Owner;
  readonly action: NightlyInstallationOperation;
  readonly abort: AbortController;
  readonly promise: Promise<NightlyInstallationState>;
  cancel: Promise<Cancellation> | undefined;
  reason: NightlyInstallationReason;
  touchedNative: boolean;
};

const messages: Readonly<Record<NightlyInstallationReason, string>> = {
  "unsupported-platform": "Install controls are available in Octant on Apple Silicon macOS.",
  unpackaged: "Use the signed Octant application to install Nightly.",
  "unsigned-build": "This Octant application could not prove its signed identity.",
  "invalid-peer": "The application identity could not be verified. Nothing was replaced.",
  "native-unavailable":
    "Octant could not confirm the installation operation. Check again before retrying.",
  "invalid-artifact": "The downloaded application is not a verified Nightly build.",
  "incompatible-build": "This Nightly build is incompatible with this installation.",
  "not-installed": "Nightly is not installed beside this Octant application.",
  "already-installed": "An application already occupies Nightly's location. It was not replaced.",
  running: "Quit Octant Nightly before moving it to the Trash.",
  "ambiguous-application": "Another Nightly application is running. Quit it before continuing.",
  "unwritable-location":
    "Octant cannot write beside this application. Move Octant to a writable Applications folder first.",
  busy: "Wait for the current Nightly operation to finish.",
  cancelled: "The Nightly operation was stopped. Its current installation is shown below.",
  "deadline-exceeded": "The Nightly operation took too long. Check its status before retrying.",
  closed: "Octant is closing and cannot start another installation operation.",
  unreachable: "The Nightly download could not be reached. You can try again.",
  malformed: "The Nightly release information could not be read.",
  "untrusted-signature": "The Nightly release signature could not be verified.",
  "wrong-ring": "The release did not name a preview Nightly build.",
  "wrong-platform": "The Nightly release is not for Apple Silicon macOS.",
  "corrupt-artifact": "The download did not match the signed release and was not installed.",
  "owner-lost":
    "The requesting window closed. The operation stopped and its current installation is shown below.",
};

function application(
  value: NightlyInstallationInspection,
): NightlyInstallationApplication | undefined {
  if (value.kind === "absent") return { kind: "absent" };
  if (value.kind !== "installed") return undefined;
  try {
    return { kind: "installed", version: decodeAppVersion(value.version), running: value.running };
  } catch {
    return undefined;
  }
}
function owns(owner: Owner): boolean {
  try {
    return !owner.signal?.aborted && owner.current();
  } catch {
    return false;
  }
}
async function boundedDrain(work: Promise<CloseResult>): Promise<CloseResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<CloseResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "failed", reason: "deadline-exceeded" }),
          CLOSE_BOUND_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns one manual installation transaction; native owns fixed paths and signed identity. */
export function createNightlyInstallation(options: {
  readonly native: NativeNightlyInstallation;
  readonly app: {
    readonly packaged: boolean;
    readonly platform: string;
    readonly arch: string;
    readonly version: string;
  };
  readonly feedBaseUrl: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly verifier?: FeedVerifier;
}) {
  const native = options.native;
  const verifier = options.verifier ?? createFeedVerifier();
  let state: NightlyInstallationState = { status: "loading", productName: PRODUCT };
  let known: NightlyInstallationApplication | undefined;
  let active: Operation | undefined;
  let closing = false;
  let closingPromise: Promise<CloseResult> | undefined;
  let refreshPromise: Promise<NightlyInstallationState> | undefined;
  let cleanupUnconfirmed = false;
  const listeners = new Set<() => void>();
  const unavailable = (reason: NightlyInstallationReason): NightlyInstallationState => ({
    status: "unavailable",
    productName: PRODUCT,
    reason,
    message: messages[reason],
  });
  const snapshot = (ownerKey?: object): NightlyInstallationState =>
    state.status === "working"
      ? {
          ...state,
          cancellable:
            state.cancellable &&
            active !== undefined &&
            active.owner.key === ownerKey &&
            owns(active.owner),
        }
      : state;
  const publish = (next: NightlyInstallationState) => {
    if (!closing) {
      state = Object.freeze(next);
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          /* A failed observer cannot stop transaction ownership. */
        }
      }
    }
    return state;
  };
  const failure = (reason: NightlyInstallationReason): NightlyInstallationState =>
    known === undefined
      ? unavailable(reason)
      : {
          status: "refused",
          productName: PRODUCT,
          application: known,
          reason,
          message: messages[reason],
        };
  const current = (operation: Operation) =>
    !closing && active === operation && !operation.abort.signal.aborted && owns(operation.owner);
  const phase = (operation: Operation, value: NightlyInstallationPhase, cancellable: boolean) => {
    if (known !== undefined)
      publish({
        status: "working",
        productName: PRODUCT,
        application: known,
        operation: operation.action,
        phase: value,
        cancellable,
      });
  };
  const cancelOperation = (operation: Operation, reason: NightlyInstallationReason) => {
    operation.reason = reason;
    operation.abort.abort();
    if (active === operation && operation.cancel === undefined) {
      phase(operation, "cancelling", false);
      operation.cancel = native
        .cancel()
        .catch((): Cancellation => ({ kind: "failed", reason: "native-unavailable" }));
    }
    return operation.cancel;
  };
  const cancelled = async (operation: Operation): Promise<NightlyInstallationState> => {
    const receipt = await cancelOperation(
      operation,
      closing ? "closed" : owns(operation.owner) ? operation.reason : "owner-lost",
    );
    if (closing) return state;
    if (receipt?.kind !== "cancelled") {
      cleanupUnconfirmed = true;
      return unavailable(receipt?.reason ?? "native-unavailable");
    }
    const inspection = await native.inspect();
    if (closing) return state;
    const observed = application(inspection);
    if (observed === undefined)
      return unavailable(inspection.kind === "refused" ? inspection.reason : "incompatible-build");
    known = observed;
    return failure(operation.reason);
  };
  const refresh = (): Promise<NightlyInstallationState> => {
    if (closing) return Promise.resolve(state);
    if (active !== undefined) return active.promise;
    if (refreshPromise !== undefined) return refreshPromise;
    refreshPromise = (async () => {
      if (!options.app.packaged) return publish(unavailable("unpackaged"));
      if (options.app.platform !== "darwin" || options.app.arch !== "arm64")
        return publish(unavailable("unsupported-platform"));
      if (cleanupUnconfirmed) {
        const drained = await native.cancel();
        if (closing) return state;
        if (drained.kind !== "cancelled") return publish(unavailable(drained.reason));
        cleanupUnconfirmed = false;
      }
      const inspected = await native.inspect();
      if (closing) return state;
      const observed = application(inspected);
      if (observed === undefined)
        return publish(
          unavailable(inspected.kind === "refused" ? inspected.reason : "incompatible-build"),
        );
      known = observed;
      if (observed.kind === "absent" && !verifier.configured("preview"))
        return publish(unavailable("untrusted-signature"));
      return publish({ status: "ready", productName: PRODUCT, application: observed });
    })()
      .catch(() => (closing ? state : publish(unavailable("native-unavailable"))))
      .finally(() => {
        refreshPromise = undefined;
      });
    return refreshPromise;
  };
  const execute = async (operation: Operation): Promise<NightlyInstallationState> => {
    if (!current(operation)) return cancelled(operation);
    phase(operation, "checking", true);
    if (!current(operation)) return cancelled(operation);
    operation.touchedNative = true;
    const inspected = await native.inspect();
    if (!current(operation)) return cancelled(operation);
    const observed = application(inspected);
    if (observed === undefined)
      return failure(inspected.kind === "refused" ? inspected.reason : "incompatible-build");
    operation.touchedNative = false;
    known = observed;
    if (operation.action === "install") {
      if (observed.kind !== "absent") return failure("already-installed");
      if (!verifier.configured("preview")) return failure("untrusted-signature");
      const fetched = await fetchUpdateFeed(
        updateFeedUrl(options.feedBaseUrl, { ring: "preview", platform: "darwin", arch: "arm64" }),
        { version: options.app.version, platform: "darwin", arch: "arm64" },
        options.fetchImpl,
        operation.abort.signal,
      );
      if (!current(operation)) return cancelled(operation);
      if (fetched.kind !== "fetched") return failure(fetched.kind);
      let release: AppUpdateRelease;
      try {
        const feed = decodeAppUpdateFeed(fetched.document);
        if (!verifier.verify(canonicalReleaseBytes(feed.release), feed.signature, "preview"))
          return failure("untrusted-signature");
        release = feed.release;
      } catch {
        return failure("malformed");
      }
      if (release.ring !== "preview" || ringForVersion(release.version) !== "preview")
        return failure("wrong-ring");
      if (release.platform !== "darwin" || release.arch !== "arm64")
        return failure("wrong-platform");
      phase(operation, "downloading", true);
      if (!current(operation)) return cancelled(operation);
      const artifact = await fetchVerifiedArtifact(
        { url: release.url, sha256: release.sha256, maxBytes: MAX_ARCHIVE_BYTES },
        options.fetchImpl,
        operation.abort.signal,
      );
      if (!current(operation)) return cancelled(operation);
      if (artifact.kind !== "verified")
        return failure(artifact.kind === "corrupt" ? "corrupt-artifact" : "unreachable");
      phase(operation, "verifying", true);
      if (!current(operation)) return cancelled(operation);
      operation.touchedNative = true;
      const prepared = await native.prepareInstall(artifact.bytes, String(release.version));
      if (!current(operation)) return cancelled(operation);
      if (prepared.kind !== "prepared") return failure(prepared.reason);
      phase(operation, "installing", false);
      if (!current(operation)) return cancelled(operation);
      const committed = await native.commitInstall();
      if (closing) return state;
      if (committed.kind !== "installed") return failure(committed.reason);
      const installed = application(committed);
      if (
        installed === undefined ||
        String(installed.kind === "installed" ? installed.version : "") !== String(release.version)
      )
        return failure("incompatible-build");
      known = installed;
      operation.touchedNative = false;
    } else {
      if (observed.kind !== "installed") return failure("not-installed");
      if (operation.action === "remove" && observed.running) return failure("running");
      phase(operation, operation.action === "open" ? "opening" : "removing", false);
      if (!current(operation)) return cancelled(operation);
      operation.touchedNative = true;
      const outcome = operation.action === "open" ? await native.open() : await native.remove();
      if (closing) return state;
      if (outcome.kind === "refused") return failure(outcome.reason);
      operation.touchedNative = false;
      // An OS completion is not a cached authority for the next click.
      const result = await native.inspect();
      if (closing) return state;
      const after = application(result);
      if (after === undefined)
        return failure(result.kind === "refused" ? result.reason : "incompatible-build");
      known = after;
    }
    return { status: "ready", productName: PRODUCT, application: known };
  };
  const start = (
    action: NightlyInstallationOperation,
    owner: Owner,
  ): Promise<NightlyInstallationState> => {
    if (
      closing ||
      !owns(owner) ||
      cleanupUnconfirmed ||
      known === undefined ||
      refreshPromise !== undefined
    )
      return Promise.resolve(snapshot(owner.key));
    if (active !== undefined)
      return active.owner.key === owner.key && active.action === action
        ? active.promise
        : Promise.resolve(snapshot(owner.key));
    const done = Promise.withResolvers<NightlyInstallationState>();
    const operation: Operation = {
      action,
      owner,
      abort: new AbortController(),
      promise: done.promise,
      cancel: undefined,
      reason: "cancelled",
      touchedNative: false,
    };
    active = operation;
    const abort = () => {
      void cancelOperation(operation, "owner-lost");
    };
    owner.signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => {
      void cancelOperation(operation, "deadline-exceeded");
    }, DOWNLOAD_BOUND_MS);
    void (async () => {
      let result: NightlyInstallationState;
      try {
        result = await execute(operation);
      } catch {
        result = current(operation) ? failure("native-unavailable") : await cancelled(operation);
      } finally {
        clearTimeout(deadline);
        owner.signal?.removeEventListener("abort", abort);
      }
      if (operation.touchedNative && operation.cancel === undefined)
        operation.cancel = native
          .cancel()
          .catch((): Cancellation => ({ kind: "failed", reason: "native-unavailable" }));
      if (operation.cancel !== undefined) {
        const drained = await operation.cancel;
        if (drained.kind !== "cancelled") {
          cleanupUnconfirmed = true;
          result = unavailable(drained.reason);
        }
      }
      if (active === operation) active = undefined;
      done.resolve(closing ? state : publish(result));
    })().catch(() => {
      cleanupUnconfirmed = true;
      if (active === operation) active = undefined;
      done.resolve(closing ? state : publish(unavailable("native-unavailable")));
    });
    return done.promise;
  };
  return {
    snapshot,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    install: (owner: Owner) => start("install", owner),
    open: (owner: Owner) => start("open", owner),
    remove: (owner: Owner) => start("remove", owner),
    cancel(owner: Owner): Promise<NightlyInstallationState> {
      if (active === undefined || active.owner.key !== owner.key || !owns(owner))
        return Promise.resolve(snapshot(owner.key));
      void cancelOperation(active, "cancelled");
      return active.promise;
    },
    close(): Promise<CloseResult> {
      if (closingPromise !== undefined) return closingPromise;
      closing = true;
      state = unavailable("closed");
      const operation = active;
      operation?.abort.abort();
      const nativeClose = native
        .close()
        .catch((): CloseResult => ({ kind: "failed", reason: "native-unavailable" }));
      const owned = Promise.allSettled([
        operation?.promise,
        refreshPromise,
        nativeClose,
      ] as const).then((results): CloseResult => {
        const receipt = results[2];
        if (receipt?.status === "fulfilled") return receipt.value;
        return { kind: "failed", reason: "native-unavailable" };
      });
      closingPromise = boundedDrain(owned);
      return closingPromise;
    },
  };
}
