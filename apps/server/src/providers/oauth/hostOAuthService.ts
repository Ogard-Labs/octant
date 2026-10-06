import {
  decodeHostOAuthDescriptor,
  decodeHostOAuthJournalRecord,
  decodeHostOAuthSignInOffer,
  decodeHostOAuthSignInState,
  decodeHostOAuthTermsAcknowledgment,
  type HostOAuthDescriptor,
  type HostOAuthJournalRecord,
  type HostOAuthSignInOffer,
  type HostOAuthSignInState,
  type HostOAuthTermsAcknowledgment,
} from "@octant/contracts/host-oauth";
import {
  authorizePrincipalAction,
  type PrincipalActionDecision,
  type PrincipalKind,
} from "@octant/domain/remote-access-policy";
import { makeHostOAuthBrokerClient, type HostOAuthBrokerPort } from "./hostOAuthBrokerClient";

const termsKey = (descriptorId: string, termsId: string) => `${descriptorId}\n${termsId}`;

type Refused = Extract<HostOAuthSignInState, { readonly kind: "refused" }>;

export interface HostOAuthService {
  readonly offer: (descriptor: HostOAuthDescriptor) => HostOAuthSignInOffer;
  readonly acknowledgeTerms: (input: {
    readonly principalKind: PrincipalKind;
    readonly actorId: string;
    readonly descriptor: HostOAuthDescriptor;
  }) =>
    | { readonly kind: "recorded"; readonly acknowledgment: HostOAuthTermsAcknowledgment }
    | Refused;
  readonly restoreAcknowledgment: (acknowledgment: HostOAuthTermsAcknowledgment) => void;
  readonly begin: (input: {
    readonly principalKind: PrincipalKind;
    readonly actorId: string;
    readonly descriptor: HostOAuthDescriptor;
    /** ChatGPT plan reauthorization: the instance's stored grant. Optional. */
    readonly credentialRef?: string;
  }) => Promise<HostOAuthSignInState>;
  readonly status: (input: {
    readonly principalKind: PrincipalKind;
    readonly attemptId: string;
    readonly descriptor: HostOAuthDescriptor;
  }) => Promise<HostOAuthSignInState>;
  readonly refresh: (input: {
    readonly principalKind: PrincipalKind;
    readonly descriptor: HostOAuthDescriptor;
    readonly credentialRef: string;
  }) => Promise<
    | HostOAuthSignInState
    | { readonly kind: "refreshed" }
    | { readonly kind: "transient" }
    | { readonly kind: "unavailable" }
  >;
  readonly signOut: (input: {
    readonly principalKind: PrincipalKind;
    readonly descriptor: HostOAuthDescriptor;
    readonly credentialRef: string;
  }) => Promise<{ readonly kind: "signed-out" } | Refused | { readonly kind: "unavailable" }>;
  /**
   * Whether a descriptor's dialect revokes the refresh token at the issuer
   * before the local grant is dropped. The ChatGPT plan dialect does; the
   * OpenRouter dialect has no revocation endpoint.
   */
  readonly revokesOnSignOut: (descriptor: HostOAuthDescriptor) => boolean;
}

