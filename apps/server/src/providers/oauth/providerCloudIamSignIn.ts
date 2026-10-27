import type { ProviderInstance, ProviderInstanceId } from "@octant/contracts";
import {
  decodeHostOAuthJournalRecord,
  type HostOAuthDescriptor,
  type HostOAuthJournalRecord,
} from "@octant/contracts/host-oauth";
import {
  AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN,
  amazonBedrockCloudIamDescriptor,
  type CloudIamSignInDescriptor,
} from "@octant/domain";
import { authorizePrincipalAction, type PrincipalKind } from "@octant/domain/remote-access-policy";
import {
  encodeCloudIamCredential,
  readCloudIamCredential,
  sameCloudIamGrant,
} from "@octant/provider-sdk/cloud-iam";
import type { ProviderCredentialStore } from "../credentialBrokerClient";
import type { CloudIamBrokerPort } from "./cloudIamBroker";
import type { HostOAuthService } from "./hostOAuthService";

/**
 * Cloud single sign-on for one Amazon Bedrock instance. The descriptor is
 * built from the instance's own configuration on every command, never from
 * the request, so the portal, account, role, and signing scope the broker
 * binds the grant to are the ones the server holds. The only flow is the
 * portal's device authorization, and only the host-local command begins it.
 * Terms are acknowledged once per host in the same record every host-driven
 * sign-in uses, and the sign-in is journaled in the same public records,
 * which carry no token, code, or key.
 */
export interface CloudIamSignInDependencies {
  readonly broker: CloudIamBrokerPort;
  readonly terms: Pick<HostOAuthService, "offer" | "acknowledgeTerms">;
  readonly journal: { readonly append: (record: HostOAuthJournalRecord) => void };
  readonly credentials?: ProviderCredentialStore;
  readonly readInstance: (instanceId: ProviderInstanceId) => ProviderInstance | undefined;
  /** Where a sign-in the server could not record is reported, without its data. */
  readonly log?: (line: string) => void;
}

export type CloudIamSignInView =
  | { readonly kind: "terms-required"; readonly termsSummary: string }
  | {
      readonly kind: "awaiting-code";
      readonly attemptId: string;
      readonly verificationUri: string;
      readonly userCode: string;
      readonly expiresAt: string;
    }
  | { readonly kind: "waiting" }
  | { readonly kind: "signed-in"; readonly accountLabel: string }
  | { readonly kind: "refused"; readonly reason: CloudIamSignInRefusal };

/**
 * `portal-refused`: the portal's OIDC service refused the client, the start
 * address, or the code; `not-authorized`: the portal does not give this
 * person the account and role.
 */
export type CloudIamSignInRefusal =
  | "local-host-required"
  | "no-cloud-sign-in"
  | "denied"
  | "timeout"
  | "portal-refused"
  | "not-authorized"
  | "unavailable"
  | "invalid";

/** The sign-in an instance's configuration names, or undefined for any other instance. */
export function cloudIamSignInTarget(
  instance: ProviderInstance | undefined,
): { readonly descriptor: CloudIamSignInDescriptor; readonly accountLabel: string } | undefined {
  if (instance?.driverKind !== "amazon-bedrock") return undefined;
  const { cloudIam } = instance.configuration;
  return {
    descriptor: amazonBedrockCloudIamDescriptor(instance.configuration),
    accountLabel: `${String(cloudIam.roleName)} in account ${String(cloudIam.accountId)}`,
  };
}

/**
 * Begin a device-code sign-in for an instance. A remote principal is refused
 * before any broker call; terms not yet acknowledged on this host answer with
 * the sentence to show, and are recorded only when `acknowledgeTerms` says the
 * person accepted them.
 */
export async function beginCloudIamSignIn(input: {
  readonly dependencies: CloudIamSignInDependencies;
  readonly instanceId: ProviderInstanceId;
  readonly principal: PrincipalKind;
  readonly actorId: string;
  readonly acknowledgeTerms: boolean;
}): Promise<
  | { readonly view: CloudIamSignInView; readonly descriptor?: undefined }
  | {
      readonly view: Extract<CloudIamSignInView, { readonly kind: "awaiting-code" }>;
      readonly descriptor: CloudIamSignInDescriptor;
    }
