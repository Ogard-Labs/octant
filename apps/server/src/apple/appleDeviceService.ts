import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import {
  AppleBundleIdentifier,
  decodeAppleDeviceEvidence,
  decodeAppleDeviceId,
  decodeAppleDeviceLease,
  decodeAppleDeviceRecord,
  decodeAppleDeviceResponse,
  type AppleBuildOutcome,
  type AppleDeviceEvidence,
  type AppleDeviceId,
  type AppleDeviceRecord,
  type AppleDeviceRefusalReason,
  type AppleDeviceRequest,
  type AppleDeviceResponse,
  type AppleDeviceSigning,
  type AppleDeviceToolingOperation,
  type AppleDiagnostic,
  type AppleEvidenceReference,
  type AppleTeamId,
} from "@octant/contracts";
import {
  chooseAppleDevelopmentSigning,
  evaluateAppleDeviceRequest,
  type AppleDevelopmentSigningGap,
  type AppleDeviceExecutionScope,
  type AppleDeviceHost,
  type AppleDeviceThreadHoldings,
} from "@octant/domain";
import type { AppleDeviceLeases, EndedAppleDeviceLease } from "./appleDeviceLeases";
import {
  MAX_DEVICE_IDENTITIES,
  readStoredFile,
  type AppleDeviceIdentity,
} from "./appleRuntimeStore";
import {
  developmentEntitlements,
  parseSigningIdentities,
  readProvisioningProfiles,
  serializePropertyList,
  type HeldProvisioningProfile,
} from "./appleSigning";
import {
  confinedProjectPath,
  projectSelector,
  type AppleProcessResult,
} from "./appleToolchainService";
import {
  DEVICECTL_PROBES,
  devicectlOffers,
  parseDevicectlDeviceList,
  parseDevicectlInstalledBundle,
  parseDevicectlLockState,
  parseDevicectlOutcome,
  withoutDeviceIdentifiers,
  type DevicectlDevice,
} from "./devicectl";

const DEVICECTL_TIMEOUT_MS = 30_000;
/** The largest `--json-output` document the host reads back. */
const MAX_DEVICECTL_OUTPUT_BYTES = 4 * 1024 * 1024;
/**
 * How long a console session may run. It is the launch itself (`devicectl
 * device process launch --console` stays attached until the app exits), so it
 * is bounded like any other launch, at the longest the process port allows.
 */
const CONSOLE_SESSION_LIMIT_MS = 60 * 60_000;
/**
 * How long a console session must stay attached before its launch counts. A
 * launch `devicectl` cannot carry out (a locked phone, an app it cannot find)
 * ends the session while it is still connecting to the device.
 */
const LAUNCH_SETTLE_MS = 10_000;
/** The most of one app's console output the host keeps, its latest bytes. */
const MAX_CONSOLE_BYTES = 1024 * 1024;
/** The most signed products the host holds, oldest forgotten first. */
const MAX_HELD_PRODUCTS = 64;
const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_LENGTH = 2_048;
/**
 * Nested code an app may carry that its own signature does not cover. An
 * extension or a Watch app needs a provisioning profile of its own, which this
 * host does not choose yet, so an app that carries one is not signed.
 */
const SEPARATELY_PROVISIONED = ["PlugIns", "Extensions", "Watch", "AppClips"] as const;

type Launch = (
  input: {
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly additionalWriteRoots?: ReadonlyArray<string>;
    readonly additionalReadRoots?: ReadonlyArray<string>;
    readonly isolatedRoots?: ReadonlyArray<string>;
    readonly interruptFirst?: boolean;
    /** Each chunk of output as it arrives, for a launch that outlives its request. */
    readonly onOutput?: (chunk: Uint8Array) => void;
  },
  signal?: AbortSignal,
) => Promise<AppleProcessResult>;

export interface AppleDeviceServiceOptions {
  /** The host's confined Apple launch, the same one Simulator discovery uses. */
  readonly execute: Launch;
  /**
   * The host's confined launch with no network, for the signing step alone
   * (decision 2 of docs/design/apple-devices.md): `security` lists the
   * keychain's identities and `codesign` signs the host-chosen bundle. No
   * project script ever runs under it.
   */
  readonly executeSigning: Launch;
  /**
   * A host-private directory `devicectl` writes its JSON answers to. The
   * listing names every paired device's hardware identifiers, so only the
   * launch that writes one may reach the directory, and each answer is
   * removed once it has been read.
   */
  readonly outputDirectory: string;
  /** Where each device build gets a private derived-data directory of its own. */
  readonly artifactRoot: string;
  /**
   * A host-private directory for the entitlements each signature reads. No
   * build or `devicectl` launch reaches it.
   */
  readonly signingDirectory: string;
  /** Where Xcode installs the person's provisioning profiles. */
  readonly provisioningProfileDirectories: ReadonlyArray<string>;
  /** Other host-private directories every device launch is denied. */
  readonly isolatedRoots?: ReadonlyArray<string>;
  readonly identities: {
    readonly loadDeviceIdentities: () => Promise<ReadonlyArray<AppleDeviceIdentity>>;
    readonly persistDeviceIdentities: (
      identities: ReadonlyArray<AppleDeviceIdentity>,
    ) => Promise<void>;
  };
  readonly leases: AppleDeviceLeases;
  readonly realpath: (path: string) => Promise<string>;
  readonly writeArtifact?: (reference: string, bytes: Uint8Array) => Promise<void>;
  /** Journals what a device operation did, as the Simulator's evidence is. */
  readonly recordEvidence?: (evidence: AppleDeviceEvidence, startedAt: string) => void;
  readonly now: () => string;
  readonly newId: () => string;
  /** Override for tests; production uses `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Override for tests; production waits `LAUNCH_SETTLE_MS`. */
  readonly launchSettleMs?: number;
}

/**
 * The thread scope a device request acts in, as the route resolved it, with
 * the checkout a build reads its project from.
 */
export interface AppleDeviceExecutionContext extends AppleDeviceExecutionScope {
  readonly checkoutRoot: string;
}

/** What one look at the host's device layer found. */
interface DeviceLayer {
  readonly toolchainAvailable: boolean;
  readonly tooling: ReadonlyArray<AppleDeviceToolingOperation>;
  readonly devices: ReadonlyArray<AppleDeviceRecord>;
}

/** Whether one look at the device layer could list the paired devices. */
type Refreshed = "refreshed" | "unreadable";

