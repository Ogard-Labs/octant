import type {
  HiddenProviderModelRef,
  ProviderInstance,
  ProviderObservedState,
} from "@octant/contracts";
import type { ProviderProbeFailure } from "../../providers/useProviderController";
import type { ModelEndpointDriverKind } from "../../providers/providerSettingsPresentation";

export type ModelEndpointInstance = Extract<
  ProviderInstance,
  { driverKind: ModelEndpointDriverKind }
>;

/**
 * How a row draws its state. Each tone has its own dot shape, so the state
 * never rests on colour: a filled dot is ready, a ring needs you, a dashed
 * ring is off, a turning ring is checking, a muted ring is not checked yet,
 * and a diamond has failed.
 */
export type EndpointTone = "ready" | "needs-you" | "checking" | "unchecked" | "failed" | "off";

/** The one action a row offers to get an endpoint working again. */
export type EndpointFixKind =
  | "sign-in"
  | "sign-in-again"
  | "try-again"
  | "check-now"
  | "replace-key"
  | "add-key"
  | "edit-address"
  | "add-model-ids";

export interface EndpointStatus {
  readonly tone: EndpointTone;
  readonly label: string;
  /** What happened and what to do, in one or two plain sentences. */
  readonly sentence?: string;
  readonly fix?: { readonly kind: EndpointFixKind; readonly label: string };
}

/** What the host last said about the endpoint's sign-in; absent for keyed endpoints. */
export type EndpointSignIn =
  | { readonly kind: "signed-in"; readonly accountLabel: string }
  | { readonly kind: "signed-out"; readonly termsRequired: boolean }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" };

export interface EndpointStatusInput {
  readonly instance: ModelEndpointInstance;
  readonly observed: ProviderObservedState | undefined;
  readonly checking: boolean;
  readonly failure?: ProviderProbeFailure;
  /** Present only for an endpoint a subscription sign-in holds. */
  readonly signIn?: EndpointSignIn;
  /** The offer's own words, such as "ChatGPT plan" and "Sign in with ChatGPT". */
  readonly signInOffer?: { readonly accountLabel: string; readonly action: string };
  /**
   * Whether a key can be entered from here. A browser cannot store one, so a
   * missing key there is added in the desktop app rather than by a fix.
   */
  readonly keysHere?: boolean;
}

/**
 * The host stores some failed checks only as a generic observation; these are
 * its fixed wordings. Matching them is presentation only: the row then says
 * that the last check failed rather than claiming the endpoint has no models.
 * A stored failure reason would replace this (see the harness design notes).
 */
const GENERIC_DEGRADED_MESSAGE = "Provider probe failed.";
const GENERIC_INCOMPATIBLE_MESSAGE = "Provider configuration is incompatible.";

/**
 * A row's state in words, with at most one fix. Precise terms (protocol,
 * bearer, capability names) stay in the detail page's Diagnostics; the row
 * says what happened and what to do.
 */
export function endpointStatus(input: EndpointStatusInput): EndpointStatus {
  const { instance, observed, failure } = input;
  if (!instance.enabled) return { tone: "off", label: "Off" };
  if (input.checking || observed?.readiness === "checking") {
    return { tone: "checking", label: "Checking…" };
  }
  const offer = input.signInOffer;
  if (offer !== undefined) {
    if (input.signIn?.kind === "expired") return signedOut(offer);
    if (input.signIn?.kind === "signed-out") return signInToUse(offer);
  }
  if (failure !== undefined) return failureStatus(input, failure);
  if (observed === undefined) {
    return {
      tone: "unchecked",
      label: "Not checked yet",
      fix: { kind: "check-now", label: "Check now" },
    };
  }
  switch (observed.readiness) {
    case "ready":
      return { tone: "ready", label: "Ready" };
    case "degraded":
      if (observed.models.length > 0) return { tone: "ready", label: "Ready" };
      if (observed.message === GENERIC_DEGRADED_MESSAGE) {
        return {
          tone: "failed",
          label: "Not working",
          sentence: "The last check failed. Check again to see why.",
          fix: { kind: "try-again", label: "Try again" },
        };
      }
      return noModels(observed.message);
    case "unauthenticated":
      if (offer !== undefined) return refusedSignIn(input, offer);
      // A browser cannot read the Keychain, so after a reload it cannot tell a
      // missing key from a refused one; it sends both to the desktop app,
      // which is where either is fixed.
      return observed.credentialStatus === "missing" || input.keysHere === false
        ? keyNeeded(input)
        : keyRefused();
    case "unavailable":
      return cannotConnect(`The last check couldn't reach ${endpointHost(instance)}.`);
    case "incompatible":
      return notWorking(
        observed.message === undefined || observed.message === GENERIC_INCOMPATIBLE_MESSAGE
          ? "The address answered in a way Octant can't use. Check the address and the kind of endpoint."
          : observed.message,
      );
    default:
      return { tone: "unchecked", label: "Not checked yet" };
  }
}