> {
  const { dependencies } = input;
  if (
    authorizePrincipalAction({ principalKind: input.principal, action: "provider.oauth.begin" })
      .kind === "deny"
  ) {
    return { view: { kind: "refused", reason: "local-host-required" } };
  }
  const target = cloudIamSignInTarget(dependencies.readInstance(input.instanceId));
  if (target === undefined) return { view: { kind: "refused", reason: "no-cloud-sign-in" } };
  const termsDescriptor = termsOf(target.descriptor);
  if (input.acknowledgeTerms) {
    const recorded = dependencies.terms.acknowledgeTerms({
      principalKind: input.principal,
      actorId: input.actorId,
      descriptor: termsDescriptor,
    });
    if (recorded.kind === "refused") return { view: { kind: "refused", reason: "invalid" } };
  }
  if (dependencies.terms.offer(termsDescriptor).oauth.termsRequired) {
    return {
      view: { kind: "terms-required", termsSummary: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.termsSummary },
    };
  }
  let raw: unknown;
  try {
    raw = await dependencies.broker.begin({
      descriptor: target.descriptor,
      actorId: input.actorId,
      termsAcknowledgedAt: new Date().toISOString(),
    });
  } catch {
    return { view: refuse(dependencies, target.descriptor, "unavailable") };
  }
  if (
    isRecord(raw) &&
    raw.kind === "awaiting-consent" &&
    raw.flow === "device-code" &&
    typeof raw.attemptId === "string" &&
    typeof raw.verificationUri === "string" &&
    typeof raw.userCode === "string" &&
    typeof raw.expiresAt === "string"
  ) {
    append(dependencies, {
      name: "host-oauth.sign-in-started",
      descriptorId: target.descriptor.descriptorId,
      attemptId: raw.attemptId,
      flow: "device-code",
    });
    return {
      descriptor: target.descriptor,
      view: {
        kind: "awaiting-code",
        attemptId: raw.attemptId,
        verificationUri: raw.verificationUri,
        userCode: raw.userCode,
        expiresAt: raw.expiresAt,
      },
    };
  }
  return { view: refuse(dependencies, target.descriptor, refusalOf(raw)) };
}

/**
 * Read how an attempt the server began has ended. A finished sign-in stores
 * its pointer only when the instance still names the grant the attempt began
 * with; otherwise (the instance was removed or changed meanwhile) the new
 * grant is forgotten, so no session is left in the broker that nothing names.
 * A grant the new one replaces is forgotten as well.
 */
export async function settleCloudIamSignIn(input: {
  readonly dependencies: CloudIamSignInDependencies;
  readonly instanceId: ProviderInstanceId;
  readonly descriptor: CloudIamSignInDescriptor;
  readonly attemptId: string;
}): Promise<CloudIamSignInView> {
  const { dependencies, descriptor } = input;
  let raw: unknown;
  try {
    raw = await dependencies.broker.status(input.attemptId);
  } catch {
    return { kind: "waiting" };
  }
  if (!isRecord(raw) || raw.kind === "awaiting-consent") return { kind: "waiting" };
  if (raw.kind === "refused" || raw.kind === "unknown") {
    return refuse(dependencies, descriptor, refusalOf(raw), input.attemptId);
  }
  if (raw.kind !== "signed-in" || typeof raw.credentialRef !== "string") {
    return refuse(dependencies, descriptor, "unavailable", input.attemptId);
  }
  const credentialRef = raw.credentialRef;
  const current = cloudIamSignInTarget(dependencies.readInstance(input.instanceId));
  const pointer = {
    kind: "cloud-iam" as const,
    credentialRef,
    source: descriptor.source,
    scope: descriptor.scope,
  };
  if (
    current === undefined ||
    !sameCloudIamGrant(pointer, current.descriptor) ||
    dependencies.credentials === undefined
  ) {
    await dependencies.broker.revoke(credentialRef).catch(() => undefined);
    return refuse(dependencies, descriptor, "invalid", input.attemptId);
  }
  try {
    await forgetReplacedGrant(dependencies, input.instanceId, credentialRef);
    await dependencies.credentials.set(input.instanceId, encodeCloudIamCredential(pointer));
  } catch {
    (dependencies.log ?? console.warn)(
      "[cloud-iam] a sign-in finished but its pointer could not be stored.",
    );
    await dependencies.broker.revoke(credentialRef).catch(() => undefined);
    return refuse(dependencies, descriptor, "unavailable", input.attemptId);
  }
  append(dependencies, {
    name: "host-oauth.sign-in-completed",
    descriptorId: descriptor.descriptorId,
    attemptId: input.attemptId,
    credentialRef,
  });
  return { kind: "signed-in", accountLabel: current.accountLabel };
}

