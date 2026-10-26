import {
  decodeProviderInstanceId,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";
import { subscriptionOAuthOffers } from "@octant/domain";
import {
  decodeHostOAuthDescriptor,
  type HostOAuthDescriptor,
  type HostOAuthSignInState,
  type SubscriptionOAuthOffer,
} from "@octant/contracts/host-oauth";
import {
  encodeSubscriptionOAuthCredential,
  readSubscriptionOAuthCredential,
} from "@octant/provider-sdk/subscription-oauth";
import type { PrincipalKind } from "@octant/domain/remote-access-policy";
import { authenticateProjectRequest } from "../../projectBindingRoutes";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../../windowAuthorityStore";
import { readPrincipalRouteContext } from "../../principalRouteContext";
import type { ProviderCredentialStore } from "../credentialBrokerClient";
import type { HostOAuthService } from "./hostOAuthService";
import { dispatchDirectorySignIn, isDirectorySignIn } from "./providerDirectorySignIn";

const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ProviderOAuthRouteDependencies {
  readonly service: HostOAuthService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly credentials?: ProviderCredentialStore;
  readonly offers?: readonly SubscriptionOAuthOffer[];
  readonly readInstance?: (instanceId: ProviderInstanceId) => ProviderInstance | undefined;
  readonly bindDescriptor?: (
    instance: ProviderInstance,
    descriptorId: string,
    windowId: string,
  ) => Promise<void>;
  readonly now?: () => number;
  readonly maxRequestBodySize?: number;
  readonly allowedRendererHttpOrigin?: string | null;
}

export type ProviderOAuthView =
  | {
      readonly kind: "signed-out";
      readonly termsRequired: boolean;
      readonly termsSummary: string;
      readonly accountLabel: string;
    }
  | {
      readonly kind: "awaiting-consent";
      readonly attemptId: string;
      readonly flow: "authorization-code-pkce";
      readonly authorizationUrl: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "awaiting-consent";
      readonly attemptId: string;
      readonly flow: "device-code";
      readonly verificationUri: string;
      readonly userCode: string;
      readonly expiresAt: string;
    }
  | {
      /**
       * Signed out on this host only: the local grant is gone, but the issuer
       * could not be told, so its refresh token stays valid there until it
       * expires.
       */
      readonly kind: "signed-out-locally";
      readonly termsRequired: boolean;
      readonly termsSummary: string;
      readonly accountLabel: string;
    }
  | {
      /**
       * Still signed in: the issuer could not be told about the sign-out, so
       * the grant was kept. The person can retry, or sign out on this host
       * only with the `sign-out-locally` command.
       */
      readonly kind: "not-revoked";
      readonly accountLabel: string;
    }
  | { readonly kind: "signed-in"; readonly accountLabel: string }
  | {
      readonly kind: "expired";
      readonly accountLabel: string;
      /**
       * Present when the organization wants the person to sign in again in
       * person (multi-factor or a consent prompt) rather than the sign-in
       * having ended.
       */
      readonly reason?: "interaction-required";
    }
  | { readonly kind: "refused"; readonly reason: string };

export function createProviderOAuthRouteHandler(dependencies: ProviderOAuthRouteDependencies) {
  const offers = dependencies.offers ?? subscriptionOAuthOffers();
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? 16_384;
  // Settings can unmount while the browser owns consent. Keep the public
  // attempt on this host, scoped to its originating window and endpoint.
  // Serial requests also prevent a double begin from creating another grant.
  const pending = new Map<
    string,
    { readonly view: Promise<ProviderOAuthView>; readonly expiresAt: number }
  >();
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/providers/oauth") return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || url.search !== "") {
      return json({ kind: "refused", reason: "invalid" }, 400, null);
    }
    if (
      origin !== null &&
      !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin)
    ) {
      return json({ kind: "refused", reason: "invalid" }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== "POST") return json({ kind: "refused", reason: "invalid" }, 400, origin);
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > bodyLimit) return json({ kind: "refused", reason: "invalid" }, 413, origin);
      body = JSON.parse(text) as unknown;
    } catch {
      return json({ kind: "refused", reason: "invalid" }, 400, origin);
    }
    let windowId: string;
    try {
      windowId = authenticateProjectRequest({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ kind: "refused", reason: "invalid" }, 401, origin);
      }
      return json({ kind: "refused", reason: "unavailable" }, 503, origin);
    }
    const principal = principalKind(request);
    const command = readCommand(body);
    if (command === undefined) return json({ kind: "refused", reason: "invalid" }, 400, origin);
    const offer = offers.find(
      (candidate) => candidate.descriptor.descriptorId === command.descriptorId,
    );
    // An organization sign-in is not a catalog offer: its descriptor is built
    // from the instance's own configuration when each command runs.
    if (offer === undefined && !isDirectorySignIn(command.descriptorId)) {
      return json({ kind: "refused", reason: "invalid" }, 400, origin);
    }
    const key = `${windowId}\n${command.instanceId}\n${command.descriptorId}`;
    try {
      for (const [key, attempt] of pending) {
        if (attempt.expiresAt <= now()) pending.delete(key);
      }
      const prior = principal === "local-window" ? pending.get(key) : undefined;
      const execute = async (): Promise<ProviderOAuthView> => {
        let resumed = command;
        if (
          prior !== undefined &&
          (command.kind === "begin" || command.kind === "status" || command.kind === "poll")
        ) {
          const previous = await prior.view;
          if (command.kind === "begin") return previous;
          if (previous.kind === "awaiting-consent") {
            resumed = { ...command, kind: "poll", attemptId: previous.attemptId };
          } else if (command.kind === "poll") {
            return previous;
          }
        }
        if (offer === undefined) {
          return dispatchDirectorySignIn({
            dependencies,
            command: resumed,
            principal,
            actorId: windowId,
          });
        }
        return dispatch({
          dependencies,
          command: resumed,
          descriptor: decodeHostOAuthDescriptor(offer.descriptor),
          offer,
          principal,
          actorId: windowId,
        });
      };
      const viewPromise = execute();
      const tracking =
        principal === "local-window" && (command.kind === "begin" || prior !== undefined);
      if (tracking)
        pending.set(key, { view: viewPromise, expiresAt: prior?.expiresAt ?? now() + 15 * 60_000 });
      const view = await viewPromise.catch((error: unknown) => {
        if (pending.get(key)?.view === viewPromise) pending.delete(key);
        throw error;
      });
      if (tracking && pending.get(key)?.view === viewPromise) {
        if (view.kind === "awaiting-consent") {
          pending.set(key, { view: viewPromise, expiresAt: Date.parse(view.expiresAt) });
        } else {
          pending.delete(key);
        }
      }
      return json(view, 200, origin);
    } catch (error) {
      // Storing the credential pointer or binding the endpoint failed after
      // the issuer finished; the panel shows the refusal, and this line keeps
      // the failure findable. The error is not logged because it may echo data.
      console.warn(
        `[host-oauth] the ${command.kind} sign-in command failed (${error instanceof Error ? error.name : "unknown error"}).`,
      );
      return json({ kind: "refused", reason: "unavailable" }, 503, origin);
    }
  };
}

