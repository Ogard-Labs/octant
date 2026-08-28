import { describe, expect, it } from "vitest";
import {
  readChatProviderMatrixEvidence,
  type RegisteredProviderDriverKind,
} from "../providers/chatProviderMatrixEvidence.test-support";

import "../providers/acpConformance.test";
import "../providers/anthropicCompatibleConformance.test";
import "../providers/azureFoundryConformance.test";
import "../providers/claudeConformance.test";
import "../providers/codexConformance.test";
import "../providers/ollamaConformance.test";
import "../providers/openAiCompatibleConformance.test";
import "../providers/openCodeConformance.test";
import "../providers/piConformance.test";

const REGISTERED_PROVIDER_DRIVER_KINDS = {
  opencode: true,
  codex: true,
  claude: true,
  "kimi-code": true,
  kilo: true,
  "mistral-vibe": true,
  grok: true,
  devin: true,
  pi: true,
  "oh-my-pi": true,
  ollama: true,
  "openai-compatible": true,
  "anthropic-compatible": true,
  "azure-foundry": true,
  "openai-image": true,
  "gemini-native-image": true,
} as const satisfies Readonly<Record<RegisteredProviderDriverKind, true>>;

const registeredProviderDriverKinds = Object.keys(
  REGISTERED_PROVIDER_DRIVER_KINDS,
) as ReadonlyArray<RegisteredProviderDriverKind>;

type ChatOutcome = "complete" | "unavailable";

const CHAT_OUTCOMES = {
  opencode: "complete",
  codex: "complete",
  claude: "complete",
  "kimi-code": "complete",
  kilo: "complete",
  "mistral-vibe": "complete",
  grok: "complete",
  devin: "complete",
  pi: "complete",
  "oh-my-pi": "unavailable",
  ollama: "complete",
  "openai-compatible": "complete",
  "anthropic-compatible": "complete",
  "azure-foundry": "complete",
  "openai-image": "unavailable",
  "gemini-native-image": "unavailable",
} as const satisfies Readonly<Record<RegisteredProviderDriverKind, ChatOutcome>>;

describe("Chat provider matrix", () => {
  it("consumes Chat conformance evidence for every registered provider kind", () => {
    expect(new Set(registeredProviderDriverKinds).size).toBe(16);

    for (const driverKind of registeredProviderDriverKinds) {
      if (CHAT_OUTCOMES[driverKind] === "unavailable") continue;
      expect(readChatProviderMatrixEvidence(driverKind)).toMatchObject({
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
});
