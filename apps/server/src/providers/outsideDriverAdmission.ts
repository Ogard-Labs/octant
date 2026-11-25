import { randomUUID } from "node:crypto";
import {
  decodeProviderFailure,
  decodeProviderSessionId,
  OutsideProviderDriverListing,
  type OutsideDriverProviderInstance,
  type OutsideHarnessEndpointProviderInstance,
  type OutsideImageProviderInstance,
  type OutsideVideoProviderInstance,
  isOutsideDriverProviderInstance,
  OutsideProviderDriverReference,
  type ProviderFailure,
  type ProviderFailureCategory,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ExtensionEffectiveState, ExtensionPackageState } from "@octant/contracts/extensions";
import {
  outsideDriverHostLaunch,
  outsideImageDriverModels,
  outsideVideoDriverModels,
  resolveOutsideDriverRebind,
  resolveOutsideHarnessEndpointActivation,
  resolveOutsideImageDriverActivation,
  resolveOutsideVideoDriverActivation,
  type OutsideDriverActivationTarget,
} from "@octant/plugin-host/activation";
import type { HarnessEndpointDriver } from "@octant/provider-sdk/harness-endpoint";
import type { ImageGenerationAdapter } from "@octant/provider-sdk/image-generation";
import type { VideoGenerationAdapter } from "@octant/provider-sdk/video-generation";
import { Effect, Schema } from "effect";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  capabilityEchoToolDefinition,
  isCapabilityEchoToolCall,
  OCTANT_CAPABILITY_ECHO_TOOL_NAME,
} from "./openAiToolEncoding";
import type {
  OutsideDriverProcessRefusal,
  OutsideDriverProcessStart,
  OutsideDriverProcessStartInput,
} from "./outsideDriverProcess";
import {
  admitOutsideDriverTurn,
  makeOutsideHarnessEndpointProxy,
  type OutsideDriverChannel,
  type OutsideDriverFetch,
  type OutsideDriverLimits,
} from "./outsideHarnessEndpointProxy";
import {
  makeOutsideImageGenerationProxy,
  type OutsideImageJobPorts,
} from "./outsideImageGenerationProxy";
import {
  makeOutsideVideoGenerationProxy,
  type OutsideVideoClipPorts,
  type OutsideVideoSends,
} from "./outsideVideoGenerationProxy";
import type { ProviderDriverRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * Admission of outside provider drivers: whether the package an instance
 * binds is effective on this host, and, when it is, the driver the host's
 * harness runs for that instance.
 *
 * Nothing starts until the instance is used. Its first use (a connection
 * check, Verify tools, or a turn) starts one confined process through the
 * extension supervisor and puts the host proxy over its stdio; later uses
 * share that process until it ends, the instance is turned off or removed,
 * or the driver stops being effective. Verify tools is run here, by the host,
 * through the proxy: the host offers the echo tool and reads the returned
 * tool calls itself, so a driver never certifies its own models.
 */

export interface OutsideDriverProcessStarter {
  readonly start: (input: OutsideDriverProcessStartInput) => Promise<OutsideDriverProcessStart>;
  readonly stop: (instanceId: ProviderInstanceId) => Promise<void>;
}

export interface OutsideDriverAdmissionOptions {
  readonly platform: string;
  /** The extension packages as the host's projection holds them. */
  readonly packages: () => ReadonlyArray<ExtensionPackageState>;
  /** The host's verdict on a package's app range and platforms. */
  readonly isCompatible: (packageState: ExtensionPackageState) => boolean;
  /** The verified package root and entry module of one stored driver, or nothing. */
  readonly entry: (
    driver: OutsideProviderDriverReference,
  ) => Promise<{ readonly packageRoot: string; readonly entryPoint: string } | undefined>;
  readonly processes: OutsideDriverProcessStarter;
  readonly runtimeRegistry: ProviderDriverRuntimeRegistry;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: OutsideDriverFetch;
  readonly limits?: Partial<OutsideDriverLimits>;
  readonly clock?: () => string;
  /** Resolves an image address's host name; the system resolver by default. */
  readonly resolve?: (hostname: string) => Promise<ReadonlyArray<string>>;
  /**
   * The host's Strict, read at each admission: Strict as a Settings default
   * in Code or Work, the reading a host-scope use with no thread takes. An
   * instance serves every mode and no one thread, so no thread's own choice
   * applies. Absent reads Strict.
   */
  readonly strict?: () => boolean;
}

const TOOL_CHECK_PROMPT = `Call the ${OCTANT_CAPABILITY_ECHO_TOOL_NAME} tool with echo set to "ready". Do not answer in text.`;

function failure(
  category: ProviderFailureCategory,
  message: string,
  reason?: ProviderFailure["reason"],
): ProviderFailure {
  return { category, message, ...(reason === undefined ? {} : { reason }) };
}

const notAdmitted = () =>
  failure("unsupported", "This provider driver is not available.", "driver-not-admitted");

/** Octant's words for each reason the process owner refused a start. */
function refusalFailure(reason: OutsideDriverProcessRefusal): ProviderFailure {
  switch (reason) {
    case "host-prohibited":
      return notAdmitted();
    case "runtime-unavailable":
      return failure(
        "unavailable",
        "This build of Octant cannot start provider drivers.",
        "runtime-unavailable",
      );
    case "quarantined":
      return failure(
        "unavailable",
        "The provider driver stopped too often, so Octant holds this version until you trust another version.",
        "runtime-unavailable",
      );
    case "already-running":
    case "start-failed":
      return failure(
        "unavailable",
        "The provider driver could not be started.",
        "runtime-unavailable",
      );
  }
}

/**
 * Everything thrown on these paths is the host's: this module's failures, or
 * the closed ones the proxy writes. Anything else becomes a fixed failure.
 */
function asFailure(error: unknown): ProviderFailure {
  try {
    return decodeProviderFailure(error);
  } catch {
    return failure("unavailable", "The provider driver could not be reached.");
  }
}

/** What the host runs over one driver process, by the family of its instance. */
type RunningProxy =
  | { readonly family: "harness-endpoint"; readonly driver: HarnessEndpointDriver }
  | {
      readonly family: "image";
      readonly adapter: ReturnType<typeof makeOutsideImageGenerationProxy>;
    }
  | {
      readonly family: "video";
      readonly adapter: ReturnType<typeof makeOutsideVideoGenerationProxy>;
    };

interface RunningDriver {
  readonly instanceId: ProviderInstanceId;
  readonly extensionId: string;
  /** The configuration the process was started for; any other is a new process. */
  readonly binding: string;
  proxy: Promise<RunningProxy> | undefined;
  live: HarnessEndpointDriver | undefined;
  channel: OutsideDriverChannel | undefined;
  /** Tells the proxy the channel closed, which fails its calls in flight. */
  close: (() => void) | undefined;
  unsubscribe: (() => void) | undefined;
  ended: boolean;
}

const decodeListing = Schema.decodeUnknownEither(OutsideProviderDriverListing);
const decodeReference = Schema.decodeUnknownEither(OutsideProviderDriverReference);

export class OutsideDriverAdmission {
  readonly #platform: string;
  readonly #packages: OutsideDriverAdmissionOptions["packages"];
  readonly #isCompatible: OutsideDriverAdmissionOptions["isCompatible"];
  readonly #entry: OutsideDriverAdmissionOptions["entry"];
  readonly #processes: OutsideDriverProcessStarter;
  readonly #registry: ProviderDriverRuntimeRegistry;
  readonly #credentialResolver: ProviderCredentialResolver | undefined;
  readonly #fetch: OutsideDriverFetch | undefined;
  readonly #limits: Partial<OutsideDriverLimits> | undefined;
  readonly #clock: (() => string) | undefined;
  readonly #resolve: OutsideDriverAdmissionOptions["resolve"];
  readonly #strict: () => boolean;
  readonly #running = new Map<string, RunningDriver>();

  constructor(options: OutsideDriverAdmissionOptions) {
    this.#platform = options.platform;
    this.#packages = options.packages;
    this.#isCompatible = options.isCompatible;
    this.#entry = options.entry;
    this.#processes = options.processes;
    this.#registry = options.runtimeRegistry;
    this.#credentialResolver = options.credentialResolver;
    this.#fetch = options.fetch;
    this.#limits = options.limits;
    this.#clock = options.clock;
    this.#resolve = options.resolve;
    this.#strict = options.strict ?? (() => true);
  }

  /**
   * Where the instance's driver stands on the activation ladder, at its bound
   * digest. A media profile's driver must also still declare its media there,
   * so no family can run another's package.
   */
  activation(instance: OutsideDriverProviderInstance): ExtensionEffectiveState {
    const packageState = this.#packageOf(instance.configuration.driver);
    const input = {
      platform: this.#platform,
      packageState,
      compatible: packageState === undefined || this.#isCompatible(packageState),
      strict: this.#strict(),
      driver: activationTarget(instance.configuration.driver),
    };
    switch (instance.driverKind) {
      case "outside-image":
        return resolveOutsideImageDriverActivation(input);
      case "outside-video":
        return resolveOutsideVideoDriverActivation(input);
      case "outside-harness-endpoint":
        return resolveOutsideHarnessEndpointActivation(input);
    }
  }

  isAdmitted(instance: OutsideDriverProviderInstance): boolean {
    return this.activation(instance).kind === "effective";
  }

  /**
   * The models and published prices an image driver's package declares at
   * exactly the digest named, or nothing. Reading them starts nothing.
   */
  imageDriverModels(
    driver: OutsideProviderDriverReference,
  ): ReturnType<typeof outsideImageDriverModels> {
    return outsideImageDriverModels({
      packageState: this.#packageOf(driver),
      driver: activationTarget(driver),
    });
  }

  /**
   * The models, prices and job facts a video driver's package declares at
   * exactly the digest named, or nothing. Reading them starts nothing.
   */
  videoDriverModels(
    driver: OutsideProviderDriverReference,
  ): ReturnType<typeof outsideVideoDriverModels> {
    return outsideVideoDriverModels({
      packageState: this.#packageOf(driver),
      driver: activationTarget(driver),
    });
  }

  #packageOf(driver: OutsideProviderDriverReference): ExtensionPackageState | undefined {
    return this.#packages().find(
      (candidate) => String(candidate.extensionId) === String(driver.extensionId),
    );
  }

  /**
   * The digest the instance moves to because its person trusted another
   * selection of the same driver, or nothing. Reading it starts nothing.
   */
  rebindTarget(
    instance: OutsideDriverProviderInstance,
  ): OutsideProviderDriverReference | undefined {
    const driver = instance.configuration.driver;
    const target = resolveOutsideDriverRebind({
      packageState: this.#packageOf(driver),
      driver: activationTarget(driver),
    });
    if (target === undefined) return undefined;
    const decoded = decodeReference(target);
    return decoded._tag === "Right" ? decoded.right : undefined;
  }

  /**
   * The effective outside drivers a provider may be added from, as the
   * provider catalog lists them. Reading them starts nothing.
   */
  listings(): ReadonlyArray<OutsideProviderDriverListing> {
    return this.#packages().flatMap((packageState) =>
      packageState.components.flatMap(({ component, activation }) => {
        if (component.kind !== "provider-driver" || packageState.source.kind !== "local-folder") {
          return [];
        }
        const driver = {
          extensionId: packageState.extensionId,
          packageId: packageState.packageId,
          componentId: component.id,
          version: packageState.version,
          digest: packageState.digest,
        };
        const input = {
          platform: this.#platform,
          packageState,
          compatible: this.#isCompatible(packageState),
          strict: this.#strict(),
          driver: activationTarget(driver),
        };
        const imageModels = outsideImageDriverModels(input);
        const videoModels = outsideVideoDriverModels(input);
        const state =
          imageModels !== undefined
            ? resolveOutsideImageDriverActivation(input)
            : videoModels !== undefined
              ? resolveOutsideVideoDriverActivation(input)
              : resolveOutsideHarnessEndpointActivation(input);
        if (state.kind !== "effective") return [];
        // A listing that does not decode is left out rather than breaking the registry.
        const listing = decodeListing({
          driver,
          displayName: (packageState.displayName ?? packageState.slug ?? component.displayName)
            .trim()
            .slice(0, 128),
          source: packageState.npm === undefined ? "local-folder" : "npm",
          ...(packageState.npm === undefined ? {} : { npm: packageState.npm }),
          installed: activation.installed,
          trusted: activation.trusted,
          ...(packageState.publisher?.selected === undefined
            ? {}
            : { publisherKey: packageState.publisher.selected }),
          ...(outsideDriverHostLaunch(this.#platform) === "unconfined"
            ? { hostConfinement: "unconfined" }
            : {}),
          ...(imageModels === undefined ? {} : { imageGeneration: { models: imageModels } }),
          ...(videoModels === undefined
            ? {}
            : {
                videoGeneration: {
                  models: videoModels.map(({ modelId, displayName, price }) => ({
                    modelId,
                    displayName,
                    publishesPrice: price.kind !== "unpublished",
                  })),
                },
              }),
        });
        return listing._tag === "Right" ? [listing.right] : [];
      }),
    );
  }

  /**
   * The driver the host's harness runs for one instance. The caller decides
   * admission first; every use checks it again before a process starts.
   */
  endpoint(instance: OutsideHarnessEndpointProviderInstance): HarnessEndpointDriver {
    const instanceId = instance.id;
    const ensure = async () => {
      const running = await this.#ensure(instance);
      if (running.family !== "harness-endpoint") throw notAdmitted();
      return running.driver;
    };
    const mismatch = () =>
      Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."));
    return {
      kind: "outside-harness-endpoint",
      harnessEndpoint: {
        open: async (modelId) => (await ensure()).harnessEndpoint.open(modelId),
        // Decided on the host from its own records, whether or not a process runs.
        admitTurn: (turn, modelId) => {
          const live = this.#running.get(String(instanceId))?.live;
          return live === undefined
            ? admitOutsideDriverTurn(this.#registry, instanceId, turn, modelId)
            : live.harnessEndpoint.admitTurn(turn, modelId);
        },
      },
      probe: (input) =>
        String(input.instanceId) !== String(instanceId)
          ? mismatch()
          : Effect.flatMap(Effect.tryPromise({ try: ensure, catch: asFailure }), (proxy) =>
              proxy.probe(input),
            ),
      verifyToolCapability: ({ instanceId: requested, modelId }) =>
        String(requested) !== String(instanceId)
          ? mismatch()
          : Effect.tryPromise({
              try: async () => {
                if (!instance.configuration.modelIds.some((id) => String(id) === String(modelId))) {
                  throw failure(
                    "invalid-configuration",
                    "Tool verification is only available for models this provider lists.",
                  );
                }
                const proxy = await ensure();
                const session = await proxy.harnessEndpoint.open(modelId);
                try {
                  const response = await session.send(
                    {
                      sessionId: decodeProviderSessionId(randomUUID()),
                      modelId,
                      system: undefined,
                      history: [{ role: "user", text: TOOL_CHECK_PROMPT }],
                      tools: [capabilityEchoToolDefinition()],
                    },
                    { signal: new AbortController().signal, onEvent: () => undefined },
                  );
                  return {
                    instanceId,
                    modelId,
                    appManagedTools: response.toolCalls.some((call) =>
                      isCapabilityEchoToolCall(call.toolName),
                    )
                      ? ("supported" as const)
                      : ("unsupported" as const),
                  };
                } finally {
                  session.release();
                }
              },
              catch: asFailure,
            }),
    };
  }

  /**
   * The adapter the image job service runs for one outside image profile. Its
   * process starts at the profile's first job, never before, and admission is
   * decided again at that start; a profile whose driver is not admitted fails
   * its job as `driver-not-admitted` before any process exists.
   */
  imageAdapter(
    instance: OutsideImageProviderInstance,
    ports: OutsideImageJobPorts,
    onProviderResponse: () => void,
  ): ImageGenerationAdapter {
    return {
      generate: async (request) => {
        if (String(request.instanceId) !== String(instance.id)) {
          return {
            status: "failed",
            providerFailure: failure(
              "invalid-configuration",
              "Provider instance does not match driver.",
            ),
          };
        }
        let running: RunningProxy;
        try {
          running = await this.#ensure(instance);
        } catch (error) {
          return { status: "failed", providerFailure: asFailure(error) };
        }
        if (running.family !== "image") {
          return { status: "failed", providerFailure: notAdmitted() };
        }
        return running.adapter.generate(request, ports, onProviderResponse);
      },
    };
  }

  /**
   * The adapter the video job service runs for one outside video profile. Its
   * models are the package's declaration, answered without a process; its
   * process starts at the profile's first clip, or when a restart resumes one.
   *
   * A clip outlives the moment it was asked for, so every call asks again
   * whether the profile is still the one the clip was started on: on, bound to
   * the same driver and address, and admitted. When it is not, nothing more is
   * sent, and a clip the provider already accepted is counted as billed,
   * because no one can say any longer how it ended.
   */
  videoAdapter(
    instance: OutsideVideoProviderInstance,
    current: () => ProviderInstance | undefined,
    ports: OutsideVideoClipPorts,
    sends: OutsideVideoSends,
  ): VideoGenerationAdapter {
    const binding = JSON.stringify(instance.configuration);
    const driver = async () => {
      const now = current();
      if (
        now === undefined ||
        now.driverKind !== "outside-video" ||
        !now.enabled ||
        JSON.stringify(now.configuration) !== binding
      ) {
        throw notAdmitted();
      }
      const running = await this.#ensure(now);
      if (running.family !== "video") throw notAdmitted();
      return running.adapter;
    };
    const ended = (error: unknown) => {
      const providerFailure = asFailure(error);
      // A process that could not start says nothing about the clip; a driver
      // no longer admitted will never answer for it.
      return providerFailure.reason === "driver-not-admitted"
        ? ({ status: "failed", providerFailure, billed: true } as const)
        : ({ status: "failed", providerFailure } as const);
    };
    return {
      models: async () => {
        const listed = new Set(instance.configuration.modelAllowlist.map(String));
        return (this.videoDriverModels(instance.configuration.driver) ?? []).filter((model) =>
          listed.has(String(model.modelId)),
        );
      },
      start: async (request) => {
        sends.reached(request.signal);
        try {
          return await (await driver()).start(request, sends);
        } catch (error) {
          return { status: "failed", providerFailure: asFailure(error), notStarted: true };
        }
      },
      poll: async (remoteId, signal) => {
        try {
          return await (await driver()).poll(remoteId, signal, ports);
        } catch (error) {
          return ended(error);
        }
      },
      cancel: async (remoteId, signal) => {
        try {
          return await (await driver()).cancel(remoteId, signal, ports);
        } catch (error) {
          return ended(error);
        }
      },
      forget: async (remoteId) => {
        try {
          return await (await driver()).forget(remoteId);
        } catch (error) {
          return { status: "failed", providerFailure: asFailure(error) };
        }
      },
    };
  }

  /** Stops one instance's driver process, if it has one, and removes its temporary folder. */
  async stop(instanceId: ProviderInstanceId): Promise<void> {
    const key = String(instanceId);
    const running = this.#running.get(key);
    if (running !== undefined) this.#end(key, running);
    await this.#processes.stop(instanceId);
  }

  /**
   * Stops the process of every instance that is gone, turned off, bound to
   * another configuration, or whose driver is no longer effective: an
   * uninstall, a rollback, withdrawn trust, or a switch turned off.
   */
  async reconcile(instances: ReadonlyArray<ProviderInstance>): Promise<void> {
    const byId = new Map(instances.map((instance) => [String(instance.id), instance]));
    await this.#stopWhere((running) => {
      const instance = byId.get(String(running.instanceId));
      return !(
        instance !== undefined &&
        isOutsideDriverProviderInstance(instance) &&
        instance.enabled &&
        JSON.stringify(instance.configuration) === running.binding &&
        this.isAdmitted(instance)
      );
    });
  }

  /** Stops every process of one package's instances, before the package is drained. */
  async stopPackage(extensionId: string): Promise<void> {
    await this.#stopWhere((running) => running.extensionId === extensionId);
  }

  async #stopWhere(stale: (running: RunningDriver) => boolean): Promise<void> {
    const ending = [...this.#running.entries()].filter(([, running]) => stale(running));
    await Promise.all(
      ending.map(([key, running]) => {
        this.#end(key, running);
        return this.#processes.stop(running.instanceId);
      }),
    );
  }

  #ensure(instance: OutsideDriverProviderInstance): Promise<RunningProxy> {
    const key = String(instance.id);
    const binding = JSON.stringify(instance.configuration);
    const existing = this.#running.get(key);
    // Strict can turn on while a process runs, and no instance change follows
    // to reconcile it, so every use asks again and ends a driver now refused.
    if (!this.isAdmitted(instance)) {
      if (existing !== undefined) {
        this.#end(key, existing);
        void this.#processes.stop(instance.id).catch(() => undefined);
      }
      return Promise.reject(notAdmitted());
    }
    if (existing?.proxy !== undefined && existing.binding === binding && !existing.ended) {
      return existing.proxy;
    }
    if (existing !== undefined) this.#end(key, existing);
    const running: RunningDriver = {
      instanceId: instance.id,
      extensionId: String(instance.configuration.driver.extensionId),
      binding,
      proxy: undefined,
      live: undefined,
      channel: undefined,
      close: undefined,
      unsubscribe: undefined,
      ended: false,
    };
    // Claimed before the first await, so concurrent first uses share one start.
    this.#running.set(key, running);
    const proxy = this.#start(instance, running);
    running.proxy = proxy;
    proxy.catch(() => this.#forget(key, running));
    return proxy;
  }

  async #start(
    instance: OutsideDriverProviderInstance,
    running: RunningDriver,
  ): Promise<RunningProxy> {
    // Decided again before any folder or process exists.
    if (!this.isAdmitted(instance)) throw notAdmitted();
    const driver = instance.configuration.driver;
    const located = await this.#entry(driver);
    if (located === undefined) throw notAdmitted();
    // Strict can turn on, or trust be withdrawn, while the files are read;
    // no instance change follows a Strict change, so decide once more with
    // the values as they are now, before the process exists.
    if (!this.isAdmitted(instance)) throw notAdmitted();
    if (running.ended) throw refusalFailure("start-failed");
    const started = await this.#processes.start({
      instanceId: instance.id,
      driver,
      packageRoot: located.packageRoot,
      entryPoint: located.entryPoint,
    });
    if (started.status === "refused") throw refusalFailure(started.reason);
    const key = String(instance.id);
    const channel = started.channel;
    // The proxy hears the channel close when the process exits and also when
    // the host ends it, so a call in flight fails at once rather than at its
    // deadline. Either way the next use starts a fresh process.
    const closedListeners: Array<() => void> = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.#forget(key, running);
      for (const listener of closedListeners) listener();
    };
    channel.onClosed(close);
    const owned: OutsideDriverChannel = {
      write: (line) => channel.write(line),
      onLine: (listener) => channel.onLine(listener),
      onClosed: (listener) => {
        if (closed) queueMicrotask(listener);
        else closedListeners.push(listener);
      },
      stop: () => {
        this.#forget(key, running);
        channel.stop();
      },
    };
    running.channel = owned;
    running.close = close;
    if (running.ended) {
      owned.stop();
      throw refusalFailure("start-failed");
    }
    const shared = {
      instanceId: instance.id,
      channel: owned,
      baseUrl: instance.configuration.baseUrl,
      key: instance.configuration.key,
      ...(this.#credentialResolver === undefined
        ? {}
        : { credentialResolver: this.#credentialResolver }),
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      ...(this.#limits === undefined ? {} : { limits: this.#limits }),
    };
    let proxy: RunningProxy;
    if (instance.driverKind === "outside-image") {
      proxy = {
        family: "image",
        adapter: makeOutsideImageGenerationProxy({
          ...shared,
          modelIds: instance.configuration.modelAllowlist,
          ...(this.#resolve === undefined ? {} : { resolve: this.#resolve }),
        }),
      };
    } else if (instance.driverKind === "outside-video") {
      proxy = {
        family: "video",
        adapter: makeOutsideVideoGenerationProxy({
          ...shared,
          modelIds: instance.configuration.modelAllowlist,
          ...(this.#resolve === undefined ? {} : { resolve: this.#resolve }),
        }),
      };
    } else {
      const driver = makeOutsideHarnessEndpointProxy({
        ...shared,
        modelIds: instance.configuration.modelIds,
        runtimeRegistry: this.#registry,
        ...(this.#clock === undefined ? {} : { clock: this.#clock }),
      });
      running.live = driver;
      proxy = { family: "harness-endpoint", driver };
    }
    // Turning the instance off or removing it invalidates its runtime, which
    // drains this process. The registry has just cleared the observation, and
    // a driver that was stopped on purpose leaves none of its own.
    running.unsubscribe = this.#registry.onRuntimeInvalidated(instance.id, () => {
      void this.stop(instance.id);
      this.#registry.clearObservedState(instance.id);
    });
    return proxy;
  }

  #end(key: string, running: RunningDriver): void {
    running.ended = true;
    this.#forget(key, running);
    running.close?.();
    running.channel?.stop();
  }

  #forget(key: string, running: RunningDriver): void {
    if (this.#running.get(key) === running) this.#running.delete(key);
    running.unsubscribe?.();
    running.unsubscribe = undefined;
  }
}

function activationTarget(driver: OutsideProviderDriverReference): OutsideDriverActivationTarget {
  return {
    extensionId: String(driver.extensionId),
    packageId: String(driver.packageId),
    componentId: String(driver.componentId),
    version: String(driver.version),
    digest: String(driver.digest),
  };
}