async function dispatch(input: {
  readonly dependencies: ProviderOAuthRouteDependencies;
  readonly command: ProviderOAuthCommand;
  readonly descriptor: HostOAuthDescriptor;
  readonly offer: SubscriptionOAuthOffer;
  readonly principal: PrincipalKind;
  readonly actorId: string;
}): Promise<ProviderOAuthView> {
  const { dependencies, command, descriptor, offer, principal, actorId } = input;
  if (command.kind === "status") return signedInOrOut(dependencies, command, offer, principal);
  if (command.kind === "acknowledge") {
    const recorded = dependencies.service.acknowledgeTerms({
      principalKind: principal,
      actorId,
      descriptor,
    });
    if (recorded.kind === "refused") return { kind: "refused", reason: recorded.reason };
    return {
      kind: "signed-out",
      termsRequired: false,
      termsSummary: offer.termsSummary,
      accountLabel: offer.accountLabel,
    };
  }
  if (command.kind === "begin") {
    const unmatched = unmatchedInstance(dependencies, command.instanceId, offer);
    if (unmatched !== undefined) return unmatched;
    const pointer = await readPointer(dependencies, command.instanceId);
    const credentialRef =
      pointer !== undefined && pointer.descriptorId === offer.descriptor.descriptorId
        ? pointer.credentialRef
        : undefined;
    const started = await dependencies.service.begin({
      principalKind: principal,
      actorId,
      descriptor,
      ...(credentialRef === undefined ? {} : { credentialRef }),
    });
    return finish(dependencies, command, offer, started, actorId, principal);
  }
  if (command.kind === "poll") {
    const state = await dependencies.service.status({
      principalKind: principal,
      attemptId: command.attemptId,
      descriptor,
    });
    return finish(dependencies, command, offer, state, actorId, principal);
  }
  const pointer = await readPointer(dependencies, command.instanceId);
  if (pointer === undefined || pointer.descriptorId !== offer.descriptor.descriptorId) {
    return {
      kind: "signed-out",
      termsRequired: dependencies.service.offer(descriptor).oauth.termsRequired,
      termsSummary: offer.termsSummary,
      accountLabel: offer.accountLabel,
    };
  }
  const signedOut = await dependencies.service.signOut({
    principalKind: principal,
    descriptor,
    credentialRef: pointer.credentialRef,
    forgetWhenNotRevoked: command.kind === "sign-out-locally",
  });
  if (signedOut.kind === "refused") return { kind: "refused", reason: signedOut.reason };
  if (signedOut.kind === "unavailable") return { kind: "refused", reason: "unavailable" };
  if (signedOut.kind === "not-revoked") {
    return { kind: "not-revoked", accountLabel: pointer.accountLabel };
  }
  await dependencies.credentials?.delete(command.instanceId);
  return {
    kind: signedOut.kind,
    termsRequired: false,
    termsSummary: offer.termsSummary,
    accountLabel: offer.accountLabel,
  };
}