/**
 * Forget the grant an instance's pointer names: the broker asks the portal to
 * end the session and deletes the grant. The pointer itself is the caller's
 * to delete.
 */
export async function forgetCloudIamGrant(
  broker: Pick<CloudIamBrokerPort, "revoke">,
  stored: string,
): Promise<boolean> {
  const pointer = readCloudIamCredential(stored);
  if (pointer === undefined) return false;
  const answer = await broker.revoke(pointer.credentialRef);
  if (!isRecord(answer) || answer.kind !== "revoked") {
    throw new Error("Octant credential broker could not forget the cloud sign-in.");
  }
  return true;
}

async function forgetReplacedGrant(
  dependencies: CloudIamSignInDependencies,
  instanceId: ProviderInstanceId,
  nextCredentialRef: string,
): Promise<void> {
  let stored: string;
  try {
    stored = (await dependencies.credentials?.resolve(instanceId)) ?? "";
  } catch {
    return;
  }
  const prior = readCloudIamCredential(stored);
  if (prior === undefined || prior.credentialRef === nextCredentialRef) return;
  await dependencies.broker.revoke(prior.credentialRef).catch(() => undefined);
}

/** The terms record's key: the descriptor and terms ids every host-driven sign-in uses. */
function termsOf(
  descriptor: CloudIamSignInDescriptor,
): Pick<HostOAuthDescriptor, "descriptorId" | "termsId"> {
  return {
    descriptorId: descriptor.descriptorId as HostOAuthDescriptor["descriptorId"],
    termsId: descriptor.termsId as HostOAuthDescriptor["termsId"],
  };
}

function refusalOf(raw: unknown): CloudIamSignInRefusal {
  const reason = isRecord(raw) ? raw.reason : undefined;
  switch (reason) {
    case "denied":
    case "timeout":
    case "not-authorized":
    case "unavailable":
      return reason;
    case "exchange-refused":
      return "portal-refused";
    default:
      return isRecord(raw) && raw.kind === "unknown" ? "timeout" : "invalid";
  }
}

function refuse(
  dependencies: CloudIamSignInDependencies,
  descriptor: CloudIamSignInDescriptor,
  reason: CloudIamSignInRefusal,
  attemptId?: string,
): CloudIamSignInView {
  append(dependencies, {
    name: "host-oauth.sign-in-refused",
    descriptorId: descriptor.descriptorId,
    reason,
    ...(attemptId === undefined ? {} : { attemptId }),
  });
  return { kind: "refused", reason };
}

/** A record that cannot be journaled is reported by its name alone, never dropped silently. */
function append(
  dependencies: CloudIamSignInDependencies,
  record: Readonly<Record<string, unknown>> & { readonly name: string },
): void {
  try {
    dependencies.journal.append(decodeHostOAuthJournalRecord(record));
  } catch {
    (dependencies.log ?? console.warn)(`[cloud-iam] could not journal ${record.name}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
