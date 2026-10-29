import type {
  DiscoverySnapshot,
  HostPlatform,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { providerCanServeAnyModel } from "@octant/domain";
import { thisComputerName } from "../platform";
import { providerWithheldReason } from "../providers/providerSettingsPresentation";

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

export interface FirstRunProviderReadiness {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly state: FirstRunProviderState;
  /** Status word shown beside the icon so status never depends on colour. */
  readonly label: string;
  readonly detail: string;
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

const LABELS: Record<FirstRunProviderState, string> = {
  ready: "Ready",
  "no-models": "No models",
  "authentication-required": "Sign-in required",
  "credential-unavailable": "Credential unavailable",
  unreachable: "Unreachable",
  incompatible: "Incompatible",
  degraded: "Degraded",
  checking: "Checking",
  unverified: "Not checked",
  disabled: "Disabled",
};

const DETAILS: Record<FirstRunProviderState, string> = {
  ready: "Verified by the host and reporting usable models.",
  "no-models": "The host reached this provider, but it offered no usable models.",
  "authentication-required": "This provider must be signed in before it can answer.",
  "credential-unavailable": "Octant cannot read this provider's stored credential.",
  unreachable: "The host could not reach this provider.",
  incompatible: "The installed version of this provider is not supported.",
  degraded: "This provider answered, but reported reduced capability.",
  checking: "The host is still checking this provider.",
  unverified: "The host has not checked this provider yet, so it is not reported as ready.",
  disabled: "Turned off for this host.",
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
export function describeProviderReadiness(
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
  hostPlatform: HostPlatform | undefined,
): FirstRunProviderReadiness {
  const state = resolveProviderState(instance, observed);
  const hostMessage = providerWithheldReason(instance, observed) ?? observed?.message;
  return {
    instanceId: instance.id,
    displayName: instance.displayName,
    state,
    label: LABELS[state],
    detail:
      state === "ready" || hostMessage === undefined
        ? stateDetail(state, hostPlatform)
        : hostMessage,
  };
}

function stateDetail(state: FirstRunProviderState, hostPlatform: HostPlatform | undefined): string {
  if (state !== "credential-unavailable") return DETAILS[state];
  // The remedy is the host's own store: the login keychain on a Mac, the
  // Secret Service collection elsewhere.
  const unlock =
    hostPlatform === "darwin"
      ? "Unlock the login keychain or sign in again."
      : `Unlock ${thisComputerName(hostPlatform)}'s credential store or sign in again.`;
  return `${DETAILS[state]} ${unlock}`;
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
  const described = input.instances.map((instance) => {
    const observed = input.observedByInstance.get(instance.id);
    return {
      readiness: describeProviderReadiness(instance, observed, input.hostPlatform),
      observed,
    };
  });
  const providers = described.map((entry) => entry.readiness);
  const readyCount = providers.filter((provider) => provider.state === "ready").length;
  // Chat answers with a degraded provider whose models are still reported, so
  // first run must not tell that user the app cannot work. The per-provider row
  // keeps saying "Degraded", because reduced capability is still worth knowing.
  const usableCount = described.filter(
    (entry) =>
      entry.readiness.state === "ready" ||
      (entry.readiness.state === "degraded" &&
        entry.observed !== undefined &&
        providerCanServeAnyModel(entry.observed)),
  ).length;
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
      headline:
        usableCount === readyCount
          ? `${readyCount} provider${readyCount === 1 ? " is" : "s are"} ready`
          : `${usableCount} provider${usableCount === 1 ? "" : "s"} can answer`,
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
