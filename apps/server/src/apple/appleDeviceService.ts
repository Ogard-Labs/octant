import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAppleDeviceId,
  decodeAppleDeviceLease,
  decodeAppleDeviceRecord,
  decodeAppleDeviceResponse,
  type AppleDeviceId,
  type AppleDeviceRecord,
  type AppleDeviceRefusalReason,
  type AppleDeviceRequest,
  type AppleDeviceResponse,
  type AppleDeviceToolingOperation,
} from "@octant/contracts";
import {
  evaluateAppleDeviceRequest,
  type AppleDeviceExecutionScope,
  type AppleDeviceHost,
  type AppleDeviceThreadHoldings,
} from "@octant/domain";
import type { AppleDeviceLeases } from "./appleDeviceLeases";
import {
  MAX_DEVICE_IDENTITIES,
  readStoredFile,
  type AppleDeviceIdentity,
} from "./appleRuntimeStore";
import type { AppleProcessResult } from "./appleToolchainService";
import {
  DEVICECTL_PROBES,
  devicectlOffers,
  parseDevicectlDeviceList,
  parseDevicectlLockState,
  type DevicectlDevice,
} from "./devicectl";

const DEVICECTL_TIMEOUT_MS = 30_000;
/** The largest `--json-output` document the host reads back. */
const MAX_DEVICECTL_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface AppleDeviceServiceOptions {
  /** The host's confined Apple launch, the same one Simulator discovery uses. */
  readonly execute: (
    input: {
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
      readonly additionalWriteRoots?: ReadonlyArray<string>;
      readonly isolatedRoots?: ReadonlyArray<string>;
    },
    signal?: AbortSignal,
  ) => Promise<AppleProcessResult>;
  /**
   * A host-private directory `devicectl` writes its JSON answers to. The
   * listing names every paired device's hardware identifiers, so only the
   * launch that writes one may reach the directory, and each answer is
   * removed once it has been read.
   */
  readonly outputDirectory: string;
  /** Other host-private directories every device launch is denied. */
  readonly isolatedRoots?: ReadonlyArray<string>;
  readonly identities: {
    readonly loadDeviceIdentities: () => Promise<ReadonlyArray<AppleDeviceIdentity>>;
    readonly persistDeviceIdentities: (
      identities: ReadonlyArray<AppleDeviceIdentity>,
    ) => Promise<void>;
  };
  readonly leases: AppleDeviceLeases;
  readonly now: () => string;
  readonly newId: () => string;
  /** Override for tests; production uses `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** What one look at the host's device layer found. */
interface DeviceLayer {
  readonly toolchainAvailable: boolean;
  readonly tooling: ReadonlyArray<AppleDeviceToolingOperation>;
  readonly devices: ReadonlyArray<AppleDeviceRecord>;
}

/** Whether one look at the device layer could list the paired devices. */
type Refreshed = "refreshed" | "unreadable";

// The host does not yet build, install, or launch on a device, so it holds
// nothing for a thread and every request that needs a holding is refused by
// ownership.
const NO_HOLDINGS: AppleDeviceThreadHoldings = { builtProducts: [], installed: [], launched: [] };

/**
 * The host side of physical Apple devices (docs/design/apple-devices.md):
 * discovery through the selected Xcode's `devicectl`, host-minted ids, and
 * person-confirmed leases. Every request is decided by the pure device policy
 * against what the host just found; this service only gathers that state and
 * carries out what the policy allowed.
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

  constructor(options: AppleDeviceServiceOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
  }

  /** The device a confirmation names, as the host last saw it. */
  describe(deviceId: AppleDeviceId): AppleDeviceRecord | undefined {
    return this.#layer.devices.find((device) => String(device.deviceId) === String(deviceId));
  }

  async request(
    request: AppleDeviceRequest,
    scope: AppleDeviceExecutionScope,
    signal?: AbortSignal,
  ): Promise<AppleDeviceResponse> {
    if (this.#platform !== "darwin") {
      // Nothing stands in for a Mac: no process starts, and the policy names why.
      const decision = evaluateAppleDeviceRequest(
        request,
        scope,
        {
          macos: false,
          toolchain: { available: false },
          tooling: [],
          devices: [],
          leases: [],
          distributionEnabled: false,
        },
        NO_HOLDINGS,
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
    const decision = evaluateAppleDeviceRequest(request, scope, host, NO_HOLDINGS);
    if (decision.kind === "denied") return refused(decision.reason);
    return this.#carryOut(request, scope, host);
  }

  #carryOut(
    request: AppleDeviceRequest,
    scope: AppleDeviceExecutionScope,
    host: AppleDeviceHost,
  ): AppleDeviceResponse {
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
        if (request.deviceId === undefined || scope.approvedBy?.kind !== "local-user") {
          return refused("confirmation-required");
        }
        const lease = decodeAppleDeviceLease({
          deviceId: request.deviceId,
          threadId: request.threadId,
          checkoutId: request.checkoutId,
          grantedBy: scope.approvedBy,
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
      default:
        // Building, installing, and the rest arrive in later slices; until
        // then the host does not offer what the policy would allow.
        return refused("operation-unavailable");
    }
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

  /**
   * Runs a `devicectl` subcommand that answers in a JSON file, reads that
   * file, and removes it whatever happened. Anything unreadable is undefined.
   */
  async #readJson(
    subcommand: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const directory = this.#options.outputDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = join(directory, `${randomUUID()}.json`);
    try {
      const result = await this.#run(
        ["xcrun", "devicectl", ...subcommand, "--json-output", output],
        signal,
        [directory],
      );
      if (!succeeded(result)) return undefined;
      const bytes = await readStoredFile(output, MAX_DEVICECTL_OUTPUT_BYTES);
      return bytes === undefined
        ? undefined
        : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return undefined;
    } finally {
      await rm(output, { force: true });
    }
  }

  async #run(
    argv: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
    writeRoots: ReadonlyArray<string> = [],
  ): Promise<AppleProcessResult> {
    const directory = this.#options.outputDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await this.#options.execute(
      {
        argv,
        cwd: directory,
        environment: {},
        timeoutMs: DEVICECTL_TIMEOUT_MS,
        // Every launch is denied the private directories after its broad
        // grants; only the launch writing an answer is given the output one back.
        isolatedRoots: [directory, ...(this.#options.isolatedRoots ?? [])],
        ...(writeRoots.length === 0 ? {} : { additionalWriteRoots: writeRoots }),
      },
      signal,
    );
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

function refused(reason: AppleDeviceRefusalReason): AppleDeviceResponse {
  return decodeAppleDeviceResponse({ kind: "apple-device-refused", reason });
}

function succeeded(result: AppleProcessResult): boolean {
  return result.termination === "exited" && result.exitCode === 0 && !result.cleanupUncertain;
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}