async function finish(
  dependencies: ProviderOAuthRouteDependencies,
  command: ProviderOAuthCommand,
  offer: SubscriptionOAuthOffer,
  state: HostOAuthSignInState,
  windowId: string,
  principal: PrincipalKind,
): Promise<ProviderOAuthView> {
  if (state.kind === "signed-in") {
    if (state.descriptorId !== offer.descriptor.descriptorId) {
      return { kind: "refused", reason: "invalid" };
    }
    const unmatched = unmatchedInstance(dependencies, command.instanceId, offer);
    if (unmatched !== undefined) return unmatched;
    await revokeReplacedPointer(dependencies, command, offer, state.credentialRef, principal);
    await storePointer(dependencies, command.instanceId, offer, state.credentialRef, windowId);
    return { kind: "signed-in", accountLabel: offer.accountLabel };
  }
  if (state.kind === "sign-in-again") return { kind: "expired", accountLabel: offer.accountLabel };
  if (state.kind === "refused") return { kind: "refused", reason: state.reason };
  if (state.kind === "awaiting-consent" && state.flow === "device-code") {
    return {
      kind: "awaiting-consent",
      attemptId: state.attemptId,
      flow: "device-code",
      verificationUri: state.verificationUri,
      userCode: state.userCode,
      expiresAt: state.expiresAt,
    };
  }
  if (state.kind === "awaiting-consent") {
    return {
      kind: "awaiting-consent",
      attemptId: state.attemptId,
      flow: "authorization-code-pkce",
      authorizationUrl: state.authorizationUrl,
      expiresAt: state.expiresAt,
    };
  }
  return { kind: "refused", reason: "unavailable" };
}

async function signedInOrOut(
  dependencies: ProviderOAuthRouteDependencies,
  command: ProviderOAuthCommand,
  offer: SubscriptionOAuthOffer,
  principal: PrincipalKind,
): Promise<ProviderOAuthView> {
  const pointer = await readPointer(dependencies, command.instanceId);
  if (pointer !== undefined && pointer.descriptorId === offer.descriptor.descriptorId) {
    const refreshed = await dependencies.service.refresh({
      principalKind: principal,
      descriptor: offer.descriptor,
      credentialRef: pointer.credentialRef,
    });
    if (refreshed.kind === "sign-in-again") {
      await dependencies.credentials?.delete(command.instanceId).catch(() => undefined);
      return { kind: "expired", accountLabel: pointer.accountLabel };
    }
    if (refreshed.kind === "refused") return { kind: "refused", reason: refreshed.reason };
    if (refreshed.kind === "unavailable" || refreshed.kind === "transient") {
      return { kind: "refused", reason: "unavailable" };
    }
    return { kind: "signed-in", accountLabel: pointer.accountLabel };
  }
  return {
    kind: "signed-out",
    termsRequired: dependencies.service.offer(offer.descriptor).oauth.termsRequired,
    termsSummary: offer.termsSummary,
    accountLabel: offer.accountLabel,
  };
}

function unmatchedInstance(
  dependencies: ProviderOAuthRouteDependencies,
  instanceId: ProviderInstanceId,
  offer: SubscriptionOAuthOffer,
): ProviderOAuthView | undefined {
  if (dependencies.readInstance === undefined) return undefined;
  const instance = dependencies.readInstance(instanceId);
  if (instance === undefined) return { kind: "refused", reason: "unknown-instance" };
  if (!offer.driverKinds.some((kind) => kind === instance.driverKind)) {
    return { kind: "refused", reason: "unsupported-driver" };
  }
  if (!endpointMatchesOffer(instance, offer)) {
    return { kind: "refused", reason: "endpoint-mismatch" };
  }
  return undefined;
}

/**
 * A sign-in may only attach to the endpoint its catalog entry names, matched
 * on canonical origin so path and trailing-slash differences in the stored
 * base URL neither smuggle nor spuriously refuse. Drivers without a base URL
 * have nothing to match and stay refused.
 */
