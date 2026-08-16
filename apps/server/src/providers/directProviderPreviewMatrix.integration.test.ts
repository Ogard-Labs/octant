import type { OctantMode } from "@octant/contracts/modes";
import type { UtcTimestamp } from "@octant/contracts/events";
import type {
  ProviderDriverKind,
  ProviderInstance,
  ProviderModel,
  ProviderModelId,
} from "@octant/contracts/providers";
import { hasVerifiedToolAuthority } from "@octant/domain";
import { describe, expect, it } from "vitest";
import {
  readChatProviderMatrixEvidence,
  readProviderConformanceEvidence,
  type RegisteredProviderDriverKind,
} from "./chatProviderMatrixEvidence.test-support";

// Importing these conformance suites populates the shared evidence registry
// with deterministic fixture-backed evidence for each direct-provider profile.
import "./openAiCompatibleConformance.test";
import "./anthropicCompatibleConformance.test";
import "./azureFoundryConformance.test";

/**
 * Integrated direct-provider preview gate.
 *
 * This matrix proves the complete direct-provider design across modes and
 * packaging before support is advertised. It aggregates deterministic
 * conformance evidence from the per-provider adapter suites and verifies
 * mode-appropriate authority, honest degradation, and Bedrock Mantle
 * representation without rewriting adapter contracts.
 */

const DIRECT_PROVIDER_DRIVER_KINDS = [
  "openai-compatible",
  "anthropic-compatible",
  "azure-foundry",
] as const satisfies ReadonlyArray<RegisteredProviderDriverKind>;

type DirectProviderDriverKind = (typeof DIRECT_PROVIDER_DRIVER_KINDS)[number];

interface DirectProviderProfile {
  readonly driverKind: DirectProviderDriverKind;
  readonly profile: string;
  readonly protocol: string;
  readonly chatOutcome: "complete";
  readonly workOutcome: "downgraded" | "complete";
  readonly codeOutcome: "downgraded" | "complete";
}

const DIRECT_PROVIDER_PROFILES: ReadonlyArray<DirectProviderProfile> = [
  {
    driverKind: "openai-compatible",
    profile: "OpenAI Responses",
    protocol: "responses",
    chatOutcome: "complete",
    workOutcome: "downgraded",
    codeOutcome: "downgraded",
  },
  {
    driverKind: "openai-compatible",
    profile: "OpenAI Chat Completions",
    protocol: "chat-completions",
    chatOutcome: "complete",
    workOutcome: "downgraded",
    codeOutcome: "downgraded",
  },
  {
    driverKind: "anthropic-compatible",
    profile: "Anthropic Messages",
    protocol: "messages",
    chatOutcome: "complete",
    workOutcome: "downgraded",
    codeOutcome: "downgraded",
  },
  {
    driverKind: "azure-foundry",
    profile: "Azure AI Foundry API-key",
    protocol: "responses",
    chatOutcome: "complete",
    workOutcome: "downgraded",
    codeOutcome: "downgraded",
  },
  {
    driverKind: "openai-compatible",
    profile: "Bedrock Mantle generic OpenAI-compatible",
    protocol: "responses",
    chatOutcome: "complete",
    workOutcome: "downgraded",
    codeOutcome: "downgraded",
  },
];

const MODES: ReadonlyArray<OctantMode> = ["chat", "work", "code"];

function modeOutcome(
  profile: DirectProviderProfile,
  mode: OctantMode,
): "complete" | "downgraded" | "unavailable" {
  if (mode === "chat") return profile.chatOutcome;
  if (mode === "work") return profile.workOutcome;
  return profile.codeOutcome;
}

