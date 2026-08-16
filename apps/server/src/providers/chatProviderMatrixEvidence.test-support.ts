import type { ProviderInstance } from "@octant/contracts";
import type { ProviderChatConformanceEvidence } from "@octant/provider-sdk/chat-conformance";
import type { ProviderConformanceEvidence } from "@octant/provider-sdk/conformance";

export type RegisteredProviderDriverKind = ProviderInstance["driverKind"];

export interface ChatProviderMatrixEvidence {
  readonly providerKind: RegisteredProviderDriverKind;
  readonly streamingOrHonestDegradation: boolean;
  readonly attachmentCapabilityHonest: boolean;
  readonly researchCapabilityHonest: boolean;
  readonly normalizedOutcomes: {
    readonly usageCapabilityHonest: boolean;
    readonly citationsCapabilityHonest: boolean;
    readonly citationsNormalized: boolean;
    readonly appManagedToolRoundTrip: boolean;
    readonly interrupted: boolean;
    readonly resumed: boolean;
    readonly failureClassified: boolean;
    readonly released: boolean;
  };
}

interface ProviderEvidenceParts {
  provider?: ProviderConformanceEvidence;
  chat?: ProviderChatConformanceEvidence;
}

const evidenceByProviderKind = new Map<RegisteredProviderDriverKind, ProviderEvidenceParts>();

export function recordProviderConformanceEvidence(
  providerKind: RegisteredProviderDriverKind,
  provider: ProviderConformanceEvidence,
): void {
  evidenceByProviderKind.set(providerKind, {
    ...evidenceByProviderKind.get(providerKind),
    provider,
  });
}

export function recordProviderChatConformanceEvidence(
  providerKind: RegisteredProviderDriverKind,
  chat: ProviderChatConformanceEvidence,
): void {
  evidenceByProviderKind.set(providerKind, {
    ...evidenceByProviderKind.get(providerKind),
    chat,
  });
}

export function readChatProviderMatrixEvidence(
  providerKind: RegisteredProviderDriverKind,
): ChatProviderMatrixEvidence | undefined {
  const parts = evidenceByProviderKind.get(providerKind);
  if (parts?.provider === undefined || parts.chat === undefined) return undefined;

  return {
    providerKind,
    streamingOrHonestDegradation: parts.provider.streamedInOrder,
    attachmentCapabilityHonest: parts.chat.nativeAttachmentHonest,
    researchCapabilityHonest: parts.provider.researchCapabilityHonest,
    normalizedOutcomes: {
      usageCapabilityHonest: parts.provider.usageCapabilityHonest,
      citationsCapabilityHonest: parts.provider.citationsCapabilityHonest,
      citationsNormalized: parts.chat.citationsNormalized,
      appManagedToolRoundTrip: parts.chat.appManagedToolRoundTrip,
      interrupted: parts.provider.interrupted,
      resumed: parts.provider.resumed,
      failureClassified: parts.provider.failureClassified,
      released: parts.provider.released && parts.chat.released,
    },
  };
}

export function readProviderConformanceEvidence(
  providerKind: RegisteredProviderDriverKind,
): ProviderConformanceEvidence | undefined {
  return evidenceByProviderKind.get(providerKind)?.provider;
}
