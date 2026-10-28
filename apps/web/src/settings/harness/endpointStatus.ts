import type {
  HiddenProviderModelRef,
  HostPlatform,
  ProviderInstance,
  ProviderObservedState,
} from "@octant/contracts";
import { amazonBedrockRuntimeHost } from "@octant/domain";
import { thisComputerName } from "../../platform";
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
  /**
   * The endpoint's Sign-in section already says what to do (an Amazon
   * Bedrock endpoint not yet signed in), so the detail page adds no alert.
   */
  readonly guidedBySignIn?: true;
}

/** What the host last said about the endpoint's sign-in; absent for keyed endpoints. */
export type EndpointSignIn =
  | { readonly kind: "signed-in"; readonly accountLabel: string }
  | { readonly kind: "signed-out"; readonly termsRequired: boolean }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" }
  | { readonly kind: "checking" }
  | { readonly kind: "linking" };

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
  /** The platform the host reports, which names the computer a key is added on. */
  readonly hostPlatform?: HostPlatform | undefined;
  /**
   * The host's credential store has no key for it and no check has run since,
   * as after an address change deleted the key. The endpoint then reads as
   * needing its key rather than as not checked, since a check would only say so.
   */
  readonly keyMissing?: boolean;
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
    if ((input.signIn === undefined && observed === undefined) || input.signIn?.kind === "checking")
      return { tone: "checking", label: "Checking sign-in…" };
    if (input.signIn?.kind === "linking") return { tone: "checking", label: "Signing in…" };
    if (input.signIn?.kind === "unknown")
      return {
        tone: "unchecked",
        label: "Sign-in not checked",
        sentence: "Open Sign-in to check your account.",
      };
    if (input.signIn?.kind === "expired") return signedOut(offer);
    if (input.signIn?.kind === "signed-out") return signInToUse(offer);
  }
  if (isDirectorySignInEndpoint(instance)) {
    const signedIn = directorySignInStatus(instance, observed, failure);
    if (signedIn !== undefined) return signedIn;
  }
  if (instance.driverKind === "amazon-bedrock") {
    const signedIn = cloudSignInStatus(instance, input.hostPlatform, observed, failure);
    if (signedIn !== undefined) return signedIn;
  }
  if (failure !== undefined) return failureStatus(input, failure);
  if (observed === undefined && input.keyMissing === true && endpointTakesKey(instance)) {
    return keyNeeded(input);
  }
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
      sentence: `Add its API key in the Octant desktop app on ${thisComputerName(input.hostPlatform)}.`,
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
  // Amazon Bedrock's address is built from its region alone.
  if (instance.driverKind === "amazon-bedrock") {
    return amazonBedrockRuntimeHost(instance.configuration.region);
  }
  const baseUrl = instance.configuration.baseUrl;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Whether the endpoint signs in with an organization account in place of a
 * key: Azure AI Foundry with its directory, or a gateway with its
 * organization's own sign-in.
 */
export function isDirectorySignInEndpoint(instance: ModelEndpointInstance): boolean {
  return (
    instance.driverKind !== "ollama" && instance.configuration.authentication === "directory-oauth"
  );
}

/**
 * An organization sign-in's state from the host's own reason, so a sign-in
 * the organization wants repeated in person, one that ended, and an account
 * without a role on the resource each say what to do. Undefined leaves the
 * ordinary reading (ready, cannot connect, no models) in place.
 */
function directorySignInStatus(
  instance: ModelEndpointInstance,
  observed: ProviderObservedState | undefined,
  failure: ProviderProbeFailure | undefined,
): EndpointStatus | undefined {
  const foundry = instance.driverKind === "azure-foundry";
  if (observed?.readiness === "incompatible" && observed.directoryBinding !== undefined) {
    return {
      tone: "needs-you",
      label: "Sign-in doesn't match",
      sentence: foundry
        ? "The organization sign-in is for another tenant, app, or address. Sign in again for this endpoint."
        : "The organization sign-in is for another issuer, client, scope, or address. Sign in again for this endpoint.",
      fix: { kind: "sign-in-again", label: "Sign in again" },
    };
  }
  if (
    observed?.readiness !== "unauthenticated" &&
    failure?.category !== "unauthenticated" &&
    failure?.reason !== "authentication-required"
  ) {
    return undefined;
  }
  switch (observed?.unauthenticatedReason) {
    case "interaction-required":
      return {
        tone: "needs-you",
        label: "Sign in again",
        sentence:
          "Your organization asks you to sign in again in person, for example to complete multi-factor authentication.",
        fix: { kind: "sign-in-again", label: "Sign in again" },
      };
    case "expired":
    case "revoked":
      return {
        tone: "needs-you",
        label: "Signed out",
        sentence: "Your organization sign-in ended. Sign in again to keep using it.",
        fix: { kind: "sign-in-again", label: "Sign in again" },
      };
    case "not-authorized":
      return {
        tone: "failed",
        label: "No access",
        sentence: foundry
          ? "You're signed in, but your account has no role on this Azure resource. Ask an administrator for the Cognitive Services OpenAI User role on it."
          : "You're signed in, but the gateway refused your account. Ask an administrator for access to it.",
      };
    default:
      return {
        tone: "needs-you",
        label: "Sign in to use",
        sentence: "Sign in with your organization account to use this endpoint.",
        fix: { kind: "sign-in", label: "Sign in with your organization" },
      };
  }
}

