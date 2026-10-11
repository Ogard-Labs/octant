import type {
  DiscoveryCandidate,
  DiscoverySnapshot,
  OctantMode,
  ProviderDriverKind,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { isNativeToolRuntimeDriver } from "./modelCatalogPolicy";
import { canAutoDetectDriverKind, requiresManualEndpoint } from "./providerDiscoveryPolicy";
import { isNativeHarnessDriverKind } from "./providerPolicy";

/**
 * How a catalog entry is set up: an agent runtime is found on the host and
 * added from the scan, an endpoint is added with its address under Octant
 * Harness. A later outside driver picks one of these rather than adding a
 * third path the setup does not know.
 */
export type ProviderCatalogSetupKind = "runtime" | "endpoint";

/** What the package says about itself, as the activation ladder holds it. */
export interface ProviderCatalogPackage {
  readonly driverKind: ProviderDriverKind;
  readonly installed: boolean;
  readonly trusted: boolean;
  /** The driver is admitted: installed, trusted, enabled as a plugin, and compatible. */
  readonly available: boolean;
}

/** What Octant already knows about this host, read without starting anything. */
export interface ProviderCatalogHostFacts {
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly probingIds: ReadonlySet<ProviderInstanceId>;
  readonly discovery: DiscoverySnapshot | undefined;
}

/** Whether the runtime is on this host, as far as the last scan can say. */
export type ProviderCatalogPresence =
  | { readonly kind: "detected"; readonly candidate: DiscoveryCandidate }
  | { readonly kind: "not-detected" }
  | { readonly kind: "not-checked" }
  | { readonly kind: "not-applicable" };

export type ProviderCatalogEnabled = "yes" | "no" | "not-added";
export type ProviderCatalogAuthenticated = "yes" | "no" | "not-needed" | "not-checked";
export type ProviderCatalogReady = "yes" | "no" | "checking" | "not-checked";

/**
 * The one next thing setup asks for. Each step names the configured instance
 * it acts on, so setup always continues an existing provider rather than
 * making a second one.
 */
export type ProviderCatalogStep =
  | { readonly kind: "unavailable" }
  | { readonly kind: "check-host" }
  | { readonly kind: "install" }
  | { readonly kind: "add-detected"; readonly candidate: DiscoveryCandidate }
  | { readonly kind: "add-endpoint" }
  | { readonly kind: "turn-on"; readonly instanceId: ProviderInstanceId }
  | { readonly kind: "check-connection"; readonly instanceId: ProviderInstanceId }
  | { readonly kind: "sign-in"; readonly instanceId: ProviderInstanceId }
  | {
      readonly kind: "fix-runtime";
      readonly instanceId: ProviderInstanceId;
      readonly readiness: "unavailable" | "incompatible" | "degraded";
    }
  | { readonly kind: "done"; readonly instanceId: ProviderInstanceId };

/**
 * How a mode can use the driver: every model, the models a connection check
 * reports with tool use, the models a person verifies for tools, or none.
 */
export type ProviderCatalogModeSupport = "yes" | "checked-models" | "verified-models" | "no";

/**
 * Who runs the agent loop: the runtime itself, Octant Harness over the
 * endpoint, nobody (replies only), or no turns at all yet.
 */
export type ProviderCatalogAgentLoop = "runtime" | "octant-harness" | "replies-only" | "none";

export interface ProviderCatalogCapabilities {
  readonly modes: Readonly<Record<OctantMode, ProviderCatalogModeSupport>>;
  readonly agentLoop: ProviderCatalogAgentLoop;
}

export interface ProviderCatalogState {
  readonly driverKind: ProviderDriverKind;
  readonly setup: ProviderCatalogSetupKind;
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly available: boolean;
  readonly presence: ProviderCatalogPresence;
  /** The configured provider setup continues, when there is one. */
  readonly instance: ProviderInstance | undefined;
  /** How many configured providers use this driver. */
  readonly instanceCount: number;
  readonly enabled: ProviderCatalogEnabled;
  readonly authenticated: ProviderCatalogAuthenticated;
  readonly ready: ProviderCatalogReady;
  readonly capabilities: ProviderCatalogCapabilities;
  readonly next: ProviderCatalogStep;
}

/**
 * What a driver can do in each mode, mirroring the gates the host applies to
 * a send: agent runtimes carry Work and Code tools for the models their
 * connection check reports, Octant Harness endpoints only for models a person
 * verified, Ollama replies in Chat until its driver runs the tool loop, and
 * Oh My Pi lists models but refuses to start a session.
 */
export function providerCatalogCapabilities(
  driverKind: ProviderDriverKind,
): ProviderCatalogCapabilities {
  if (isNativeHarnessDriverKind(driverKind)) {
    return {
      modes: { chat: "yes", work: "verified-models", code: "verified-models" },
      agentLoop: "octant-harness",
    };
  }
  if (driverKind === "ollama") {
    return { modes: { chat: "yes", work: "no", code: "no" }, agentLoop: "replies-only" };
  }
  if (isNativeToolRuntimeDriver(driverKind)) {
    return {
      modes: { chat: "yes", work: "checked-models", code: "checked-models" },
      agentLoop: "runtime",
    };
  }
  return { modes: { chat: "no", work: "no", code: "no" }, agentLoop: "none" };
}

export function providerCatalogSetupKind(driverKind: ProviderDriverKind): ProviderCatalogSetupKind {
  return requiresManualEndpoint(driverKind) || driverKind === "ollama" ? "endpoint" : "runtime";
}

function scanCompleted(snapshot: DiscoverySnapshot | undefined): snapshot is DiscoverySnapshot {
  return (
    snapshot !== undefined && (snapshot.status === "completed" || snapshot.status === "partial")
  );
}

/**
 * Presence comes only from the current scan, and only for a driver the scan
 * actually covered: a partial scan that never reached a driver says nothing
 * about it.
 */
function presence(
  driverKind: ProviderDriverKind,
  setup: ProviderCatalogSetupKind,
  snapshot: DiscoverySnapshot | undefined,
): ProviderCatalogPresence {
  // An endpoint is added with its address, never found on the host, so the
  // scan says nothing about it (Ollama included: it is set up as an endpoint).
  if (setup === "endpoint") return { kind: "not-applicable" };
  if (!canAutoDetectDriverKind(driverKind)) return { kind: "not-applicable" };
  if (!scanCompleted(snapshot)) return { kind: "not-checked" };
  const candidate = snapshot.candidates.find((entry) => entry.driverKind === driverKind);
  if (candidate !== undefined) return { kind: "detected", candidate };
  const covered =
    snapshot.status === "completed" ||
    (snapshot.searchedDirectories ?? []).some((entry) => entry.driverKind === driverKind);
  return covered ? { kind: "not-detected" } : { kind: "not-checked" };
}

/**
 * The configured provider setup continues: one that is on and ready, else one
 * that is on, else the first. A driver with several configured providers still
 * has one catalog entry; the others stay on their own cards.
 */
function chooseInstance(
  instances: ReadonlyArray<ProviderInstance>,
  observedByInstance: ProviderCatalogHostFacts["observedByInstance"],
): ProviderInstance | undefined {
  return (
    instances.find(
      (instance) => instance.enabled && observedByInstance.get(instance.id)?.readiness === "ready",
    ) ??
    instances.find((instance) => instance.enabled) ??
    instances[0]
  );
}

function takesNoCredential(instance: ProviderInstance): boolean {
  if (instance.driverKind === "ollama") return true;
  return (
    instance.driverKind === "openai-compatible" && instance.configuration.authentication === "none"
  );
}

function authenticated(
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
  checking: boolean,
): ProviderCatalogAuthenticated {
  if (takesNoCredential(instance)) return "not-needed";
  if (checking || observed === undefined) return "not-checked";
  switch (observed.readiness) {
    case "ready":
    case "degraded":
      return "yes";
    case "unauthenticated":
      return "no";
    default:
      // A runtime the check could not reach never got as far as its sign-in.
      return "not-checked";
  }
}

function ready(
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
  checking: boolean,
): ProviderCatalogReady {
  if (!instance.enabled) return "no";
  if (checking) return "checking";
  if (observed === undefined || observed.readiness === "checking") return "not-checked";
  return observed.readiness === "ready" ? "yes" : "no";
}

/**
 * The catalog's state for one driver: the package facts it repeats, what the
 * host already knows, and the one next step. Pure: it reads the registry, its
 * last observations, and the last scan, and starts nothing.
 */
export function resolveProviderCatalogState(
  pkg: ProviderCatalogPackage,
  host: ProviderCatalogHostFacts,
): ProviderCatalogState {
  const { driverKind } = pkg;
  const setup = providerCatalogSetupKind(driverKind);
  const configured = host.instances.filter((instance) => instance.driverKind === driverKind);
  const instance = chooseInstance(configured, host.observedByInstance);
  const found = presence(driverKind, setup, host.discovery);
  const base = {
    driverKind,
    setup,
    installed: pkg.installed,
    trusted: pkg.trusted,
    available: pkg.available,
    presence: found,
    instance,
    instanceCount: configured.length,
    capabilities: providerCatalogCapabilities(driverKind),
  };
  if (instance === undefined) {
    let next: ProviderCatalogStep;
    if (!pkg.available) next = { kind: "unavailable" };
    else if (found.kind === "detected") next = { kind: "add-detected", candidate: found.candidate };
    else if (setup === "endpoint") next = { kind: "add-endpoint" };
    else if (found.kind === "not-checked") next = { kind: "check-host" };
    else next = { kind: "install" };
    return {
      ...base,
      enabled: "not-added",
      authenticated: "not-checked",
      ready: "not-checked",
      next,
    };
  }
  const observed = host.observedByInstance.get(instance.id);
  const checking = host.probingIds.has(instance.id);
  const state = {
    ...base,
    enabled: instance.enabled ? ("yes" as const) : ("no" as const),
    authenticated: authenticated(instance, observed, checking),
    ready: ready(instance, observed, checking),
  };
  return { ...state, next: nextStep(pkg.available, instance, observed, state) };
}

function nextStep(
  available: boolean,
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
  state: Pick<ProviderCatalogState, "authenticated" | "ready">,
): ProviderCatalogStep {
  const instanceId = instance.id;
  if (!available) return { kind: "unavailable" };
  if (!instance.enabled) return { kind: "turn-on", instanceId };
  if (state.ready === "yes") return { kind: "done", instanceId };
  if (state.authenticated === "no") return { kind: "sign-in", instanceId };
  const readiness = observed?.readiness;
  if (
    state.ready !== "checking" &&
    (readiness === "unavailable" || readiness === "incompatible" || readiness === "degraded")
  ) {
    return { kind: "fix-runtime", instanceId, readiness };
  }
  return { kind: "check-connection", instanceId };
}