function endpointMatchesOffer(instance: ProviderInstance, offer: SubscriptionOAuthOffer): boolean {
  const baseUrl =
    instance.driverKind === "openai-compatible" || instance.driverKind === "anthropic-compatible"
      ? instance.configuration.baseUrl
      : undefined;
  if (baseUrl === undefined) return false;
  return (
    canonicalOrigin(baseUrl) !== undefined &&
    canonicalOrigin(baseUrl) === canonicalOrigin(offer.allowedEndpoint)
  );
}

function canonicalOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function revokeReplacedPointer(
  dependencies: ProviderOAuthRouteDependencies,
  command: ProviderOAuthCommand,
  offer: SubscriptionOAuthOffer,
  nextCredentialRef: string,
  principal: PrincipalKind,
): Promise<void> {
  const pointer = await readPointer(dependencies, command.instanceId);
  if (pointer === undefined || pointer.credentialRef === nextCredentialRef) return;
  if (pointer.descriptorId === offer.descriptor.descriptorId) {
    // The new grant replaces this one, and nothing will point at the old
    // grant afterwards. Its local material must go even when the issuer
    // cannot be told, or a live refresh token would sit in the credential
    // store with no pointer and no way to sign it out.
    const signedOut = await dependencies.service.signOut({
      principalKind: principal,
      descriptor: offer.descriptor,
      credentialRef: pointer.credentialRef,
      forgetWhenNotRevoked: true,
    });
    if (signedOut.kind !== "signed-out" && signedOut.kind !== "signed-out-locally") return;
  }
  await dependencies.credentials?.delete(command.instanceId).catch(() => undefined);
}

async function storePointer(
  dependencies: ProviderOAuthRouteDependencies,
  instanceId: ProviderInstanceId,
  offer: SubscriptionOAuthOffer,
  credentialRef: string,
  windowId: string,
): Promise<void> {
  if (dependencies.credentials === undefined) return;
  await dependencies.credentials.set(
    instanceId,
    encodeSubscriptionOAuthCredential({
      kind: "subscription-oauth",
      credentialRef,
      descriptorId: offer.descriptor.descriptorId,
      accountLabel: offer.accountLabel,
    }),
  );
  const instance = dependencies.readInstance?.(instanceId);
  if (instance === undefined || dependencies.bindDescriptor === undefined) return;
  if (
    (instance.driverKind === "openai-compatible" ||
      instance.driverKind === "anthropic-compatible") &&
    instance.configuration.oauthDescriptorId !== offer.descriptor.descriptorId
  ) {
    await dependencies.bindDescriptor(instance, offer.descriptor.descriptorId, windowId);
  }
}

async function readPointer(
  dependencies: ProviderOAuthRouteDependencies,
  instanceId: ProviderInstanceId,
): Promise<
  | { readonly credentialRef: string; readonly descriptorId: string; readonly accountLabel: string }
  | undefined
> {
  if (dependencies.credentials === undefined) return undefined;
  try {
    const raw = await dependencies.credentials.resolve(instanceId);
    return readSubscriptionOAuthCredential(raw);
  } catch {
    return undefined;
  }
}

export interface ProviderOAuthCommand {
  readonly kind: "status" | "acknowledge" | "begin" | "poll" | "sign-out" | "sign-out-locally";
  readonly instanceId: ProviderInstanceId;
  readonly descriptorId: string;
  readonly attemptId: string;
  /**
   * An organization sign-in begun with a device code. Only the host-local
   * `octant provider sign-in` route sets it; this route's commands never do.
   */
  readonly flow?: "device-code";
}

function readCommand(value: unknown): ProviderOAuthCommand | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (
    kind !== "status" &&
    kind !== "acknowledge" &&
    kind !== "begin" &&
    kind !== "poll" &&
    kind !== "sign-out" &&
    kind !== "sign-out-locally"
  ) {
    return undefined;
  }
  if (typeof value.descriptorId !== "string") return undefined;
  let instanceId: ProviderInstanceId;
  try {
    instanceId = decodeProviderInstanceId(value.instanceId);
  } catch {
    return undefined;
  }
  const attemptId = typeof value.attemptId === "string" ? value.attemptId : "";
  if (kind === "poll" && attemptId.length === 0) return undefined;
  return { kind, instanceId, descriptorId: value.descriptorId, attemptId };
}

function principalKind(request: Request): PrincipalKind {
  const context = readPrincipalRouteContext(request);
  return context?.principal.kind === "remote-device" ? "remote-device" : "local-window";
}

function json(body: ProviderOAuthView, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) },
  });
}

function cors(origin: string | null): Record<string, string> {
  return {
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "origin",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