function failureStatus(input: EndpointStatusInput, failure: ProviderProbeFailure): EndpointStatus {
  const host = endpointHost(input.instance);
  const message = failure.message;
  if (failure.reason === "no-usable-model") {
    return noModels(undefined);
  }
  if (
    failure.category === "unauthenticated" ||
    failure.category === "unauthorized" ||
    failure.reason === "authentication-required"
  ) {
    if (input.signInOffer !== undefined) return refusedSignIn(input, input.signInOffer);
    if (/missing or unavailable/i.test(message)) return keyNeeded(input);
    return keyRefused();
  }
  if (
    failure.category === "unavailable" ||
    failure.category === "interrupted" ||
    failure.category === "rate-limited" ||
    failure.reason === "runtime-unavailable"
  ) {
    if (failure.category === "rate-limited") {
      return cannotConnect("The service is limiting requests right now. Try again in a moment.");
    }
    const status = /HTTP (\d{3})/.exec(message)?.[1];
    if (status !== undefined) {
      return cannotConnect(`The server is busy or down (HTTP ${status}). Try again in a moment.`);
    }
    if (/timed out/i.test(message)) return cannotConnect(`${host} didn't answer in time.`);
    return cannotConnect(
      input.instance.driverKind === "ollama"
        ? `Nothing answered at ${host}. Is Ollama running?`
        : `Nothing answered at ${host}.`,
    );
  }
  if (/invalid models response/i.test(message)) {
    return notWorking(
      "The address replied, but not with a list of models. Check the address; it usually ends in /v1.",
    );
  }
  if (/redirect/i.test(message)) {
    return notWorking("The address sends requests somewhere else. Use the address it points to.");
  }
  if (/does not support this endpoint/i.test(message)) {
    return notWorking(
      "The address doesn't offer this kind of API. Check the address and the kind.",
    );
  }
  // Every other failure the probe command names is one of the host's own
  // fixed sentences, so it is shown as the host wrote it.
  return notWorking(message);
}

/**
 * A sign-in endpoint the host turned away. Only a sign-in the host still
 * reports as held reads as signed out; otherwise Octant can't tell an expired
 * sign-in from one that never happened, so it asks for a sign-in.
 */
function refusedSignIn(
  input: EndpointStatusInput,
  offer: { readonly accountLabel: string; readonly action: string },
): EndpointStatus {
  return input.signIn?.kind === "signed-in" ? signedOut(offer) : signInToUse(offer);
}

function signInToUse(offer: { readonly action: string }): EndpointStatus {
  return {
    tone: "needs-you",
    label: "Sign in to use",
    fix: { kind: "sign-in", label: offer.action },
  };
}

function signedOut(offer: { readonly accountLabel: string; readonly action: string }) {
  return {
    tone: "needs-you",
    label: "Signed out",
    sentence: `Your ${offer.accountLabel} sign-in expired. Sign in again to keep using it.`,
    fix: { kind: "sign-in-again", label: "Sign in again" },
  } as const satisfies EndpointStatus;
}

/** The label of an endpoint that has no key saved, which other steps can recognise. */
export const NEEDS_KEY_LABEL = "Needs key";

function keyNeeded(input: EndpointStatusInput): EndpointStatus {
  if (input.keysHere === false) {
    return {
      tone: "needs-you",
      label: NEEDS_KEY_LABEL,
      sentence: "Add its API key in the Octant desktop app on this Mac.",
    };
  }
  return {
    tone: "needs-you",
    label: NEEDS_KEY_LABEL,
    sentence: "No API key is saved for it.",
    fix: { kind: "add-key", label: "Add key" },
  };
}

function keyRefused(): EndpointStatus {
  return {
    tone: "failed",
    label: "Key refused",
    sentence: "The service turned down the API key.",
    fix: { kind: "replace-key", label: "Replace key" },
  };
}

function cannotConnect(sentence: string): EndpointStatus {
  return {
    tone: "failed",
    label: "Can't connect",
    sentence,
    fix: { kind: "try-again", label: "Try again" },
  };
}

function notWorking(sentence: string): EndpointStatus {
  return {
    tone: "failed",
    label: "Not working",
    sentence,
    fix: { kind: "edit-address", label: "Edit address" },
  };
}

function noModels(message: string | undefined): EndpointStatus {
  return {
    tone: "needs-you",
    label: "No models yet",
    sentence: message ?? "Connected, but it lists no models. Add the model IDs you use.",
    fix: { kind: "add-model-ids", label: "Add model IDs" },
  };
}

/** The host and port an endpoint's address names, or the address itself when it cannot be read. */
export function endpointHost(instance: ModelEndpointInstance): string {
  const baseUrl = instance.configuration.baseUrl;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Whether the endpoint sends a key at all; one that sends none has no key line anywhere. */
export function endpointTakesKey(instance: ModelEndpointInstance): boolean {
  if (instance.driverKind === "ollama") return false;
  if (instance.driverKind === "azure-foundry") return true;
  return instance.configuration.authentication !== "none";
}

/** The line under a row's name: who is signed in, or where it is and whether it sends a key. */
export function endpointSubLine(
  instance: ModelEndpointInstance,
  signIn: EndpointSignIn | undefined,
  offer: { readonly accountLabel: string } | undefined,
): string {
  if (offer !== undefined) {
    return signIn?.kind === "signed-in"
      ? `Signed in as ${signIn.accountLabel}`
      : `${offer.accountLabel} · not signed in`;
  }
  const host = endpointHost(instance);
  if (instance.driverKind === "ollama") return `Ollama · ${host}`;
  return `${host} · ${endpointTakesKey(instance) ? "API key" : "No key"}`;
}

/** "6 models", or "12 of 63 shown" once some are hidden from the model picker. */
export function endpointModelCount(
  instance: ModelEndpointInstance,
  observed: ProviderObservedState | undefined,
  hiddenModels: ReadonlyArray<HiddenProviderModelRef>,
): string | undefined {
  if (observed === undefined || observed.models.length === 0) return undefined;
  const total = observed.models.length;
  const hidden = new Set(
    hiddenModels
      .filter((ref) => String(ref.providerInstanceId) === String(instance.id))
      .map((ref) => String(ref.modelId)),
  );
  const shown = observed.models.filter((model) => !hidden.has(String(model.id))).length;
  if (shown === total) return `${total} ${total === 1 ? "model" : "models"}`;
  return `${shown} of ${total} shown`;
}
