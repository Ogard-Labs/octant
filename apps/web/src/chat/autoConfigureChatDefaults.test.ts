import { describe, expect, it } from "vitest";
import { decodeChatBootstrap } from "@octant/contracts/chat";
import { autoConfigureChatDefaults, chatDefaultModelCommand } from "./autoConfigureChatDefaults";

const now = "2026-08-06T00:00:00.000Z";

describe("autoConfigureChatDefaults", () => {
  it("selects the first eligible detected provider model for an unconfigured profile", () => {
    const bootstrap = decodeChatBootstrap({
      settings: {
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm.",
        version: 0,
        updatedAt: now,
      },
      threads: [],
    });

    expect(
      autoConfigureChatDefaults(bootstrap.settings, [
        {
          instance: {
            id: "10000000-0000-4000-8000-000000000001",
            displayName: "Codex CLI",
          },
          readiness: "ready",
          sections: [
            {
              label: "Models",
              models: [
                {
                  model: { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
                },
              ],
            },
          ],
        } as never,
      ]),
    ).toEqual({
      kind: "update-chat-settings",
      expectedVersion: 0,
      defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
      defaultModelId: "gpt-5.6-luna",
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      defaultPersonalityInstructions: "Be calm.",
    });
  });

  it("does not replace an explicit default or select an ineligible group", () => {
    const configured = decodeChatBootstrap({
      settings: {
        defaultProviderInstanceId: "10000000-0000-4000-8000-000000000002",
        defaultModelId: "model-a",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm.",
        version: 2,
        updatedAt: now,
      },
      threads: [],
    }).settings;
    expect(autoConfigureChatDefaults(configured, [])).toBeUndefined();
  });

  it("carries an existing fallback through a default-model replace so a model choice cannot clear it", () => {
    const fallback = {
      providerInstanceId: "10000000-0000-4000-8000-000000000003",
      modelId: "model-b",
    };
    const settings = decodeChatBootstrap({
      settings: {
        defaultProviderInstanceId: "10000000-0000-4000-8000-000000000002",
        defaultModelId: "model-a",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        searxngBaseUrl: "https://search.example.test",
        defaultPersonalityInstructions: "Be calm.",
        providerFallback: fallback,
        version: 2,
        updatedAt: now,
      },
      threads: [],
    }).settings;

    expect(
      chatDefaultModelCommand(settings, {
        providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
        modelId: "gpt-5.6-luna" as never,
      }),
    ).toEqual({
      kind: "update-chat-settings",
      expectedVersion: 2,
      defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
      defaultModelId: "gpt-5.6-luna",
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      defaultPersonalityInstructions: "Be calm.",
      searxngBaseUrl: "https://search.example.test",
      providerFallback: fallback,
    });
  });
});