export function createHostOAuthService(options: {
  readonly journal: { readonly append: (record: HostOAuthJournalRecord) => void };
  readonly broker: HostOAuthBrokerPort;
  readonly now?: () => Date;
  /**
   * The stable host id the ChatGPT plan dialect sends as
   * `ext_agent_host_id`. Bound into the descriptor when a flow begins, so
   * the catalog entry never carries a host id and the id is stable before
   * the first sign-in.
   */
  readonly extAgentHostId?: string;
  readonly authorize?: (input: {
    readonly principalKind: PrincipalKind;
    readonly action: string;
  }) => PrincipalActionDecision;
}): HostOAuthService {
  const now = options.now ?? (() => new Date());
  const authorize =
    options.authorize ??
    ((input: { readonly principalKind: PrincipalKind; readonly action: string }) =>
      authorizePrincipalAction(input));
  const terms = new Map<string, HostOAuthTermsAcknowledgment>();
  const completed = new Set<string>();
  const refusedAttempts = new Set<string>();

  const append = (record: unknown): boolean => {
    try {
      options.journal.append(decodeHostOAuthJournalRecord(record));
      return true;
    } catch {
      return false;
    }
  };

  const refuse = (
    descriptor: HostOAuthDescriptor,
    reason: "local-host-required" | "terms-required" | "unavailable" | "invalid",
    attemptId?: string,
  ): Refused => {
    append({
      name: "host-oauth.sign-in-refused",
      descriptorId: descriptor.descriptorId,
      reason,
      ...(attemptId === undefined ? {} : { attemptId }),
    });
    const decoded = decodeHostOAuthSignInState({
      kind: "refused",
      descriptorId: descriptor.descriptorId,
      reason,
      ...(attemptId === undefined ? {} : { attemptId }),
    });
    if (decoded.kind !== "refused") return { kind: "refused", reason };
    return decoded;
  };

  const noteState = (descriptor: HostOAuthDescriptor, state: HostOAuthSignInState) => {
    if (state.kind === "signed-in" && !completed.has(state.attemptId)) {
      completed.add(state.attemptId);
      append({
        name: "host-oauth.sign-in-completed",
        descriptorId: descriptor.descriptorId,
        attemptId: state.attemptId,
        credentialRef: state.credentialRef,
      });
    }
    if (
      state.kind === "refused" &&
      state.attemptId !== undefined &&
      !refusedAttempts.has(state.attemptId)
    ) {
      refusedAttempts.add(state.attemptId);
      append({
        name: "host-oauth.sign-in-refused",
        descriptorId: descriptor.descriptorId,
        attemptId: state.attemptId,
        reason: state.reason,
      });
    }
  };

  const decodeState = (raw: unknown): HostOAuthSignInState | undefined => {
    try {
      return decodeHostOAuthSignInState(raw);
    } catch {
      return undefined;
    }
  };

  const service: HostOAuthService = {
    offer: (descriptor) =>
      decodeHostOAuthSignInOffer({
        oauth: {
          available: true,
          termsRequired: !terms.has(termsKey(descriptor.descriptorId, descriptor.termsId)),
        },
        apiKey: { available: true },
      }),
    acknowledgeTerms: (input) => {
      const decision = authorize({
        principalKind: input.principalKind,
        action: "provider.oauth.acknowledge-terms",
      });
      if (decision.kind === "deny") return refuse(input.descriptor, "local-host-required");
      let acknowledgment: HostOAuthTermsAcknowledgment;
      try {
        acknowledgment = decodeHostOAuthTermsAcknowledgment({
          descriptorId: input.descriptor.descriptorId,
          termsId: input.descriptor.termsId,
          actorId: input.actorId,
          acknowledgedAt: now().toISOString(),
        });
      } catch {
        return refuse(input.descriptor, "invalid");
      }
      terms.set(termsKey(acknowledgment.descriptorId, acknowledgment.termsId), acknowledgment);
      append({ name: "host-oauth.terms-acknowledged", ...acknowledgment });
      return { kind: "recorded", acknowledgment };
    },
    restoreAcknowledgment: (acknowledgment) => {
      terms.set(termsKey(acknowledgment.descriptorId, acknowledgment.termsId), acknowledgment);
    },
    begin: async (input) => {
      const decision = authorize({
        principalKind: input.principalKind,
        action: "provider.oauth.begin",
      });
      if (decision.kind === "deny") return refuse(input.descriptor, "local-host-required");
      const acknowledgment = terms.get(
        termsKey(input.descriptor.descriptorId, input.descriptor.termsId),
      );
      if (acknowledgment === undefined) return refuse(input.descriptor, "terms-required");
      // The ChatGPT plan dialect needs the stable host id on the descriptor
      // before the first sign-in; the catalog entry never carries one.
      const descriptor =
        input.descriptor.dialect === "chatgpt-plan-siwc" && options.extAgentHostId !== undefined
          ? { ...input.descriptor, extAgentHostId: options.extAgentHostId }
          : input.descriptor;
      let raw: unknown;
      try {
        raw = await options.broker.begin({
          descriptor: wireDescriptor(descriptor),
          actorId: input.actorId,
          termsAcknowledgedAt: acknowledgment.acknowledgedAt,
          ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
        });
      } catch {
        return refuse(input.descriptor, "unavailable");
      }
      const state = decodeState(raw);
      if (state === undefined) return refuse(input.descriptor, "unavailable");
      if (state.kind === "awaiting-consent") {
        append({
          name: "host-oauth.sign-in-started",
          descriptorId: input.descriptor.descriptorId,
          attemptId: state.attemptId,
          flow: state.flow,
        });
      }
      noteState(input.descriptor, state);
      return state;
    },
    status: async (input) => {
      const decision = authorize({
        principalKind: input.principalKind,
        action: "provider.oauth.begin",
      });
      if (decision.kind === "deny") return refuse(input.descriptor, "local-host-required");
      let raw: unknown;
      try {
        raw = await options.broker.status(input.attemptId);
      } catch {
        return refuse(input.descriptor, "unavailable", input.attemptId);
      }
      const state = decodeState(raw);
      if (state === undefined) return refuse(input.descriptor, "unavailable", input.attemptId);
      noteState(input.descriptor, state);
      return state;
    },
    refresh: async (input) => {
      const decision = authorize({
        principalKind: input.principalKind,
        action: "provider.oauth.refresh",
      });
      if (decision.kind === "deny") return refuse(input.descriptor, "local-host-required");
      let raw: unknown;
      try {
        raw = await options.broker.refresh(input.credentialRef);
      } catch {
        return { kind: "unavailable" };
      }
      if (!isRecord(raw) || typeof raw.kind !== "string") return { kind: "unavailable" };
      if (raw.kind === "refreshed" || raw.kind === "transient" || raw.kind === "unavailable") {
        return { kind: raw.kind };
      }
      if (raw.kind !== "sign-in-again") return { kind: "unavailable" };
      const state = decodeState({
        kind: "sign-in-again",
        credentialRef: input.credentialRef,
        reason: raw.reason,
      });
      if (state === undefined || state.kind !== "sign-in-again") return { kind: "unavailable" };
      append({
        name: "host-oauth.sign-in-again",
        descriptorId: input.descriptor.descriptorId,
        credentialRef: state.credentialRef,
        reason: state.reason,
      });
      return state;
    },
    signOut: async (input) => {
      const decision = authorize({
        principalKind: input.principalKind,
        action: "provider.oauth.sign-out",
      });
      if (decision.kind === "deny") return refuse(input.descriptor, "local-host-required");
      try {
        // The ChatGPT plan dialect revokes the refresh token at the issuer's
        // revocation endpoint before the local grant is dropped; other
        // dialects have no revocation endpoint and simply forget the grant.
        if (input.descriptor.dialect === "chatgpt-plan-siwc") {
          const revoked = await options.broker.revoke(input.credentialRef);
          // The broker answers HTTP 200 with an unavailable result when the
          // issuer refused the revocation or the grant could not be dropped:
          // the refresh token stayed valid at the issuer and the grant stayed
          // in the store. Claiming signed-out anyway would make the caller
          // delete the instance pointer and journal a sign-out that never
          // happened, silently leaving the session alive at the issuer.
          if (!isRecord(revoked) || revoked.kind !== "revoked") {
            return { kind: "unavailable" };
          }
        } else {
          await options.broker.forget(input.credentialRef);
        }
      } catch {
        return { kind: "unavailable" };
      }
      append({
        name: "host-oauth.signed-out",
        descriptorId: input.descriptor.descriptorId,
        credentialRef: input.credentialRef,
      });
      return { kind: "signed-out" };
    },
    revokesOnSignOut: (descriptor) => descriptor.dialect === "chatgpt-plan-siwc",
  };
  return service;
}

