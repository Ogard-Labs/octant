import type {
  ProviderCapabilities,
  ProviderCredentialStatus,
  ProviderFailure,
} from "@octant/contracts";
import {
  readSubscriptionOAuthCredential,
  resolveSubscriptionOAuthBearer,
  type SubscriptionOAuthCredential,
  type SubscriptionOAuthHost,
  type SubscriptionOAuthResolution,
} from "@octant/provider-sdk/subscription-oauth";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";

/**
 * Capabilities a direct endpoint may report before an authenticated probe.
 * Nothing the endpoint has not demonstrated is claimed as supported.
 */
export const honestDirectEndpointCapabilities: ProviderCapabilities = {
  streaming: "unavailable",
  resume: "unsupported",
  interruption: "unsupported",
  approvals: "unsupported",
  userQuestions: "unsupported",
  reasoning: "unavailable",
  usage: "unavailable",
  toolActivity: "unsupported",
  fileChanges: "unsupported",
  diffs: "unsupported",
  taskProgress: "unsupported",
  nativeChildAgents: "unsupported",
  harnessAutoReview: "unsupported",
  nativeAttachments: "unsupported",
  nativeWebResearch: "unsupported",
  appManagedTools: "unsupported",
  citations: "unsupported",
};

export type DirectEndpointCredentialGate =
  | { readonly kind: "plain"; readonly credential: string | undefined }
  | {
      readonly kind: "oauth";
      readonly credential: SubscriptionOAuthCredential;
      readonly resolve: () => Promise<string>;
    }
  | {
      readonly kind: "report";
      readonly readiness: "unauthenticated" | "unavailable" | "incompatible";
      readonly credentialStatus: ProviderCredentialStatus;
      readonly message: string;
    };

/**
 * Accept a subscription-oauth pointer from the broker. A plain API key is
 * unchanged. A missing, expired, or mismatched grant is reported without
 * calling the endpoint and without retaining a token.
 */
export async function inspectDirectEndpointCredential(input: {
  readonly authentication: "api-key" | "bearer" | "none";
  readonly expectedDescriptorId: string | undefined;
  readonly credentialResolver: ProviderCredentialResolver | undefined;
  readonly instanceId: string;
  readonly host: SubscriptionOAuthHost | undefined;
  readonly now: () => number;
}): Promise<DirectEndpointCredentialGate> {
  if (input.authentication === "none") return { kind: "plain", credential: undefined };
  let raw = "";
  try {
    raw = (await input.credentialResolver?.resolve(input.instanceId)) ?? "";
  } catch {
    return missingOrUnavailable(input.expectedDescriptorId);
  }
  const pointer = raw.length === 0 ? undefined : readSubscriptionOAuthCredential(raw);
  if (pointer === undefined) {
    if (raw.length === 0) return missingOrUnavailable(input.expectedDescriptorId);
    return { kind: "plain", credential: raw };
  }
  if (
    input.expectedDescriptorId !== undefined &&
    pointer.descriptorId !== input.expectedDescriptorId
  ) {
    return {
      kind: "report",
      readiness: "incompatible",
      credentialStatus: "stored",
      message: "This provider's sign-in does not match the expected account.",
    };
  }
  const resolution = await resolveSubscriptionOAuthBearer({
    credential: pointer,
    expectedDescriptorId: input.expectedDescriptorId,
    host: input.host,
    now: input.now,
  });
  if (resolution.kind !== "bearer") return report(resolution);
  return {
    kind: "oauth",
    credential: pointer,
    resolve: () => resolveBearerForRequest(input, pointer),
  };
}

export function directEndpointRequestResolver(input: {
  readonly authentication: "api-key" | "bearer" | "none";
  readonly expectedDescriptorId: string | undefined;
  readonly credentialResolver: ProviderCredentialResolver | undefined;
  readonly instanceId: string;
  readonly host: SubscriptionOAuthHost | undefined;
  readonly now: () => number;
}): ProviderCredentialResolver | undefined {
  if (input.authentication === "none") return undefined;
  let plain: string | undefined;
  return {
    has: async () => true,
    resolve: async () => {
      const raw = (await input.credentialResolver?.resolve(input.instanceId)) ?? "";
      const pointer = raw.length === 0 ? undefined : readSubscriptionOAuthCredential(raw);
      if (pointer !== undefined) return resolveBearerForRequest(input, pointer);
      if (raw.length === 0) {
        throw failure("unauthenticated", "The provider credential is missing or unavailable.");
      }
      plain = raw;
      return plain;
    },
  };
}

async function resolveBearerForRequest(
  input: {
    readonly expectedDescriptorId: string | undefined;
    readonly host: SubscriptionOAuthHost | undefined;
    readonly now: () => number;
  },
  pointer: SubscriptionOAuthCredential,
): Promise<string> {
  const resolution = await resolveSubscriptionOAuthBearer({
    credential: pointer,
    expectedDescriptorId: input.expectedDescriptorId,
    host: input.host,
    now: input.now,
  });
  if (resolution.kind === "bearer") return resolution.token;
  throw failure(report(resolution).readiness, report(resolution).message);
}

function missingOrUnavailable(
  expectedDescriptorId: string | undefined,
): DirectEndpointCredentialGate {
  if (expectedDescriptorId !== undefined) {
    return {
      kind: "report",
      readiness: "unauthenticated",
      credentialStatus: "missing",
      message: "Sign in before this provider can report what it supports.",
    };
  }
  return { kind: "plain", credential: "" };
}

function report(resolution: Exclude<SubscriptionOAuthResolution, { readonly kind: "bearer" }>): {
  readonly kind: "report";
  readonly readiness: "unauthenticated" | "unavailable" | "incompatible";
  readonly credentialStatus: ProviderCredentialStatus;
  readonly message: string;
} {
  if (resolution.kind === "incompatible") {
    return {
      kind: "report",
      readiness: "incompatible",
      credentialStatus: "stored",
      message: "This provider's sign-in does not match the expected account.",
    };
  }
  if (resolution.kind === "unavailable") {
    return {
      kind: "report",
      readiness: "unavailable",
      credentialStatus: "unavailable",
      message: "The sign-in service is unavailable. Try again.",
    };
  }
  return {
    kind: "report",
    readiness: "unauthenticated",
    credentialStatus: "missing",
    message:
      resolution.reason === "missing"
        ? "Sign in before this provider can report what it supports."
        : "Sign in again to use this provider.",
  };
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}