/**
 * An Amazon Bedrock sign-in's state from the host's own reason. The sign-in
 * begins only in a terminal on the host, so the one fix is to check again
 * once the person has run the command the sentence names; undefined leaves
 * the ordinary reading (ready, cannot connect) in place.
 */
function cloudSignInStatus(
  instance: Extract<ModelEndpointInstance, { driverKind: "amazon-bedrock" }>,
  hostPlatform: HostPlatform | undefined,
  observed: ProviderObservedState | undefined,
  failure: ProviderProbeFailure | undefined,
): EndpointStatus | undefined {
  const signIn = `Sign in from a terminal on ${thisComputerName(hostPlatform)}: run octant provider sign-in "${instance.displayName}" and enter the code it shows at your organization's access portal, then check again.`;
  const checkAgain = { kind: "check-now", label: "Check again" } as const;
  if (observed?.readiness === "incompatible") {
    return {
      tone: "needs-you",
      label: "Sign-in doesn't match",
      sentence: `The sign-in is for another portal, account, role, or region. ${signIn}`,
      fix: checkAgain,
    };
  }
  // A check signs a request and sends nothing, so an unavailable answer is
  // the host's sign-in service, not Bedrock; the host's sentence says so.
  if (observed?.readiness === "unavailable" && observed.message !== undefined) {
    return cannotConnect(observed.message);
  }
  if (
    observed?.readiness !== "unauthenticated" &&
    failure?.category !== "unauthenticated" &&
    failure?.reason !== "authentication-required"
  ) {
    return undefined;
  }
  switch (observed?.unauthenticatedReason) {
    case "not-authorized":
      return {
        tone: "failed",
        label: "No access",
        sentence:
          "You're signed in, but your organization's portal doesn't give your account this role, or the role may not use this model. Ask an administrator for access.",
      };
    case "expired":
    case "revoked":
      return {
        tone: "needs-you",
        label: "Signed out",
        sentence: `Your organization sign-in ended. ${signIn}`,
        fix: checkAgain,
      };
    default:
      return {
        tone: "needs-you",
        label: "Sign in to use",
        sentence: signIn,
        fix: checkAgain,
        guidedBySignIn: true,
      };
  }
}

/** Whether the endpoint sends a key at all; one that sends none has no key line anywhere. */
export function endpointTakesKey(instance: ModelEndpointInstance): boolean {
  if (
    instance.driverKind === "ollama" ||
    instance.driverKind === "amazon-bedrock" ||
    isDirectorySignInEndpoint(instance)
  ) {
    return false;
  }
  return (
    instance.driverKind === "azure-foundry" || instance.configuration.authentication !== "none"
  );
}

/**
 * Whether the host's last check of an organization sign-in endpoint was
 * refused for want of a sign-in (it ended, or the broker no longer holds it).
 * The host's sign-in status reads only whether the endpoint names a sign-in,
 * so while this holds nothing may say who is signed in.
 */
export function lastCheckFoundSignInGone(observed: ProviderObservedState | undefined): boolean {
  return (
    observed?.readiness === "unauthenticated" && observed.unauthenticatedReason !== "not-authorized"
  );
}

/**
 * The line under a row's name: who is signed in, or where it is and whether
 * it sends a key. `observed` is the host's last check, which an organization
 * sign-in's status cannot overrule.
 */
export function endpointSubLine(
  instance: ModelEndpointInstance,
  signIn: EndpointSignIn | undefined,
  offer: { readonly accountLabel: string } | undefined,
  observed?: ProviderObservedState,
): string {
  if (offer !== undefined) {
    if (signIn?.kind === "signed-in") return `Signed in as ${signIn.accountLabel}`;
    if (signIn?.kind === "signed-out" || signIn?.kind === "expired")
      return `${offer.accountLabel} · not signed in`;
    return `${offer.accountLabel} · ${signIn?.kind === "linking" ? "signing in…" : signIn?.kind === "unknown" ? "sign-in not checked" : "checking sign-in…"}`;
  }
  const host = endpointHost(instance);
  if (instance.driverKind === "ollama") return `Ollama · ${host}`;
  if (isDirectorySignInEndpoint(instance) || instance.driverKind === "amazon-bedrock") {
    return signIn?.kind === "signed-in" && !lastCheckFoundSignInGone(observed)
      ? `Signed in as ${signIn.accountLabel}`
      : `${host} · Organization sign-in`;
  }
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
