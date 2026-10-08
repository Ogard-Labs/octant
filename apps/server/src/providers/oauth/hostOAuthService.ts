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
import { deriveHostRuntimeHostId } from "@octant/host-runtime";
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
  /**
   * Sign out of one grant. A dialect with a revocation endpoint tells the
   * issuer first. When the issuer does not confirm, the grant is kept and the
   * result is `not-revoked`, unless `forgetWhenNotRevoked` asks to delete the
   * local grant anyway: then the result is `signed-out-locally`, which says
   * plainly that the issuer was not told and the refresh token stays valid
   * there until it expires.
   */
  readonly signOut: (input: {
    readonly principalKind: PrincipalKind;
    readonly descriptor: HostOAuthDescriptor;
    readonly credentialRef: string;
    readonly forgetWhenNotRevoked?: boolean;
  }) => Promise<
    | { readonly kind: "signed-out" }
    | { readonly kind: "signed-out-locally" }
    | { readonly kind: "not-revoked" }
    | Refused
    | { readonly kind: "unavailable" }
  >;
  /**
   * Whether a descriptor's dialect revokes the refresh token at the issuer
   * before the local grant is dropped. The ChatGPT plan dialect does; the
   * OpenRouter dialect has no revocation endpoint.
   */
  readonly revokesOnSignOut: (descriptor: HostOAuthDescriptor) => boolean;
}

/**
 * The stable host id a sign-in registers this host under, derived from the
 * same data directory the host runtime already owns, so the broker and the
 * server agree on one host identity instead of provisioning a second one.
 */
export function extAgentHostIdFor(dataDirectory: string): string {
  return `urn:uuid:${deriveHostRuntimeHostId(dataDirectory)}`;
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
  /**
   * Where a sign-in the server could not read or record is reported. Lines
   * name record kinds and reason codes only, never a token, code, or ref.
   */
  readonly log?: (line: string) => void;
}): HostOAuthService {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.warn(line));
  const authorize =
    options.authorize ??
    ((input: { readonly principalKind: PrincipalKind; readonly action: string }) =>
      authorizePrincipalAction(input));
  const terms = new Map<string, HostOAuthTermsAcknowledgment>();
  const completed = new Set<string>();
  const refusedAttempts = new Set<string>();

  // A record that cannot be journaled is reported, never dropped silently:
  // a live sign-in once finished at the issuer while nothing was recorded.
  // The error itself is not logged because it may echo the record.
  const append = (record: {
    readonly name: string;
    readonly [field: string]: unknown;
  }): boolean => {
    try {
      options.journal.append(decodeHostOAuthJournalRecord(record));
      return true;
    } catch (error) {
      log(
        `[host-oauth] could not journal ${record.name} (${error instanceof Error ? error.name : "unknown error"}).`,
      );
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

  /**
   * Journal a state the broker reported. A finished sign-in that cannot be
   * journaled is refused, so the person sees it did not finish instead of a
   * sign-in with no record; the attempt stays uncompleted so a later poll can
   * still record it.
   */
  const noteState = (
    descriptor: HostOAuthDescriptor,
    state: HostOAuthSignInState,
  ): HostOAuthSignInState => {
    if (state.kind === "signed-in" && !completed.has(state.attemptId)) {
      const recorded = append({
        name: "host-oauth.sign-in-completed",
        descriptorId: descriptor.descriptorId,
        attemptId: state.attemptId,
        credentialRef: state.credentialRef,
      });
      if (!recorded) {
        return decodeHostOAuthSignInState({
          kind: "refused",
          attemptId: state.attemptId,
          descriptorId: descriptor.descriptorId,
          reason: "unavailable",
        });
      }
      completed.add(state.attemptId);
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
    return state;
  };

  // A broker answer outside the contract becomes an `unavailable` refusal at
  // the caller; this line says which kind and reason did not decode, without
  // the rest of the answer.
  const decodeState = (raw: unknown): HostOAuthSignInState | undefined => {
    try {
      return decodeHostOAuthSignInState(raw);
    } catch {
      log(
        `[host-oauth] the broker answered with a sign-in state the server cannot read (${describeRaw(raw)}).`,
      );
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
      return noteState(input.descriptor, state);
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
      return noteState(input.descriptor, state);
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
      let result: { readonly kind: "signed-out" } | { readonly kind: "signed-out-locally" };
      try {
        // The ChatGPT plan dialect revokes the refresh token at the issuer's
        // revocation endpoint before the local grant is dropped; other
        // dialects have no revocation endpoint and simply forget the grant.
        if (input.descriptor.dialect === "chatgpt-plan-siwc") {
          const revoked = await options.broker.revoke(input.credentialRef);
          const kind = isRecord(revoked) ? revoked.kind : undefined;
          if (kind === "revoked") {
            result = { kind: "signed-out" };
          } else if (kind === "not-revoked") {
            // The issuer was not told, so the refresh token is still valid
            // there and the broker kept the grant. Claiming a plain sign-out
            // would hide a session that is still alive at the issuer; the
            // caller either keeps the grant to retry or explicitly forgets it
            // on this host only.
            if (input.forgetWhenNotRevoked !== true) return { kind: "not-revoked" };
            await options.broker.forget(input.credentialRef);
            result = { kind: "signed-out-locally" };
          } else {
            return { kind: "unavailable" };
          }
        } else {
          await options.broker.forget(input.credentialRef);
          result = { kind: "signed-out" };
        }
      } catch {
        return { kind: "unavailable" };
      }
      append({
        name: "host-oauth.signed-out",
        descriptorId: input.descriptor.descriptorId,
        credentialRef: input.credentialRef,
      });
      return result;
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

/** The kind and reason of an unreadable broker answer, when they are plain codes. */
function describeRaw(raw: unknown): string {
  if (!isRecord(raw)) return "not an object";
  const code = (value: unknown) =>
    typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : "unreadable";
  return raw.reason === undefined
    ? `kind ${code(raw.kind)}`
    : `kind ${code(raw.kind)}, reason ${code(raw.reason)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
