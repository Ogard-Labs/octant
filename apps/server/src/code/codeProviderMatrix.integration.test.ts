import type { ProviderDriverKind } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { readProviderConformanceEvidence } from "../providers/chatProviderMatrixEvidence.test-support";

import "../providers/acpConformance.test";
import "../providers/anthropicCompatibleConformance.test";
import "../providers/azureFoundryConformance.test";
import "../providers/claudeConformance.test";
import "../providers/codexConformance.test";
import "../providers/ollamaConformance.test";
import "../providers/openAiCompatibleConformance.test";
import "../providers/openCodeConformance.test";
import "../providers/piConformance.test";

type CodeOutcome = "complete" | "downgraded" | "unavailable";

const CODE_OUTCOMES = {
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
  ollama: "downgraded",
  "openai-compatible": "downgraded",
  "anthropic-compatible": "downgraded",
  "azure-foundry": "downgraded",
  "openai-image": "unavailable",
  "gemini-native-image": "unavailable",
} as const satisfies Readonly<Record<ProviderDriverKind, CodeOutcome>>;

describe("Code provider matrix", () => {
  it("classifies every declared provider kind with conformance or explicit unavailability", () => {
    expect(Object.keys(CODE_OUTCOMES)).toHaveLength(16);
    for (const [providerKind, outcome] of Object.entries(CODE_OUTCOMES) as Array<
      [ProviderDriverKind, CodeOutcome]
    >) {
      if (outcome === "unavailable") {
        expect(["oh-my-pi", "openai-image", "gemini-native-image"]).toContain(providerKind);
        continue;
      }
      const evidence = readProviderConformanceEvidence(providerKind);
      expect(evidence).toMatchObject({
        probed: true,
        capabilityHonest: true,
        streamedInOrder: true,
        interrupted: true,
        resumed: true,
        failureClassified: true,
        released: true,
      });
    }
  });
});