/** A signed app a thread's build produced, redeemable only by that thread's install. */
interface HeldProduct {
  readonly reference: AppleEvidenceReference;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly path: string;
  readonly bundleIdentifier: AppleBundleIdentifier;
  readonly signing: AppleDeviceSigning;
}

interface ThreadBundle {
  readonly threadId: string;
  readonly checkoutId: string;
  readonly deviceId: AppleDeviceId;
  readonly bundleIdentifier: AppleBundleIdentifier;
}

/** The console session of one app Octant launched; ending it ends the app. */
interface ConsoleSession extends ThreadBundle {
  readonly controller: AbortController;
  finished: Promise<AppleProcessResult>;
  output: Uint8Array;
  ended: AppleBuildOutcome | undefined;
}

/** What one step of a device operation left: whether to go on, and why not. */
type Step =
  | { readonly kind: "done" }
  | { readonly kind: "stopped"; readonly outcome: AppleBuildOutcome; readonly note: string };

const done: Step = { kind: "done" };
const stopped = (outcome: AppleBuildOutcome, note: string): Step => ({
  kind: "stopped",
  outcome,
  note,
});

/** What a device operation records as it goes, for its evidence. */
interface Work {
  readonly request: AppleDeviceRequest;
  readonly context: AppleDeviceExecutionContext;
  readonly startedAt: string;
  readonly signal: AbortSignal | undefined;
  readonly log: string[];
  readonly notes: string[];
  readonly artifacts: Array<AppleDeviceEvidence["artifacts"][number]>;
  product?: HeldProduct;
  bundleIdentifier?: AppleBundleIdentifier;
}

const LEASE_ENDED_NOTE =
  "The thread's lease on the device ended before this step, so the device was not touched.";

const SIGNING_GAP_NOTES: Readonly<Record<AppleDevelopmentSigningGap, string>> = {
  "no-signing-identity":
    "The login keychain has no valid development signing identity. Add your Apple account in Xcode's Settings, then let Xcode create an Apple Development certificate.",
  "no-provisioning-profile":
    "No installed development provisioning profile for this team covers this app's bundle identifier. Open the project in Xcode once with this team selected so Xcode installs one; Octant does not create profiles.",
  "no-identity-for-profile":
    "The provisioning profiles for this app admit none of the signing identities in the login keychain. Fix signing for this team in Xcode; Octant does not create certificates or profiles.",
};

/**
 * The host side of physical Apple devices (docs/design/apple-devices.md):
 * discovery through the selected Xcode's `devicectl`, host-minted ids,
 * person-confirmed leases, and, inside a lease, the thread's own app built,
 * signed for development with the person's existing keychain identity,
 * installed, launched under a console session, read, and stopped. Every
 * request is decided by the pure device policy against what the host just
 * found and what this thread already holds; this service only gathers that
 * state and carries out what the policy allowed.
 */
export class AppleDeviceService {
  readonly #options: AppleDeviceServiceOptions;
  readonly #platform: NodeJS.Platform;
  /** Octant id by CoreDevice identifier, loaded once and kept in step with the store. */
  #identities: Map<string, AppleDeviceId> | undefined;
  #identitiesChanged = false;
  /** The last record each device was seen with, for a leased device that went away. */
  readonly #lastSeen = new Map<string, AppleDeviceRecord>();
  #tooling:
    | { readonly developerDirectory: string; readonly offered: ReadonlySet<string> }
    | undefined;
  #layer: DeviceLayer = { toolchainAvailable: false, tooling: [], devices: [] };
  #refreshing: Promise<Refreshed> | undefined;
  /**
   * What each thread built, installed, and launched, in host memory only: a
   * restart forgets them, and the thread builds and installs again, which is
   * the safe direction to forget in.
   */
  readonly #products: HeldProduct[] = [];
  readonly #installed: ThreadBundle[] = [];
  /** The latest console session per device and bundle, running or ended. */
  readonly #sessions = new Map<string, ConsoleSession>();
  readonly #stopListening: () => void;

  constructor(options: AppleDeviceServiceOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    // A lease that ends takes the thread's console sessions on that device
    // with it, so nothing more of the device is read for a thread that no
    // longer holds it.
    this.#stopListening = options.leases.onEnded((ended) => this.#leaseEnded(ended));
  }

  /** The device a confirmation names, as the host last saw it. */
  describe(deviceId: AppleDeviceId): AppleDeviceRecord | undefined {
    return this.#layer.devices.find((device) => String(device.deviceId) === String(deviceId));
  }

