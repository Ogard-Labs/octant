import type {
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { providerCanServeAnyModel } from "@octant/domain";

/**
 * How one configured provider looks to a user completing first run (`BOOT-01`).
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
  /** Runtimes detected on this Mac that are not configured as providers yet. */
  readonly detectedCount: number;
}

export interface FirstRunReadinessInput {
  readonly providerStatus: "loading" | "ready" | "disconnected";
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly discoverySnapshot?: DiscoverySnapshot;
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
  "credential-unavailable":
    "Octant cannot read this provider's stored credential. Unlock the login keychain or sign in again.",
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
 * are different remedies (`BOOT-02`).
 */
export function describeProviderReadiness(
  instance: ProviderInstance,
  observed: ProviderObservedState | undefined,
): FirstRunProviderReadiness {
  const state = resolveProviderState(instance, observed);
  const hostMessage = observed?.message;
  return {
    instanceId: instance.id,
    displayName: instance.displayName,
    state,
    label: LABELS[state],
    detail: state === "ready" || hostMessage === undefined ? DETAILS[state] : hostMessage,
  };
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
    return { readiness: describeProviderReadiness(instance, observed), observed };
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
  const detectedCount = (input.discoverySnapshot?.candidates ?? []).filter(
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
  if (providers.length === 0) {
    return {
      ...base,
      overall: "none-configured",
      headline: "No provider is configured",
      detail:
        detectedCount > 0
          ? `Octant detected ${detectedCount} installed runtime${
              detectedCount === 1 ? "" : "s"
            } on this Mac. Enable one in provider settings to send a message.`
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

export interface FirstRunDiscoveryInput {
  readonly scanning: boolean;
  readonly snapshot?: DiscoverySnapshot;
  readonly message?: string;
}

/**
 * Report an incomplete provider scan honestly.
 *
 * A cancelled, partial, or failed scan still produces a candidate list, and
 * presenting that list silently would imply the Mac was fully searched. Each
 * incomplete outcome is named and offered a retry so the user can act on it
 * (`BOOT-02`); none of them changes what the host will let a provider do.
 */
export function describeDiscoveryNotice(
  input: FirstRunDiscoveryInput,
): FirstRunDiscoveryNotice | undefined {
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
  if (input.scanning) {
    return {
      tone: "info",
      message: "Checking this Mac for installed providers…",
      retryable: false,
    };
  }
  return undefined;
}
