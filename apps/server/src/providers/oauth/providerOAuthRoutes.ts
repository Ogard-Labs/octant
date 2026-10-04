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
  | { readonly kind: "signed-in"; readonly accountLabel: string }
  | { readonly kind: "expired"; readonly accountLabel: string }
  | { readonly kind: "refused"; readonly reason: string };

export function createProviderOAuthRouteHandler(dependencies: ProviderOAuthRouteDependencies) {
  const offers = dependencies.offers ?? subscriptionOAuthOffers();
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? 16_384;
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
    if (offer === undefined) return json({ kind: "refused", reason: "invalid" }, 400, origin);
    const descriptor = decodeHostOAuthDescriptor(offer.descriptor);
    try {
      const view = await dispatch({
        dependencies,
        command,
        descriptor,
        offer,
        principal,
        actorId: windowId,
      });
      return json(view, 200, origin);
    } catch {
      return json({ kind: "refused", reason: "unavailable" }, 503, origin);
    }
  };
}

async function dispatch(input: {
  readonly dependencies: ProviderOAuthRouteDependencies;
  readonly command: OAuthCommand;
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
    const started = await dependencies.service.begin({
      principalKind: principal,
      actorId,
      descriptor,
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
  });
  if (signedOut.kind === "refused") return { kind: "refused", reason: signedOut.reason };
  if (signedOut.kind === "unavailable") return { kind: "refused", reason: "unavailable" };
  await dependencies.credentials?.delete(command.instanceId);
  return {
    kind: "signed-out",
    termsRequired: false,
    termsSummary: offer.termsSummary,
    accountLabel: offer.accountLabel,
  };
}

async function finish(
  dependencies: ProviderOAuthRouteDependencies,
  command: OAuthCommand,
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
  command: OAuthCommand,
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
  return undefined;
}

async function revokeReplacedPointer(
  dependencies: ProviderOAuthRouteDependencies,
  command: OAuthCommand,
  offer: SubscriptionOAuthOffer,
  nextCredentialRef: string,
  principal: PrincipalKind,
): Promise<void> {
  const pointer = await readPointer(dependencies, command.instanceId);
  if (pointer === undefined || pointer.credentialRef === nextCredentialRef) return;
  if (pointer.descriptorId === offer.descriptor.descriptorId) {
    const signedOut = await dependencies.service.signOut({
      principalKind: principal,
      descriptor: offer.descriptor,
      credentialRef: pointer.credentialRef,
    });
    if (signedOut.kind !== "signed-out") return;
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

interface OAuthCommand {
  readonly kind: "status" | "acknowledge" | "begin" | "poll" | "sign-out";
  readonly instanceId: ProviderInstanceId;
  readonly descriptorId: string;
  readonly attemptId: string;
}

function readCommand(value: unknown): OAuthCommand | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (
    kind !== "status" &&
    kind !== "acknowledge" &&
    kind !== "begin" &&
    kind !== "poll" &&
    kind !== "sign-out"
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