export function openHostOAuthService(options: {
  readonly brokerUrl: string;
  readonly brokerToken: string;
  readonly journal: { readonly append: (record: HostOAuthJournalRecord) => void };
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}): HostOAuthService {
  return createHostOAuthService({
    journal: options.journal,
    broker: makeHostOAuthBrokerClient({
      url: options.brokerUrl,
      token: options.brokerToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function readHostOAuthDescriptor(value: unknown): HostOAuthDescriptor | undefined {
  try {
    return decodeHostOAuthDescriptor(value);
  } catch {
    return undefined;
  }
}

function wireDescriptor(
  descriptor: HostOAuthDescriptor,
): HostOAuthBrokerPort["begin"] extends (input: infer Input) => Promise<unknown>
  ? Input extends { readonly descriptor: infer Descriptor }
    ? Descriptor
    : never
  : never {
  return {
    descriptorId: descriptor.descriptorId,
    ...(descriptor.clientId === undefined ? {} : { clientId: descriptor.clientId }),
    ...(descriptor.dialect === undefined ? {} : { dialect: descriptor.dialect }),
    flow: descriptor.flow,
    tokenEndpoint: descriptor.tokenEndpoint,
    scopes: descriptor.scopes,
    termsId: descriptor.termsId,
    ...(descriptor.authorizationEndpoint === undefined
      ? {}
      : { authorizationEndpoint: descriptor.authorizationEndpoint }),
    ...(descriptor.deviceAuthorizationEndpoint === undefined
      ? {}
      : { deviceAuthorizationEndpoint: descriptor.deviceAuthorizationEndpoint }),
    ...(descriptor.extAgentHostId === undefined
      ? {}
      : { extAgentHostId: descriptor.extAgentHostId }),
    ...(descriptor.agentNameHint === undefined ? {} : { agentNameHint: descriptor.agentNameHint }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
