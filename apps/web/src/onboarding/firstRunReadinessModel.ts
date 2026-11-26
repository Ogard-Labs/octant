import type {
  DiscoverySnapshot,
  HostPlatform,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { providerCanServeAnyModel } from "@octant/domain";
import { thisComputerName } from "../platform";
import {
  isAbsenceProven,
  isDetectedLocally,
  providerBinaryPath,
} from "../providers/providerSettingsPresentation";

/**
 * How one configured provider looks to a user completing first run.
 *
 * The states are deliberately finer than {@link ProviderObservedState.readiness}
 * because first run has to answer a different question: not "what did the last
 * probe report" but "can this provider answer a message right now, and if not,
 * what do I do about it". `unverified` exists so an instance Octant has never
 * probed is reported as unknown rather than folded into either ready or broken.
 */
export type FirstRunProviderState =
  | "ready"
  | "no-models"
  | "authentication-required"
  | "credential-unavailable"
  | "unreachable"
  | "incompatible"
  | "degraded"
  | "checking"
  | "unverified"
  | "disabled";

/**
 * Whether a turned-off provider's runtime is on the host. `unknown` covers a
 * provider with nothing to install (an endpoint or a key) and a scan that did
 * not look where the runtime was saved: neither supports "Not installed".
 */
export type FirstRunProviderInstallation = "installed" | "not-installed" | "unknown";

export interface FirstRunProviderReadiness {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly driverKind: ProviderInstance["driverKind"];
  readonly state: FirstRunProviderState;
  /** The row's one state line: words, so status never depends on colour. */
  readonly label: string;
  /** Enabled and able to answer a message now. */
  readonly usable: boolean;
}

export type FirstRunReadinessOverall =
  | "checking"
  | "authority-unavailable"
  | "none-configured"
  | "ready"
  | "action-required";

export interface FirstRunReadinessSummary {
  readonly overall: FirstRunReadinessOverall;
  readonly headline: string;
  readonly detail: string;
  /** Usable providers first, then installed ones that are off, then the rest. */
  readonly providers: ReadonlyArray<FirstRunProviderReadiness>;
  readonly readyCount: number;
  /**
   * Providers Chat could answer with right now. Never smaller than
   * `readyCount`: it also counts a degraded provider that still reports models,
   * which Chat accepts (see {@link providerCanServeAnyModel}).
   */
  readonly usableCount: number;
  /** Runtimes detected on the host that are not configured as providers yet. */
  readonly detectedCount: number;
}

export interface FirstRunReadinessInput {
  readonly providerStatus: "loading" | "ready" | "disconnected";
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  /**
   * What the host's search of its computer has produced so far. Required,
   * because an empty registry means "nothing is configured" only once that
   * search has answered; before then it means the search has not run yet.
   */
  readonly discovery: FirstRunDiscoveryInput;
  /** The platform the host reports, which names the computer it searched. */
  readonly hostPlatform?: HostPlatform | undefined;
}

export interface FirstRunDiscoveryInput {
  readonly scanning: boolean;
  readonly snapshot?: DiscoverySnapshot;
  readonly message?: string;
}

/**
 * How far the host has got in searching its computer for installed providers.
 *
 * `searched` is deliberately narrow: only a scan that ran to completion has
 * answered. A cancelled, partial, or failed scan looked at some of the
 * computer and stopped, so it cannot support a claim about what is not
 * installed.
 */
export type FirstRunDiscoveryProgress = "unsearched" | "scanning" | "searched";

export function describeFirstRunDiscoveryProgress(
  input: FirstRunDiscoveryInput,
): FirstRunDiscoveryProgress {
  if (input.scanning) return "scanning";
  if (input.message !== undefined) return "unsearched";
  return input.snapshot?.status === "completed" ? "searched" : "unsearched";
}

const LABELS: Record<Exclude<FirstRunProviderState, "disabled">, string> = {
  ready: "Ready",
  "no-models": "No models",
  "authentication-required": "Sign-in required",
  "credential-unavailable": "Credential unavailable",
  unreachable: "Unreachable",
  incompatible: "Incompatible",
  degraded: "Degraded",
  checking: "Checking",
  unverified: "Not checked",
};

const OFF_LABELS: Record<FirstRunProviderInstallation, string> = {
  installed: "Installed · off",
  "not-installed": "Not installed",
  unknown: "Off",
};

/**
 * Describe one configured provider without guessing.
 *
 * An instance with no observed state has never been probed by the host, so it
 * is reported as unchecked rather than optimistically ready; a stored
 * credential Octant cannot read is reported as unavailable rather than as a
 * plain sign-in prompt, because unlocking the keychain and re-authenticating
 * are different remedies.
 */
function describeProviderReadiness(
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
  installation: FirstRunProviderInstallation,
): FirstRunProviderReadiness {
  const state = resolveProviderState(instance, observed);
  return {
    instanceId: instance.id,
    displayName: instance.displayName,
    driverKind: instance.driverKind,
    state,
    label: state === "disabled" ? OFF_LABELS[installation] : LABELS[state],
    // Chat answers with a degraded provider whose models are still reported.
    usable:
      state === "ready" ||
      (state === "degraded" && observed !== undefined && providerCanServeAnyModel(observed)),
  };
}

function resolveInstallation(
  instance: ProviderInstance,
  snapshot: DiscoverySnapshot | undefined,
): FirstRunProviderInstallation {
  if (isDetectedLocally(instance, snapshot)) return "installed";
  const binaryPath = providerBinaryPath(instance);
  return binaryPath !== undefined && isAbsenceProven(binaryPath, instance.driverKind, snapshot)
    ? "not-installed"
    : "unknown";
}

function resolveProviderState(
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
): FirstRunProviderState {
  if (!instance.enabled) return "disabled";
  if (observed === undefined) return "unverified";
  if (observed.credentialStatus === "unavailable") return "credential-unavailable";
  switch (observed.readiness) {
    case "ready":
      return observed.models.length === 0 ? "no-models" : "ready";
    case "unauthenticated":
      return "authentication-required";
    case "unavailable":
      return "unreachable";
    case "incompatible":
      return "incompatible";
    case "degraded":
      return "degraded";
    case "checking":
      return "checking";
  }
}

/** "Claude Code is ready", or the count and every name. */
function readyHeadline(
  usable: ReadonlyArray<FirstRunProviderReadiness>,
  allReady: boolean,
): string {
  const names = new Intl.ListFormat("en-US").format(usable.map((provider) => provider.displayName));
  if (usable.length === 1) return `${names} ${allReady ? "is ready" : "can answer"}`;
  return `${String(usable.length)} providers ${allReady ? "are ready" : "can answer"}: ${names}`;
}

/**
 * Where a provider sits in the list: the ones that work, then the ones one
 * switch away, then everything else, with a provider the person turned on that
 * needs attention ahead of those that are off or missing.
 */
function listRank(entry: {
  readonly readiness: FirstRunProviderReadiness;
  readonly installation: FirstRunProviderInstallation;
}): number {
  if (entry.readiness.usable) return 0;
  if (entry.readiness.state !== "disabled") return 2;
  return entry.installation === "installed" ? 1 : 3;
}

/**
 * Summarize provider readiness for the first-run surface.
 *
 * The renderer never decides readiness: every entry comes from the host's
 * projected registry and its observed states. When the registry itself is
 * unreachable the summary says so instead of falling back to "nothing
 * configured", because those are different facts and only one of them is the
 * user's to fix.
 */
export function summarizeFirstRunReadiness(
  input: FirstRunReadinessInput,
): FirstRunReadinessSummary {
  // Observations are only as current as the registry they came from. While it
  // is loading or unreachable, no row may claim what the summary says is unknown.
  const registryRead = input.providerStatus === "ready";
  const providers = input.instances
    .map((instance) => {
      const installation = resolveInstallation(instance, input.discovery.snapshot);
      const observed = registryRead ? input.observedByInstance.get(instance.id) : undefined;
      return {
        readiness: describeProviderReadiness(instance, observed, installation),
        installation,
      };
    })
    .sort((left, right) => listRank(left) - listRank(right))
    .map((entry) => entry.readiness);
  const readyCount = providers.filter((provider) => provider.state === "ready").length;
  // A degraded provider that still answers counts, so first run never tells
  // that user the app cannot work; its row keeps saying "Degraded".
  const usable = providers.filter((provider) => provider.usable);
  const usableCount = usable.length;
  // Discovery reports families Octant cannot configure yet, so compare as
  // plain strings rather than narrowing to the configurable driver union.
  const configuredDriverKinds = new Set<string>(
    input.instances.map((instance) => instance.driverKind),
  );
  const detectedCount = (input.discovery.snapshot?.candidates ?? []).filter(
    (candidate) => !configuredDriverKinds.has(candidate.driverKind),
  ).length;
  const base = { providers, readyCount, usableCount, detectedCount } as const;

  if (input.providerStatus === "disconnected") {
    return {
      ...base,
      overall: "authority-unavailable",
      headline: "Provider readiness is unavailable",
      detail:
        "Octant could not reach its own provider registry, so it cannot say which providers are ready. Nothing is assumed ready.",
    };
  }
  if (input.providerStatus === "loading") {
    return {
      ...base,
      overall: "checking",
      headline: "Checking provider readiness",
      detail: "Octant is reading the host's provider registry.",
    };
  }
  if (usableCount > 0) {
    return {
      ...base,
      overall: "ready",
      headline: readyHeadline(usable, usableCount === readyCount),
      detail:
        usableCount === readyCount
          ? "You can start a Chat message now."
          : "You can start a Chat message now. A provider marked degraded still answers, with reduced capability.",
    };
  }
  const computer = thisComputerName(input.hostPlatform);
  if (providers.length === 0) {
    // Discovery, not the registry, is what knows whether the host has a
    // provider on it. Until it has answered, an empty registry is a missing
    // answer, and first run names it as one rather than converting it into
    // "nothing is configured".
    const progress = describeFirstRunDiscoveryProgress(input.discovery);
    if (progress !== "searched") {
      return {
        ...base,
        overall: "checking",
        headline: `Octant has not finished checking ${computer}`,
        detail:
          progress === "scanning"
            ? `The search for installed providers is still running. Octant claims nothing about ${computer} until it finishes.`
            : `The search for installed providers has not completed, so Octant cannot say whether one is installed. Check ${computer} again to finish it.`,
      };
    }
    return {
      ...base,
      overall: "none-configured",
      headline: "No provider is configured",
      detail:
        detectedCount > 0
          ? `Octant detected ${detectedCount} installed runtime${
              detectedCount === 1 ? "" : "s"
            } on ${computer}. Enable one in provider settings to send a message.`
          : "Add a provider in settings to send a message. Octant does not configure one for you.",
    };
  }
  return {
    ...base,
    overall: "action-required",
    headline: "No provider is ready yet",
    detail:
      "Every configured provider needs attention before Chat can answer. Each one below says what it needs.",
  };
}

export interface FirstRunDiscoveryNotice {
  readonly tone: "info" | "attention";
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Report an incomplete provider scan honestly.
 *
 * A cancelled, partial, or failed scan still produces a candidate list, and
 * presenting that list silently would imply the host was fully searched. Each
 * incomplete outcome is named and offered a retry so the user can act on it;
 * none of them changes what the host will let a provider do.
 *
 * A running scan is reported first, because the outcome of the scan it
 * replaces is no longer what is happening: leaving the retried outcome up for
 * the whole retry, beside a disabled retry button, reads as a fresh finding.
 */
export function describeDiscoveryNotice(
  input: FirstRunDiscoveryInput,
  hostPlatform: HostPlatform | undefined,
): FirstRunDiscoveryNotice | undefined {
  if (input.scanning) {
    return {
      tone: "info",
      message: `Checking ${thisComputerName(hostPlatform)} for installed providers…`,
      retryable: false,
    };
  }
  if (input.message !== undefined) {
    return { tone: "attention", message: input.message, retryable: true };
  }
  const snapshot = input.snapshot;
  if (snapshot !== undefined && snapshot.status !== "completed") {
    const reason =
      snapshot.status === "cancelled"
        ? "The scan for installed providers was cancelled."
        : snapshot.status === "partial"
          ? "The scan for installed providers finished only partially."
          : "The scan for installed providers failed.";
    return {
      tone: "attention",
      message: `${reason} ${snapshot.message ?? "Some installed providers may be missing from this list."}`,
      retryable: true,
    };
  }
  return undefined;
}