  async request(
    request: AppleDeviceRequest,
    context: AppleDeviceExecutionContext,
    signal?: AbortSignal,
  ): Promise<AppleDeviceResponse> {
    if (this.#platform !== "darwin") {
      // Nothing stands in for a Mac: no process starts, and the policy names why.
      const decision = evaluateAppleDeviceRequest(
        request,
        context,
        {
          macos: false,
          toolchain: { available: false },
          tooling: [],
          devices: [],
          leases: [],
          distributionEnabled: false,
        },
        { builtProducts: [], installed: [], launched: [] },
      );
      return refused(decision.kind === "denied" ? decision.reason : "toolchain-unavailable");
    }
    // Releasing needs no fresh look at the device: a person may let go of a
    // phone that is already unplugged.
    if (request.kind !== "release-device") {
      if ((await this.#refresh(signal)) === "unreadable") {
        return decodeAppleDeviceResponse({
          kind: "apple-device-failure",
          failure: { category: "unavailable", message: "Paired devices could not be listed." },
        });
      }
    }
    // From here to the lease change nothing awaits, so two confirmed requests
    // for one device cannot both see it free.
    const host: AppleDeviceHost = {
      macos: true,
      toolchain: { available: this.#layer.toolchainAvailable },
      tooling: this.#layer.tooling,
      devices: this.#layer.devices,
      leases: this.#options.leases.list(),
      // Decision 7 keeps distribution closed until its own release-boundary change.
      distributionEnabled: false,
    };
    const decision = evaluateAppleDeviceRequest(request, context, host, this.#holdingsFor(request));
    if (decision.kind === "denied") return refused(decision.reason);
    return await this.#carryOut(request, context, host, signal);
  }

  /** Ends every console session this host started; the apps end with them. */
  async close(): Promise<void> {
    this.#stopListening();
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) session.controller.abort();
    await Promise.all(sessions.map((session) => session.finished));
  }

  async #carryOut(
    request: AppleDeviceRequest,
    context: AppleDeviceExecutionContext,
    host: AppleDeviceHost,
    signal: AbortSignal | undefined,
  ): Promise<AppleDeviceResponse> {
    const threadId = String(request.threadId);
    switch (request.kind) {
      case "discover":
        return decodeAppleDeviceResponse({
          kind: "apple-device-discovery",
          discovery: {
            devices: host.devices,
            tooling: host.tooling,
            leases: host.devices.flatMap((device) => {
              const holder = this.#options.leases.holder(String(device.deviceId), threadId);
              return holder === undefined ? [] : [{ deviceId: device.deviceId, holder }];
            }),
            discoveredAt: this.#options.now(),
          },
        });
      case "status": {
        const device = host.devices.find(
          (candidate) => String(candidate.deviceId) === String(request.deviceId),
        );
        if (device === undefined) return refused("invalid-destination");
        const holder = this.#options.leases.holder(String(device.deviceId), threadId);
        return decodeAppleDeviceResponse({
          kind: "apple-device-status",
          device,
          ...(holder === undefined ? {} : { holder }),
        });
      }
      case "use-device": {
        const held = host.leases.find(
          (lease) =>
            String(lease.deviceId) === String(request.deviceId) &&
            String(lease.threadId) === threadId &&
            String(lease.checkoutId) === String(request.checkoutId),
        );
        if (held !== undefined) {
          return decodeAppleDeviceResponse({
            kind: "apple-device-leased",
            deviceId: held.deviceId,
            grantedAt: held.grantedAt,
          });
        }
        // The policy allowed a new lease only on a local person's confirmation.
        if (request.deviceId === undefined || context.approvedBy?.kind !== "local-user") {
          return refused("confirmation-required");
        }
        const lease = decodeAppleDeviceLease({
          deviceId: request.deviceId,
          threadId: request.threadId,
          checkoutId: request.checkoutId,
          grantedBy: context.approvedBy,
          grantedAt: this.#options.now(),
        });
        this.#options.leases.start(lease);
        return decodeAppleDeviceResponse({
          kind: "apple-device-leased",
          deviceId: lease.deviceId,
          grantedAt: lease.grantedAt,
        });
      }
      case "release-device": {
        const ended =
          request.deviceId === undefined
            ? undefined
            : this.#options.leases.release(String(request.deviceId), threadId);
        if (ended === undefined) return refused("lease-required");
        return decodeAppleDeviceResponse({
          kind: "apple-device-released",
          deviceId: ended.lease.deviceId,
        });
      }
      case "build":
      case "run":
      case "install":
      case "launch":
      case "terminate":
      case "logs":
        return await this.#perform({
          request,
          context,
          startedAt: this.#options.now(),
          signal,
          log: [],
          notes: [],
          artifacts: [],
        });
      default:
        // Screenshots and uninstall arrive in later slices; until then the
        // host does not offer what the policy would allow.
        return refused("operation-unavailable");
    }
  }

  /** Carries out one device operation the policy allowed and records its evidence. */
  async #perform(work: Work): Promise<AppleDeviceResponse> {
    const { request } = work;
    let step: Step;
    try {
      switch (request.kind) {
        case "build":
          step = await this.#build(work);
          break;
        case "run":
          step = await this.#build(work);
          if (step.kind === "done") step = await this.#install(work);
          if (step.kind === "done") step = await this.#launch(work);
          break;
        case "install":
          step = await this.#install(work);
          break;
        case "launch":
          step = await this.#launch(work);
          break;
        case "terminate":
          step = await this.#terminate(work);
          break;
        default:
          step = await this.#logs(work);
          break;
      }
    } catch (error) {
      // Whatever threw is the reason this operation has no other evidence.
      step = stopped(
        work.signal?.aborted === true ? "cancelled" : "interrupted",
        `${request.kind} did not finish: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (step.kind === "stopped") work.notes.push(step.note);
    return await this.#record(work, step.kind === "done" ? "succeeded" : step.outcome);
  }

  /**
   * Builds the thread's app for a device under the ordinary profile with
   * signing off, then signs the bundle the host chose in a step of its own
   * (decision 2). Signing is chosen before the build runs, so a person whose
   * keychain or profiles cannot sign the app learns the step to take in Xcode
   * without waiting for a build.
   */
  async #build(work: Work): Promise<Step> {
    const { request, context } = work;
    const teamId = request.teamId;
    const projectPathInCheckout = request.projectPath;
    if (teamId === undefined || projectPathInCheckout === undefined) {
      return stopped("failed", "A device build names its project and team.");
    }
    const projectPath = await confinedProjectPath(
      context.checkoutRoot,
      projectPathInCheckout,
      this.#options.realpath,
    );
    const derivedRoot = resolve(this.#options.artifactRoot, `device-derived-${request.actionId}`);
    await mkdir(derivedRoot, { recursive: true, mode: 0o700 });
    const xcodebuild = [
      "xcodebuild",
      projectSelector(projectPathInCheckout),
      projectPath,
      ...(request.scheme === undefined ? [] : ["-scheme", request.scheme]),
      "-configuration",
      request.configuration === "release" ? "Release" : "Debug",
      "-derivedDataPath",
      derivedRoot,
      "-destination",
      "generic/platform=iOS",
      // The build never signs and never asks Apple for provisioning: no
      // keychain grant is in reach of the project's Run Script phases, and
      // `-allowProvisioningUpdates` is never passed (decision 3).
      "CODE_SIGNING_ALLOWED=NO",
    ];
    const buildLaunch = {
      cwd: context.checkoutRoot,
      timeoutMs: request.timeoutMs,
      additionalWriteRoots: [derivedRoot],
    };
    const settings = await this.#launchApple(
      { ...buildLaunch, argv: [...xcodebuild, "-showBuildSettings", "-json"] },
      work.signal,
    );
    if (!succeeded(settings)) {
      work.log.push(text(settings.stderr));
      return stopped(outcomeFor(settings), "The project's build settings could not be read.");
    }
    const declared = deviceProduct(text(settings.stdout), derivedRoot);
    if (declared === undefined) {
      return stopped(
        "failed",
        "The scheme does not build an app inside this build's own directory, so it is not signed.",
      );
    }
    work.bundleIdentifier = declared.bundleIdentifier;
    const signing = await this.#chooseSigning(teamId, declared.bundleIdentifier, work);
    if (signing.kind === "stopped") return signing;
    const build = await this.#launchApple(
      { ...buildLaunch, argv: [...xcodebuild, "build"] },
      work.signal,
    );
    work.log.push(text(build.stdout), text(build.stderr));
    if (!succeeded(build)) return stopped(outcomeFor(build), "The build did not succeed.");
    const signed = await this.#sign(work, declared, derivedRoot, signing.profile, signing.signing);
    if (signed.kind === "stopped") return signed;
    const product: HeldProduct = {
      reference: `apple-device-product-${request.actionId}`,
      threadId: String(request.threadId),
      checkoutId: String(request.checkoutId),
      path: declared.path,
      bundleIdentifier: declared.bundleIdentifier,
      signing: signing.signing,
    };
    this.#products.push(product);
    if (this.#products.length > MAX_HELD_PRODUCTS) this.#products.shift();
    work.product = product;
    work.notes.push(
      `Signed ${declared.bundleIdentifier} for development with identity ${signing.signing.identity} of team ${teamId}.`,
    );
    return done;
  }

  async #chooseSigning(
    teamId: AppleTeamId,
    bundleIdentifier: AppleBundleIdentifier,
    work: Work,
  ): Promise<
    | {
        readonly kind: "chosen";
        readonly profile: HeldProvisioningProfile;
        readonly signing: AppleDeviceSigning;
      }
    | Extract<Step, { readonly kind: "stopped" }>
  > {
    const listed = await this.#launchSigning(
      ["security", "find-identity", "-v", "-p", "codesigning"],
      DEVICECTL_TIMEOUT_MS,
      [],
      work.signal,
    );
    // The listing names each identity's owner, so none of it is logged. One
    // that could not be read is a failure, never an empty keychain.
    if (!succeeded(listed)) {
      return {
        kind: "stopped",
        outcome: outcomeFor(listed),
        note: "The login keychain's signing identities could not be listed.",
      };
    }
    const profiles = await readProvisioningProfiles(this.#options.provisioningProfileDirectories);
    const choice = chooseAppleDevelopmentSigning({
      teamId,
      bundleIdentifier,
      identities: parseSigningIdentities(text(listed.stdout)),
      profiles: profiles.map((profile) => profile.facts),
      nowMs: Date.parse(this.#options.now()),
    });
    if (choice.kind === "missing") {
      return { kind: "stopped", outcome: "failed", note: SIGNING_GAP_NOTES[choice.gap] };
    }
    const profile = profiles.find((candidate) => candidate.facts.profileId === choice.profileId);
    if (profile === undefined) {
      return {
        kind: "stopped",
        outcome: "failed",
        note: SIGNING_GAP_NOTES["no-provisioning-profile"],
      };
    }
    return { kind: "chosen", profile, signing: choice.signing };
  }

  /**
   * Signs the app the build declared, and only it: the bundle must be a real
   * directory inside this build's own derived data, not a link a build script
   * planted to point at another app. Nested frameworks are signed first, then
   * the app with the profile's entitlements, under the launch with no network.
   */
  async #sign(
    work: Work,
    declared: { readonly path: string; readonly bundleIdentifier: AppleBundleIdentifier },
    derivedRoot: string,
    profile: HeldProvisioningProfile,
    signing: AppleDeviceSigning,
  ): Promise<Step> {
    const product = declared.path;
    const realRoot = await this.#options.realpath(derivedRoot);
    const realProduct = await this.#options.realpath(product).catch(() => undefined);
    const inside = realProduct === undefined ? undefined : relative(realRoot, realProduct);
    const productStat = await lstat(product).catch(() => undefined);
    if (
      inside === undefined ||
      inside !== relative(derivedRoot, product) ||
      escapes(inside) ||
      productStat === undefined ||
      productStat.isSymbolicLink() ||
      !productStat.isDirectory()
    ) {
      return stopped(
        "failed",
        "The built app is not where this build put it, so it is not signed.",
      );
    }
    for (const folder of SEPARATELY_PROVISIONED) {
      const entries = await readdir(join(product, folder)).catch(() => []);
      if (entries.length > 0) {
        return stopped(
          "failed",
          `The app carries ${folder}, which needs a provisioning profile of its own; this host signs only the app itself.`,
        );
      }
    }
    const nested: string[] = [];
    for (const name of (await readdir(join(product, "Frameworks")).catch(() => [])).sort()) {
      if (!name.endsWith(".framework") && !name.endsWith(".dylib")) continue;
      const path = join(product, "Frameworks", name);
      if ((await lstat(path)).isSymbolicLink()) {
        return stopped("failed", "The app's Frameworks folder holds a link, so it is not signed.");
      }
      nested.push(path);
    }
    // The profile travels inside the app. A planted link at that name is
    // removed rather than written through.
    const embedded = join(product, "embedded.mobileprovision");
    await rm(embedded, { force: true, recursive: true });
    await copyFile(profile.path, embedded, constants.COPYFILE_EXCL);
    await mkdir(this.#options.signingDirectory, { recursive: true, mode: 0o700 });
    const entitlements = join(this.#options.signingDirectory, `${work.request.actionId}.plist`);
    await writeFile(
      entitlements,
      serializePropertyList(
        developmentEntitlements(profile, signing.teamId, declared.bundleIdentifier),
      ),
      { mode: 0o600 },
    );
    try {
      // `--timestamp=none`: a development signature needs no timestamp, and
      // asking for one is the only reason codesign would reach the network.
      const sign = ["codesign", "--force", "--sign", signing.identity, "--timestamp=none"];
      for (const path of nested) {
        const result = await this.#launchSigning(
          [...sign, path],
          work.request.timeoutMs,
          [product],
          work.signal,
        );
        // codesign's words name the identity, and with it the person, so the
        // evidence keeps only that it failed.
        if (!succeeded(result)) {
          return stopped(outcomeFor(result), "codesign could not sign a framework inside the app.");
        }
      }
      const result = await this.#launchSigning(
        [...sign, "--generate-entitlement-der", "--entitlements", entitlements, product],
        work.request.timeoutMs,
        [product],
        work.signal,
      );
      if (!succeeded(result))
        return stopped(outcomeFor(result), "codesign could not sign the app.");
    } finally {
      await rm(entitlements, { force: true });
    }
    return done;
  }

  async #install(work: Work): Promise<Step> {
    const { request } = work;
    const product =
      work.product ??
      this.#products.find(
        (held) =>
          String(held.reference) === String(request.artifact) &&
          held.threadId === String(request.threadId) &&
          held.checkoutId === String(request.checkoutId),
      );
    const device = await this.#coreDeviceIdentifier(request.deviceId);
    if (product === undefined || request.deviceId === undefined) {
      return stopped("failed", "This thread holds no such signed app.");
    }
    if (device === undefined) return stopped("unavailable", "The device is not listed any more.");
    work.bundleIdentifier = product.bundleIdentifier;
    // A run's build can outlast the lease it started under.
    if (!this.#holdsLease(request)) return stopped("failed", LEASE_ENDED_NOTE);
    const answer = await this.#runJson(
      ["device", "install", "app", "--device", device],
      [product.path],
      request.timeoutMs,
      work.signal,
      [product.path],
    );
    const outcome = parseDevicectlOutcome(answer.document);
    if (!succeeded(answer.result) || outcome.kind === "failed") {
      return stopped(
        succeeded(answer.result) ? "failed" : outcomeFor(answer.result),
        `devicectl could not install the app (${outcome.kind === "failed" ? outcome.reason : "no readable answer"}).`,
      );
    }
    if (parseDevicectlInstalledBundle(outcome.result) !== product.bundleIdentifier) {
      return stopped("failed", "devicectl did not report installing this app.");
    }
    const installed: ThreadBundle = {
      threadId: String(request.threadId),
      checkoutId: String(request.checkoutId),
      deviceId: request.deviceId,
      bundleIdentifier: product.bundleIdentifier,
    };
    if (!this.#installed.some((held) => sameBundle(held, installed))) {
      this.#installed.push(installed);
    }
    work.notes.push(`Installed ${product.bundleIdentifier} on the device.`);
    return done;
  }

  /**
   * Launches the thread's installed app under a console session the host
   * holds (`devicectl device process launch --console`). The session is how
   * the host reads the app's output and how it stops the app: it ends the app
   * when it ends, so nothing is ever stopped by name or process number.
   */
  async #launch(work: Work): Promise<Step> {
    const { request } = work;
    const bundleIdentifier = work.bundleIdentifier ?? request.bundleIdentifier;
    const device = await this.#coreDeviceIdentifier(request.deviceId);
    if (bundleIdentifier === undefined || request.deviceId === undefined) {
      return stopped("failed", "A launch names the app it starts.");
    }
    if (device === undefined) return stopped("unavailable", "The device is not listed any more.");
    work.bundleIdentifier = bundleIdentifier;
    const key = sessionKey(request.deviceId, bundleIdentifier);
    const previous = this.#sessions.get(key);
    if (previous !== undefined && previous.ended === undefined) {
      previous.controller.abort();
      await previous.finished;
    }
    await mkdir(this.#options.outputDirectory, { recursive: true, mode: 0o700 });
    // From the lease check to the session being listed nothing awaits, so a
    // lease that ends afterwards finds the session and ends it too.
    if (!this.#holdsLease(request)) return stopped("failed", LEASE_ENDED_NOTE);
    const controller = new AbortController();
    const session: ConsoleSession = {
      threadId: String(request.threadId),
      checkoutId: String(request.checkoutId),
      deviceId: request.deviceId,
      bundleIdentifier,
      controller,
      output: new Uint8Array(),
      ended: undefined,
      finished: Promise.resolve(unavailableResult()),
    };
    session.finished = this.#options
      .execute(
        {
          argv: [
            "xcrun",
            "devicectl",
            "device",
            "process",
            "launch",
            "--device",
            device,
            "--terminate-existing",
            "--console",
            bundleIdentifier,
          ],
          cwd: this.#options.outputDirectory,
          environment: {},
          timeoutMs: CONSOLE_SESSION_LIMIT_MS,
          isolatedRoots: this.#isolatedRoots(),
          // devicectl ends the app it attached to when it is interrupted.
          interruptFirst: true,
          onOutput: (chunk) => {
            session.output = keptTail(session.output, chunk);
          },
        },
        controller.signal,
      )
      .catch(() => unavailableResult())
      .then((result) => {
        session.ended = outcomeFor(result);
        return result;
      });
    this.#sessions.set(key, session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = await Promise.race([
      session.finished,
      new Promise<undefined>((resolveSettle) => {
        timer = setTimeout(
          () => resolveSettle(undefined),
          this.#options.launchSettleMs ?? LAUNCH_SETTLE_MS,
        );
      }),
    ]);
    clearTimeout(timer);
    if (early === undefined) {
      work.notes.push(
        `Launched ${bundleIdentifier} with its console attached; it runs until it exits, is terminated, or the lease ends.`,
      );
      return done;
    }
    // A session that ended while connecting either could not launch the app
    // or the app exited at once; its console output is kept for `logs`.
    if (!succeeded(early)) return stopped(outcomeFor(early), "devicectl could not launch the app.");
    work.notes.push(`${bundleIdentifier} launched and exited at once.`);
    return done;
  }

  async #terminate(work: Work): Promise<Step> {
    const session = this.#threadSession(work.request, "running");
    if (session === undefined) return stopped("failed", "Octant is not running this app.");
    work.bundleIdentifier = session.bundleIdentifier;
    session.controller.abort();
    const result = await session.finished;
    if (result.cleanupUncertain) {
      return stopped("interrupted", "The console session did not confirm it ended.");
    }
    work.notes.push(
      `Ended the console session of ${session.bundleIdentifier}, and the app with it.`,
    );
    return done;
  }

  /**
   * The console output of the app this thread launched, kept as evidence by
   * reference. Only its size enters the evidence: what the app printed can
   * carry the person's data, and the journal and provider read the evidence.
   */
  async #logs(work: Work): Promise<Step> {
    const session = this.#threadSession(work.request, "any");
    if (session === undefined) return stopped("failed", "Octant launched no such app.");
    work.bundleIdentifier = session.bundleIdentifier;
    const console = new TextEncoder().encode(
      withoutDeviceIdentifiers(new TextDecoder().decode(session.output)),
    );
    const reference = `apple-device-console-${work.request.actionId}`;
    if (this.#options.writeArtifact !== undefined) {
      await this.#options.writeArtifact(reference, console);
      work.artifacts.push({ kind: "log", reference });
    }
    work.notes.push(
      `Console output of ${session.bundleIdentifier}: ${console.byteLength} bytes, kept as evidence by reference; the app ${
        session.ended === undefined ? "is running" : `is no longer running (${session.ended})`
      }.`,
    );
    return done;
  }

  async #record(work: Work, outcome: AppleBuildOutcome): Promise<AppleDeviceResponse> {
    const { request } = work;
    const completedAt = this.#options.now();
    const roots: ReadonlyArray<readonly [string, string]> = [
      [work.context.checkoutRoot, "[PROJECT]"],
      [this.#options.artifactRoot, "[ARTIFACT]"],
    ];
    const log = sanitized(work.log.join("\n"), roots);
    const notes = work.notes.map((note) => sanitized(note, roots));
    if (log.trim().length > 0 && this.#options.writeArtifact !== undefined) {
      const reference = `apple-device-log-${request.actionId}`;
      await this.#options.writeArtifact(reference, new TextEncoder().encode(`${log}\n`));
      work.artifacts.unshift({ kind: "log", reference });
    }
    const diagnostics: AppleDiagnostic[] = [
      ...compilerDiagnostics(log).slice(0, MAX_DIAGNOSTICS - notes.length),
      ...notes.map((message) => ({
        severity: "note" as const,
        message: message.slice(0, MAX_DIAGNOSTIC_LENGTH),
      })),
    ];
    const product = work.product;
    if (request.deviceId === undefined) throw new TypeError("A device operation names its device.");
    const evidence = decodeAppleDeviceEvidence({
      actionId: request.actionId,
      correlationId: request.correlationId,
      authority: request.authority,
      kind: request.kind,
      deviceId: request.deviceId,
      requestedBy: request.requestedBy,
      outcome,
      ...(work.bundleIdentifier === undefined ? {} : { bundleIdentifier: work.bundleIdentifier }),
      ...(product === undefined ? {} : { product: product.reference, signing: product.signing }),
      diagnostics: diagnostics.slice(-MAX_DIAGNOSTICS),
      artifacts: work.artifacts.slice(0, 16),
      cleanup: outcome === "interrupted" ? "uncertain" : "complete",
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(work.startedAt)),
      completedAt,
    });
    this.#options.recordEvidence?.(evidence, work.startedAt);
    return decodeAppleDeviceResponse({ kind: "apple-device-evidence", evidence });
  }

  /** What this thread built, installed, and launched, as the policy weighs a request. */
  #holdingsFor(request: AppleDeviceRequest): AppleDeviceThreadHoldings {
    const mine = (held: { readonly threadId: string; readonly checkoutId: string }) =>
      held.threadId === String(request.threadId) && held.checkoutId === String(request.checkoutId);
    // Only a running session can be stopped; an ended one can still be read.
    const sessions = [...this.#sessions.values()].filter(
      (session) => mine(session) && (request.kind !== "terminate" || session.ended === undefined),
    );
    return {
      builtProducts: this.#products.filter(mine).map((product) => product.reference),
      installed: this.#installed.filter(mine),
      launched: sessions,
    };
  }

  #threadSession(
    request: AppleDeviceRequest,
    state: "running" | "any",
  ): ConsoleSession | undefined {
    if (request.deviceId === undefined || request.bundleIdentifier === undefined) return undefined;
    const session = this.#sessions.get(sessionKey(request.deviceId, request.bundleIdentifier));
    return session !== undefined &&
      session.threadId === String(request.threadId) &&
      session.checkoutId === String(request.checkoutId) &&
      (state === "any" || session.ended === undefined)
      ? session
      : undefined;
  }

  /** Whether this thread, on this checkout, still holds the device's lease. */
  #holdsLease(request: AppleDeviceRequest): boolean {
    return this.#options.leases
      .list()
      .some(
        (lease) =>
          String(lease.deviceId) === String(request.deviceId) &&
          String(lease.threadId) === String(request.threadId) &&
          String(lease.checkoutId) === String(request.checkoutId),
      );
  }

  #leaseEnded(ended: EndedAppleDeviceLease): void {
    for (const session of this.#sessions.values()) {
      if (
        String(session.deviceId) === String(ended.lease.deviceId) &&
        session.threadId === String(ended.lease.threadId) &&
        session.ended === undefined
      ) {
        session.controller.abort();
      }
    }
  }

  async #coreDeviceIdentifier(deviceId: AppleDeviceId | undefined): Promise<string | undefined> {
    if (deviceId === undefined) return undefined;
    const identities = await this.#loadIdentities();
    for (const [coreDeviceIdentifier, known] of identities) {
      if (String(known) === String(deviceId)) return coreDeviceIdentifier;
    }
    return undefined;
  }

  /** One look at the device layer at a time; a caller that arrives during one shares it. */
  async #refresh(signal: AbortSignal | undefined): Promise<Refreshed> {
    if (this.#refreshing !== undefined) return await this.#refreshing;
    const refreshing = this.#look(signal);
    this.#refreshing = refreshing;
    try {
      return await refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  async #look(signal: AbortSignal | undefined): Promise<Refreshed> {
    const developer = await this.#run(["xcode-select", "-p"], signal);
    const developerDirectory = text(developer.stdout).trim();
    const licence =
      succeeded(developer) && !developerDirectory.endsWith("/CommandLineTools")
        ? await this.#run(["xcodebuild", "-license", "check"], signal)
        : undefined;
    if (licence === undefined || !succeeded(licence)) {
      this.#settle(false, [], []);
      return "refreshed";
    }
    const { offered, answered } = await this.#probe(developerDirectory, signal);
    const tooling = DEVICECTL_PROBES.flatMap((probe) =>
      probe.operation !== "lock-state" && offered.has(probe.operation) ? [probe.operation] : [],
    );
    if (!offered.has("list-devices")) {
      this.#settle(true, tooling, []);
      // A probe that did not finish cannot show the listing is not offered.
      return answered ? "refreshed" : "unreadable";
    }
    const listing = parseDevicectlDeviceList(await this.#readJson(["list", "devices"], signal));
    if (listing.kind === "unreadable") {
      // A host that cannot list its devices cannot show a leased one is still
      // there, so the lease's grace runs as if the device were gone.
      this.#settle(true, tooling, []);
      return "unreadable";
    }
    const identities = await this.#loadIdentities();
    const listed: AppleDeviceRecord[] = [];
    for (const device of listing.devices) {
      const state = await this.#state(device, offered.has("lock-state"), signal);
      const deviceId = this.#identityFor(identities, device.coreDeviceIdentifier, listing.devices);
      listed.push(
        decodeAppleDeviceRecord({
          deviceId,
          name: device.name,
          model: device.model,
          platform: "ios",
          osVersion: device.osVersion,
          connection: device.connection,
          state,
        }),
      );
    }
    await this.#persistIdentities();
    this.#settle(true, tooling, listed);
    return "refreshed";
  }

  /** Records what one look found and lets the leases follow it. */
  #settle(
    toolchainAvailable: boolean,
    tooling: ReadonlyArray<AppleDeviceToolingOperation>,
    listed: ReadonlyArray<AppleDeviceRecord>,
  ): void {
    this.#options.leases.observeDevices(
      listed.map((device) => ({ deviceId: String(device.deviceId), state: device.state })),
    );
    for (const device of listed) this.#lastSeen.set(String(device.deviceId), device);
    // A leased device that went away stays listed, as unavailable, until its
    // lease ends: the thread that holds it can still see it and let it go.
    const away = this.#options.leases.list().flatMap((lease) => {
      if (listed.some((device) => String(device.deviceId) === String(lease.deviceId))) return [];
      const last = this.#lastSeen.get(String(lease.deviceId));
      return last === undefined ? [] : [decodeAppleDeviceRecord({ ...last, state: "unavailable" })];
    });
    this.#layer = { toolchainAvailable, tooling, devices: [...listed, ...away] };
  }

  async #state(
    device: DevicectlDevice,
    lockStateOffered: boolean,
    signal: AbortSignal | undefined,
  ): Promise<AppleDeviceRecord["state"]> {
    if (device.listedState !== "reachable") return device.listedState;
    // A device whose lock state cannot be read cannot be shown to answer.
    if (!lockStateOffered) return "unavailable";
    const lock = parseDevicectlLockState(
      await this.#readJson(
        ["device", "info", "lockState", "--device", device.coreDeviceIdentifier],
        signal,
      ),
    );
    return lock === "unlocked" ? "connected" : lock === "locked" ? "locked" : "unavailable";
  }

  /** Which device operations the selected Xcode offers, probed once per developer directory. */
  async #probe(
    developerDirectory: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly offered: ReadonlySet<string>; readonly answered: boolean }> {
    if (this.#tooling?.developerDirectory === developerDirectory) {
      return { offered: this.#tooling.offered, answered: true };
    }
    const offered = new Set<string>();
    const helps = new Map<string, { readonly exitCode: number | null; readonly output: string }>();
    let answered = true;
    for (const probe of DEVICECTL_PROBES) {
      const key = probe.subcommand.join(" ");
      let help = helps.get(key);
      if (help === undefined) {
        const result = await this.#run(
          ["xcrun", "devicectl", ...probe.subcommand, "--help"],
          signal,
        );
        if (result.termination !== "exited") answered = false;
        help = {
          exitCode: result.termination === "exited" ? result.exitCode : null,
          output: `${text(result.stdout)}\n${text(result.stderr)}`,
        };
        helps.set(key, help);
      }
      if (devicectlOffers(probe, help)) offered.add(probe.operation);
    }
    // A help that timed out, was cancelled, or never started says nothing
    // about the selected Xcode. Keeping that answer would report its
    // operations missing, and its listing empty, until the host restarts.
    if (answered) this.#tooling = { developerDirectory, offered };
    return { offered, answered };
  }

  /** Runs a `devicectl` subcommand that answers in a JSON file; anything unreadable is undefined. */
  async #readJson(
    subcommand: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const answer = await this.#runJson(subcommand, [], DEVICECTL_TIMEOUT_MS, signal);
    return succeeded(answer.result) ? answer.document : undefined;
  }

  /**
   * Runs a `devicectl` subcommand that answers in a JSON file, reads that
   * file whatever the exit, and removes it whatever happened.
   */
  async #runJson(
    subcommand: ReadonlyArray<string>,
    operands: ReadonlyArray<string>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    readRoots: ReadonlyArray<string> = [],
  ): Promise<{ readonly result: AppleProcessResult; readonly document: unknown }> {
    const directory = this.#options.outputDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = join(directory, `${randomUUID()}.json`);
    try {
      const result = await this.#run(
        ["xcrun", "devicectl", ...subcommand, "--json-output", output, ...operands],
        signal,
        [directory],
        timeoutMs,
        readRoots,
      );
      let document: unknown;
      try {
        const bytes = await readStoredFile(output, MAX_DEVICECTL_OUTPUT_BYTES);
        document =
          bytes === undefined
            ? undefined
            : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        document = undefined;
      }
      return { result, document };
    } finally {
      await rm(output, { force: true });
    }
  }

  async #run(
    argv: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
    writeRoots: ReadonlyArray<string> = [],
    timeoutMs = DEVICECTL_TIMEOUT_MS,
    readRoots: ReadonlyArray<string> = [],
  ): Promise<AppleProcessResult> {
    const directory = this.#options.outputDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await this.#options.execute(
      {
        argv,
        cwd: directory,
        environment: {},
        timeoutMs,
        // Every launch is denied the private directories after its broad
        // grants; only the launch writing an answer is given the output one back.
        isolatedRoots: this.#isolatedRoots(),
        ...(writeRoots.length === 0 ? {} : { additionalWriteRoots: writeRoots }),
        ...(readRoots.length === 0 ? {} : { additionalReadRoots: readRoots }),
      },
      signal,
    );
  }

  /** An `xcodebuild` launch for a device build, under the ordinary Apple profile. */
  async #launchApple(
    input: {
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly additionalWriteRoots: ReadonlyArray<string>;
    },
    signal: AbortSignal | undefined,
  ): Promise<AppleProcessResult> {
    return await this.#options.execute(
      { ...input, environment: {}, isolatedRoots: this.#isolatedRoots() },
      signal,
    );
  }

  /**
   * A signing launch: no network, the signing directory readable, and the
   * one bundle being signed writable. Every other private directory is denied.
   */
  async #launchSigning(
    argv: ReadonlyArray<string>,
    timeoutMs: number,
    writeRoots: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
  ): Promise<AppleProcessResult> {
    const directory = this.#options.signingDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await this.#options.executeSigning(
      {
        argv,
        cwd: directory,
        environment: {},
        timeoutMs,
        additionalReadRoots: [directory],
        ...(writeRoots.length === 0 ? {} : { additionalWriteRoots: writeRoots }),
        isolatedRoots: [this.#options.outputDirectory, ...(this.#options.isolatedRoots ?? [])],
      },
      signal,
    );
  }

  #isolatedRoots(): ReadonlyArray<string> {
    return [
      this.#options.outputDirectory,
      this.#options.signingDirectory,
      ...(this.#options.isolatedRoots ?? []),
    ];
  }

  async #loadIdentities(): Promise<Map<string, AppleDeviceId>> {
    if (this.#identities === undefined) {
      const stored = await this.#options.identities.loadDeviceIdentities();
      this.#identities = new Map(
        stored.map((identity) => [identity.coreDeviceIdentifier, identity.deviceId]),
      );
    }
    return this.#identities;
  }

  #identityFor(
    identities: Map<string, AppleDeviceId>,
    coreDeviceIdentifier: string,
    listed: ReadonlyArray<DevicectlDevice>,
  ): AppleDeviceId {
    const known = identities.get(coreDeviceIdentifier);
    if (known !== undefined) return known;
    if (identities.size >= MAX_DEVICE_IDENTITIES) {
      // Forget the oldest device that is neither listed now nor leased, so a
      // full store never stops a newly paired device from being named.
      const leased = new Set(this.#options.leases.list().map((lease) => String(lease.deviceId)));
      for (const [identifier, deviceId] of identities) {
        if (listed.some((device) => device.coreDeviceIdentifier === identifier)) continue;
        if (leased.has(String(deviceId))) continue;
        identities.delete(identifier);
        this.#lastSeen.delete(String(deviceId));
        break;
      }
    }
    const minted = decodeAppleDeviceId(this.#options.newId());
    identities.set(coreDeviceIdentifier, minted);
    this.#identitiesChanged = true;
    return minted;
  }

  async #persistIdentities(): Promise<void> {
    if (!this.#identitiesChanged || this.#identities === undefined) return;
    await this.#options.identities.persistDeviceIdentities(
      [...this.#identities].map(([coreDeviceIdentifier, deviceId]) => ({
        deviceId,
        coreDeviceIdentifier,
      })),
    );
    this.#identitiesChanged = false;
  }
}

/**
 * The app a device build declares, from `-showBuildSettings -json`: the first
 * target whose product is an `.app`, and only when that product lands inside
 * this build's own derived-data directory.
 */
function deviceProduct(
  output: string,
  derivedRoot: string,
): { readonly path: string; readonly bundleIdentifier: AppleBundleIdentifier } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    const settings = isRecord(entry) ? entry.buildSettings : undefined;
    if (!isRecord(settings)) continue;
    const { TARGET_BUILD_DIR, WRAPPER_NAME, PRODUCT_BUNDLE_IDENTIFIER } = settings;
    if (
      typeof TARGET_BUILD_DIR !== "string" ||
      typeof WRAPPER_NAME !== "string" ||
      typeof PRODUCT_BUNDLE_IDENTIFIER !== "string" ||
      !WRAPPER_NAME.endsWith(".app") ||
      WRAPPER_NAME.includes("/")
    ) {
      continue;
    }
    const path = resolve(TARGET_BUILD_DIR, WRAPPER_NAME);
    const inside = relative(derivedRoot, path);
    if (inside.length === 0 || escapes(inside)) return undefined;
    return Schema.is(AppleBundleIdentifier)(PRODUCT_BUNDLE_IDENTIFIER)
      ? { path, bundleIdentifier: PRODUCT_BUNDLE_IDENTIFIER }
      : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapes(fromRoot: string): boolean {
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

function sameBundle(left: ThreadBundle, right: ThreadBundle): boolean {
  return (
    left.threadId === right.threadId &&
    left.checkoutId === right.checkoutId &&
    String(left.deviceId) === String(right.deviceId) &&
    left.bundleIdentifier === right.bundleIdentifier
  );
}

function sessionKey(deviceId: AppleDeviceId, bundleIdentifier: AppleBundleIdentifier): string {
  return `${String(deviceId)}\n${bundleIdentifier}`;
}

function keptTail(kept: Uint8Array, chunk: Uint8Array): Uint8Array {
  const joined = new Uint8Array(kept.byteLength + chunk.byteLength);
  joined.set(kept, 0);
  joined.set(chunk, kept.byteLength);
  return joined.byteLength <= MAX_CONSOLE_BYTES
    ? joined
    : joined.slice(joined.byteLength - MAX_CONSOLE_BYTES);
}

/**
 * Text a device operation keeps: host roots replaced, as for the Simulator,
 * and every token shaped like a device identifier removed.
 */
function sanitized(value: string, roots: ReadonlyArray<readonly [string, string]>): string {
  let result = value;
  for (const [root, label] of roots) result = result.replaceAll(root, label);
  return withoutDeviceIdentifiers(result);
}

function compilerDiagnostics(log: string): ReadonlyArray<AppleDiagnostic> {
  const diagnostics: AppleDiagnostic[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/.exec(line.trim());
    const severity = match?.[4];
    const message = match?.[5]?.trim();
    if (
      match === null ||
      (severity !== "error" && severity !== "warning" && severity !== "note") ||
      message === undefined ||
      message.length === 0
    ) {
      continue;
    }
    diagnostics.push({
      severity,
      location: `${match[1]}:${match[2]}:${match[3]}`.slice(0, 512),
      message: message.slice(0, MAX_DIAGNOSTIC_LENGTH),
    });
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  return diagnostics;
}

function refused(reason: AppleDeviceRefusalReason): AppleDeviceResponse {
  return decodeAppleDeviceResponse({ kind: "apple-device-refused", reason });
}

function succeeded(result: AppleProcessResult): boolean {
  return result.termination === "exited" && result.exitCode === 0 && !result.cleanupUncertain;
}

function outcomeFor(result: AppleProcessResult): AppleBuildOutcome {
  if (result.cleanupUncertain) return "interrupted";
  if (result.termination === "cancelled") return "cancelled";
  if (result.termination === "timed-out") return "timed-out";
  if (result.termination === "unavailable") return "unavailable";
  if (result.exitCode === null) return "process-died";
  return result.exitCode === 0 ? "succeeded" : "failed";
}

function unavailableResult(): AppleProcessResult {
  return {
    termination: "unavailable",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    parserFailed: false,
    cleanupUncertain: false,
  };
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}