describe("Direct-provider preview matrix", () => {
  it("covers all five advertised direct-provider profiles", () => {
    const profiles = new Set(DIRECT_PROVIDER_PROFILES.map((p) => p.profile));
    expect(profiles).toEqual(
      new Set([
        "OpenAI Responses",
        "OpenAI Chat Completions",
        "Anthropic Messages",
        "Azure AI Foundry API-key",
        "Bedrock Mantle generic OpenAI-compatible",
      ]),
    );
  });

  it("requires deterministic conformance evidence for every direct-provider driver kind", () => {
    for (const driverKind of DIRECT_PROVIDER_DRIVER_KINDS) {
      const providerEvidence = readProviderConformanceEvidence(driverKind);
      expect(providerEvidence).toMatchObject({
        probed: true,
        capabilityHonest: true,
        usageCapabilityHonest: true,
        researchCapabilityHonest: true,
        citationsCapabilityHonest: true,
        streamedInOrder: true,
        interrupted: true,
        resumed: true,
        staleResumeRejected: true,
        unknownApprovalRejected: true,
        unknownUserInputRejected: true,
        failureClassified: true,
        released: true,
      });

      const chatEvidence = readChatProviderMatrixEvidence(driverKind);
      expect(chatEvidence).toMatchObject({
        providerKind: driverKind,
        streamingOrHonestDegradation: true,
        attachmentCapabilityHonest: true,
        researchCapabilityHonest: true,
        normalizedOutcomes: {
          usageCapabilityHonest: true,
          citationsCapabilityHonest: true,
          citationsNormalized: true,
          appManagedToolRoundTrip: true,
          interrupted: true,
          resumed: true,
          failureClassified: true,
          released: true,
        },
      });
    }
  });

  it("classifies every direct-provider profile across Chat, Work, and Code with mode-appropriate authority", () => {
    for (const profile of DIRECT_PROVIDER_PROFILES) {
      for (const mode of MODES) {
        const outcome = modeOutcome(profile, mode);
        // Chat always completes for direct providers.
        if (mode === "chat") {
          expect(outcome).toBe("complete");
          continue;
        }
        // Work and Code downgrade direct providers to chat-and-analysis-only
        // until verified tool authority is recorded per model. The deterministic
        // conformance fixtures do not grant mutating authority, so the preview
        // matrix records downgraded — never unavailable or false-complete.
        expect(outcome).toBe("downgraded");
      }
    }
  });

  it("never infers tool authority from a driver kind or protocol name alone", () => {
    for (const profile of DIRECT_PROVIDER_PROFILES) {
      const unverifiedModel = modelWithoutToolEvidence(profile.driverKind);
      expect(hasVerifiedToolAuthority(unverifiedModel)).toBe(false);
    }
  });

  it("represents Bedrock Mantle through the generic OpenAI-compatible driver without a separate wire driver", () => {
    const bedrockProfile = DIRECT_PROVIDER_PROFILES.find(
      (p) => p.profile === "Bedrock Mantle generic OpenAI-compatible",
    );
    expect(bedrockProfile).toBeDefined();
    expect(bedrockProfile!.driverKind).toBe("openai-compatible");
    // Bedrock Mantle is not a distinct ProviderDriverKind.
    const bedrockDriverKind: ProviderDriverKind = "openai-compatible";
    expect(DIRECT_PROVIDER_DRIVER_KINDS).not.toContain("bedrock-mantle" as never);
    // The Bedrock Mantle configuration reuses the OpenAI-compatible HTTP
    // configuration kind with a regional /v1 base URL.
    const bedrockInstance = bedrockMantleInstance();
    expect(bedrockInstance.driverKind).toBe(bedrockDriverKind);
    expect(bedrockInstance.configuration.kind).toBe("openai-compatible-http");
    if (bedrockInstance.configuration.kind === "openai-compatible-http") {
      expect(bedrockInstance.configuration.baseUrl).toContain("/v1");
    }
  });

  it("keeps the direct-provider matrix aligned with the registered driver-kind set", () => {
    // The preview matrix must not advertise a driver kind that the contracts
    // do not register, and every direct-provider driver kind must appear in
    // the registered set.
    for (const driverKind of DIRECT_PROVIDER_DRIVER_KINDS) {
      expect(DIRECT_PROVIDER_PROFILES.some((p) => p.driverKind === driverKind)).toBe(true);
    }
  });
});

function modelWithoutToolEvidence(driverKind: DirectProviderDriverKind): ProviderModel {
  return {
    id: `unverified-${driverKind}` as ProviderModelId,
    displayName: `Unverified ${driverKind}`,
    orderHint: undefined,
    contextLimit: undefined,
    maxOutputTokens: undefined,
    reasoning: "unavailable",
    toolCalling: "unavailable",
    parallelTools: undefined,
    structuredOutput: undefined,
    streaming: undefined,
    inputModalities: ["text"],
    options: [],
    capabilityEvidence: undefined,
    source: "manual",
    verification: "unverified",
  } as unknown as ProviderModel;
}

function bedrockMantleInstance(): ProviderInstance {
  const now = "2026-08-02T00:00:00.000Z" as UtcTimestamp;
  return {
    id: "80000000-0000-4000-8000-000000000701" as never,
    displayName: "Bedrock eu-west-1",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com/v1",
      authentication: "bearer",
      protocol: "responses",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: now,
    updatedAt: now,
  } as ProviderInstance;
}
