import {
  decodeProviderInstance,
  decodeProviderModel,
  decodeProviderModelId,
  type ProviderInstance,
  type ProviderModel,
  type ProviderObservedState,
  type UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  buildModelPickerGroups,
  driverLabel,
  endpointHostOf,
  filterModelPickerGroups,
  modelBadges,
  modelCatalog,
  pickerCatalogs,
  type ModelPickerInput,
} from "./modelPickerPolicy";
import { isDraftSelectionSelectable, resolveDraftProviderSelection } from "./modelPickerPolicy";

const now = "2026-07-21T10:00:00.000Z" as UtcTimestamp;

function openAiInstance(overrides: {
  id: string;
  displayName: string;
  baseUrl?: string;
  enabled?: boolean;
  manualModelIds?: string[];
}): ProviderInstance {
  return decodeProviderInstance({
    id: overrides.id,
    displayName: overrides.displayName,
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: overrides.baseUrl ?? "https://gateway.example/v1/",
      authentication: "none",
      protocol: "responses",
      manualModelIds: overrides.manualModelIds ?? [],
    },
    enabled: overrides.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function codexInstance(id: string, displayName: string, enabled = true): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName,
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
    enabled,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function openAiImageInstance(id: string, displayName: string): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName,
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2"],
      defaultModel: "gpt-image-2",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function geminiImageInstance(id: string, displayName: string): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName,
    driverKind: "gemini-native-image",
    configuration: {
      kind: "gemini-native-image-http",
      modelAllowlist: ["gemini-3.1-flash-image"],
      defaultModel: "gemini-3.1-flash-image",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function foundryInstance(id: string, displayName: string): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName,
    driverKind: "azure-foundry",
    configuration: {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "api-key",
      protocol: "responses",
      manualModelIds: ["deployment-a"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function model(
  input: Omit<Partial<ProviderModel>, "id"> & {
    id: string;
    displayName: string;
  },
): ProviderModel {
  return decodeProviderModel({
    source: "discovered",
    verification: "verified",
    reasoning: "unavailable",
    inputModalities: ["text"],
    options: [],
    ...input,
  });
}

function observed(
  instanceId: string,
  models: ReadonlyArray<ProviderModel>,
  overrides: Partial<ProviderObservedState> = {},
): ProviderObservedState {
  return {
    instanceId: instanceId as ProviderObservedState["instanceId"],
    readiness: "ready",
    processState: "running",
    models,
    capabilities: {
      streaming: "supported",
      resume: "unavailable",
      interruption: "supported",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "unavailable",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "unavailable",
      diffs: "unavailable",
      taskProgress: "supported",
      nativeChildAgents: "unavailable",
      nativeAttachments: "unavailable",
      nativeWebResearch: "unavailable",
      appManagedTools: "supported",
      citations: "unavailable",
    },
    observedAt: now,
    ...overrides,
  } as ProviderObservedState;
}

function toolEvidence(support: "supported" | "unsupported" | "unavailable") {
  return [
    {
      capability: "tool-calling" as const,
      support,
      source: "endpoint-observation" as const,
      confidence: "high" as const,
      protocol: "responses" as const,
      observedAt: now,
      invalidated: false,
    },
  ];
}

function input(
  overrides: Partial<ModelPickerInput> & { instances: ReadonlyArray<ProviderInstance> },
): ModelPickerInput {
  return {
    observedByInstance: new Map(),
    mode: "chat",
    ...overrides,
  };
}

describe("model picker policy", () => {
  describe("driverLabel", () => {
    it("labels every driver kind without implying authority from branding", () => {
      expect(driverLabel("codex")).toBe("Codex CLI");
      expect(driverLabel("claude")).toBe("Claude Agent SDK");
      expect(driverLabel("openai-compatible")).toBe("OpenAI-compatible HTTP");
      expect(driverLabel("anthropic-compatible")).toBe("Anthropic-compatible HTTP");
      expect(driverLabel("azure-foundry")).toBe("Azure AI Foundry");
      expect(driverLabel("openai-image")).toBe("OpenAI Image");
      expect(driverLabel("gemini-native-image")).toBe("Gemini Image");
      expect(driverLabel("ollama")).toBe("Ollama");
      expect(driverLabel("opencode")).toBe("OpenCode CLI");
      expect(driverLabel("kimi-code")).toBe("Kimi Code ACP");
      expect(driverLabel("kilo")).toBe("Kilo ACP");
      expect(driverLabel("devin")).toBe("Devin ACP");
      expect(driverLabel("pi")).toBe("Pi RPC");
      expect(driverLabel("mistral-vibe")).toBe("Mistral Vibe ACP");
      expect(driverLabel("grok")).toBe("Grok Build ACP");
      expect(driverLabel("goose")).toBe("Goose ACP");
      expect(driverLabel("glm")).toBe("GLM Agent ACP");
      expect(driverLabel("gemini")).toBe("Gemini CLI ACP");
      expect(driverLabel("copilot")).toBe("GitHub Copilot ACP");
      expect(driverLabel("cline")).toBe("Cline ACP");
      expect(driverLabel("qwen")).toBe("Qwen Code ACP");
    });
  });

  describe("endpointHostOf", () => {
    it("extracts the host from HTTP provider base URLs", () => {
      expect(
        endpointHostOf(
          openAiInstance({
            id: "00000000-0000-4000-8000-000000000001",
            displayName: "A",
            baseUrl: "https://gateway.example/v1/",
          }),
        ),
      ).toBe("gateway.example");
    });
    it("returns undefined for CLI providers", () => {
      expect(
        endpointHostOf(codexInstance("00000000-0000-4000-8000-000000000002", "A")),
      ).toBeUndefined();
    });
  });

  describe("modelBadges", () => {
    it("emits a Tools badge only for verified tool-calling evidence", () => {
      const withTools = model({
        id: "t",
        displayName: "T",
        toolCalling: "supported",
        capabilityEvidence: toolEvidence("supported"),
      });
      const without = model({ id: "n", displayName: "N", toolCalling: "unavailable" });
      expect(modelBadges(withTools).some((b) => b.kind === "tools")).toBe(true);
      expect(modelBadges(without).some((b) => b.kind === "tools")).toBe(false);
    });
    it("emits a Vision badge when image input is supported", () => {
      const vision = model({ id: "v", displayName: "V", inputModalities: ["text", "image"] });
      expect(modelBadges(vision).some((b) => b.kind === "vision")).toBe(true);
    });
    it("emits a Reasoning badge when reasoning is supported", () => {
      const reasoning = model({ id: "r", displayName: "R", reasoning: "supported" });
      expect(modelBadges(reasoning).some((b) => b.kind === "reasoning")).toBe(true);
    });
    it("emits a context-limit badge when a context limit is present", () => {
      const ctx = model({ id: "c", displayName: "C", contextLimit: 128_000 });
      const badge = modelBadges(ctx).find((b) => b.kind === "context-limit");
      expect(badge).toBeDefined();
      expect(badge?.label).toContain("128");
    });
    it("keeps badges sparse and never invents capabilities", () => {
      const plain = model({ id: "p", displayName: "P" });
      expect(modelBadges(plain)).toEqual([]);
    });
  });

  describe("buildModelPickerGroups", () => {
    it("groups models by provider instance in explicit user order", () => {
      const zulu = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "Zulu gateway",
      });
      const alpha = openAiInstance({
        id: "00000000-0000-4000-8000-000000000102",
        displayName: "Alpha gateway",
      });
      const observedByInstance = new Map([
        [zulu.id, observed(zulu.id, [model({ id: "z1", displayName: "Z1" })])],
        [alpha.id, observed(alpha.id, [model({ id: "a1", displayName: "A1" })])],
      ]);
      const groups = buildModelPickerGroups(
        input({
          instances: [zulu, alpha],
          observedByInstance,
          providerOrder: [alpha.id, zulu.id],
        }),
      );
      expect(groups.map((g) => g.instance.displayName)).toEqual(["Alpha gateway", "Zulu gateway"]);
    });

    it("falls back to natural ordering when no provider order is set", () => {
      const zulu = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "Zulu gateway",
      });
      const alpha = openAiInstance({
        id: "00000000-0000-4000-8000-000000000102",
        displayName: "Alpha gateway",
      });
      const observedByInstance = new Map([
        [zulu.id, observed(zulu.id, [model({ id: "z1", displayName: "Z1" })])],
        [alpha.id, observed(alpha.id, [model({ id: "a1", displayName: "A1" })])],
      ]);
      const groups = buildModelPickerGroups(
        input({ instances: [zulu, alpha], observedByInstance }),
      );
      expect(groups.map((g) => g.instance.displayName)).toEqual(["Alpha gateway", "Zulu gateway"]);
    });

    it("omits image profiles from every Chat, Work, and Code picker", () => {
      const chat = openAiInstance({
        id: "00000000-0000-4000-8000-000000000201",
        displayName: "Chat gateway",
      });
      const openAiImage = openAiImageInstance("00000000-0000-4000-8000-000000000202", "GPT Image");
      const geminiImage = geminiImageInstance(
        "00000000-0000-4000-8000-000000000203",
        "Gemini Image",
      );
      const imageModel = model({ id: "gpt-image-2", displayName: "GPT Image 2" });
      const geminiModel = model({
        id: "gemini-3.1-flash-image",
        displayName: "Gemini 3.1 Flash Image",
      });
      const observedByInstance = new Map([
        [chat.id, observed(chat.id, [model({ id: "chat-1", displayName: "Chat 1" })])],
        [openAiImage.id, observed(openAiImage.id, [imageModel])],
        [geminiImage.id, observed(geminiImage.id, [geminiModel])],
      ]);
      const pickerInput = {
        instances: [chat, openAiImage, geminiImage],
        observedByInstance,
      };

      for (const mode of ["chat", "work", "code"] as const) {
        const groups = buildModelPickerGroups(input({ ...pickerInput, mode }));
        expect(groups.map((group) => group.instance.driverKind)).toEqual(["openai-compatible"]);
        expect(groups.some((group) => group.instance.driverKind === "openai-image")).toBe(false);
        expect(groups.some((group) => group.instance.driverKind === "gemini-native-image")).toBe(
          false,
        );
      }
    });

    it("keeps duplicate model IDs distinct by provider instance", () => {
      const a = openAiInstance({ id: "00000000-0000-4000-8000-000000000101", displayName: "A" });
      const b = openAiInstance({ id: "00000000-0000-4000-8000-000000000102", displayName: "B" });
      const observedByInstance = new Map([
        [a.id, observed(a.id, [model({ id: "shared", displayName: "Shared" })])],
        [b.id, observed(b.id, [model({ id: "shared", displayName: "Shared" })])],
      ]);
      const groups = buildModelPickerGroups(input({ instances: [a, b], observedByInstance }));
      expect(groups).toHaveLength(2);
      expect(groups[0]!.sections[0]!.models[0]!.model.id).toBe("shared");
      expect(groups[1]!.sections[0]!.models[0]!.model.id).toBe("shared");
    });

    it("preserves manual model order, then provider hints, then natural fallback", () => {
      const instance = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "G",
        manualModelIds: ["manual-b", "manual-a"],
      });
      const models = [
        model({ id: "zeta", displayName: "Zeta" }),
        model({ id: "hinted", displayName: "Hinted", orderHint: 0 }),
        model({
          id: "manual-b",
          displayName: "Manual B",
          source: "manual",
          verification: "unverified",
        }),
        model({
          id: "manual-a",
          displayName: "Manual A",
          source: "manual",
          verification: "unverified",
        }),
      ];
      const observedByInstance = new Map([[instance.id, observed(instance.id, models)]]);
      const groups = buildModelPickerGroups(input({ instances: [instance], observedByInstance }));
      const ids = groups[0]!.sections[0]!.models.map((m) => String(m.model.id));
      expect(ids).toEqual(["manual-b", "manual-a", "hinted", "zeta"]);
    });

    it("exposes driver label, endpoint host, execution host, and readiness per group", () => {
      const instance = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "G",
        baseUrl: "https://gateway.example/v1/",
      });
      const observedByInstance = new Map([
        [
          instance.id,
          observed(instance.id, [model({ id: "m", displayName: "M" })], { readiness: "degraded" }),
        ],
      ]);
      const groups = buildModelPickerGroups(input({ instances: [instance], observedByInstance }));
      expect(groups[0]!.driverLabel).toBe("OpenAI-compatible HTTP");
      expect(groups[0]!.endpointHost).toBe("gateway.example");
      expect(groups[0]!.executionHost).toBeDefined();
      expect(groups[0]!.readiness).toBe("degraded");
    });

    it("sections Work/Code into tool-capable and chat-and-analysis-only", () => {
      const instance = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "G",
      });
      const toolModel = model({
        id: "tool",
        displayName: "Tool",
        toolCalling: "supported",
        capabilityEvidence: toolEvidence("supported"),
      });
      const chatModel = model({ id: "chat", displayName: "Chat", toolCalling: "unavailable" });
      const observedByInstance = new Map([
        [instance.id, observed(instance.id, [chatModel, toolModel])],
      ]);
      const groups = buildModelPickerGroups(
        input({ instances: [instance], observedByInstance, mode: "code" }),
      );
      const sections = groups[0]!.sections.map((s) => s.id);
      expect(sections).toContain("tool-capable");
      expect(sections).toContain("chat-and-analysis-only");
      const toolSection = groups[0]!.sections.find((s) => s.id === "tool-capable")!;
      expect(toolSection.models.map((m) => String(m.model.id))).toEqual(["tool"]);
      const chatSection = groups[0]!.sections.find((s) => s.id === "chat-and-analysis-only")!;
      expect(chatSection.models.map((m) => String(m.model.id))).toEqual(["chat"]);
      expect(chatSection.models[0]!.unavailableReason).toBeDefined();
    });

    it("offers a per-deployment verified Azure Foundry model for Work", () => {
      const instance = foundryInstance("00000000-0000-4000-8000-000000000103", "Foundry");
      const deployment = model({ id: "deployment-a", displayName: "Deployment A" });
      const observedByInstance = new Map([
        [
          instance.id,
          observed(instance.id, [deployment], {
            capabilities: {
              ...observed(instance.id, []).capabilities,
              appManagedTools: "unsupported",
            },
            verifiedToolModelIds: [deployment.id],
          }),
        ],
      ]);

      const groups = buildModelPickerGroups(
        input({ instances: [instance], observedByInstance, mode: "work" }),
      );
      expect(groups[0]!.sections.find((section) => section.id === "tool-capable")?.models).toEqual([
        expect.objectContaining({ model: deployment, toolCapable: true }),
      ]);
    });

    it("does not section Chat into tool/chat-only buckets", () => {
      const instance = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "G",
      });
      const observedByInstance = new Map([
        [instance.id, observed(instance.id, [model({ id: "m", displayName: "M" })])],
      ]);
      const groups = buildModelPickerGroups(
        input({ instances: [instance], observedByInstance, mode: "chat" }),
      );
      expect(groups[0]!.sections).toHaveLength(1);
      expect(groups[0]!.sections[0]!.id).toBe("all-models");
    });

    it("retains an unavailable current selection with an actionable status", () => {
      const instance = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "G",
      });
      const observedByInstance = new Map([
        [instance.id, observed(instance.id, [model({ id: "m", displayName: "M" })])],
      ]);
      const groups = buildModelPickerGroups(
        input({
          instances: [instance],
          observedByInstance,
          currentSelection: {
            providerInstanceId: instance.id,
            modelId: decodeProviderModelId("gone"),
          },
        }),
      );
      expect(groups[0]!.unavailableCurrent).toBeDefined();
      expect(groups[0]!.unavailableCurrent?.unavailableReason).toBeDefined();
    });

    it("retains the current selection when its provider is disabled", () => {
      const disabled = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "D",
        enabled: false,
      });
      const observedByInstance = new Map([
        [disabled.id, observed(disabled.id, [model({ id: "m", displayName: "M" })])],
      ]);
      const groups = buildModelPickerGroups(
        input({
          instances: [disabled],
          observedByInstance,
          currentSelection: {
            providerInstanceId: disabled.id,
            modelId: decodeProviderModelId("m"),
          },
        }),
      );
      const unavailable = groups.find((g) => g.instance.id === disabled.id);
      expect(unavailable?.unavailableCurrent).toBeDefined();
    });

    it("only includes enabled, ready or degraded providers as selectable groups", () => {
      const ready = openAiInstance({
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "Ready",
      });
      const unauth = openAiInstance({
        id: "00000000-0000-4000-8000-000000000102",
        displayName: "Unauth",
      });
      const observedByInstance = new Map([
        [ready.id, observed(ready.id, [model({ id: "m", displayName: "M" })])],
        [
          unauth.id,
          observed(unauth.id, [model({ id: "m2", displayName: "M2" })], {
            readiness: "unauthenticated",
          }),
        ],
      ]);
      const groups = buildModelPickerGroups(
        input({ instances: [ready, unauth], observedByInstance }),
      );
      expect(groups.map((g) => g.instance.displayName)).toEqual(["Ready"]);
    });
  });

  describe("filterModelPickerGroups", () => {
    const a = openAiInstance({
      id: "00000000-0000-4000-8000-000000000101",
      displayName: "DeepSeek Production",
    });
    const b = codexInstance("00000000-0000-4000-8000-000000000102", "Local Codex");
    const observedByInstance = new Map([
      [a.id, observed(a.id, [model({ id: "deepseek-chat", displayName: "DeepSeek Chat" })])],
      [b.id, observed(b.id, [model({ id: "gpt-5", displayName: "GPT-5" })])],
    ]);
    const groups = buildModelPickerGroups(input({ instances: [a, b], observedByInstance }));

    it("matches provider display name", () => {
      expect(
        filterModelPickerGroups(groups, "deepseek").map((g) => g.instance.displayName),
      ).toEqual(["DeepSeek Production"]);
    });
    it("matches driver/protocol label", () => {
      expect(
        filterModelPickerGroups(groups, "codex cli").map((g) => g.instance.displayName),
      ).toEqual(["Local Codex"]);
    });
    it("matches endpoint host", () => {
      expect(
        filterModelPickerGroups(groups, "gateway.example").map((g) => g.instance.displayName),
      ).toEqual(["DeepSeek Production"]);
    });
    it("matches model display name", () => {
      expect(filterModelPickerGroups(groups, "gpt-5").map((g) => g.instance.displayName)).toEqual([
        "Local Codex",
      ]);
    });
    it("matches model ID", () => {
      expect(
        filterModelPickerGroups(groups, "deepseek-chat").map((g) => g.instance.displayName),
      ).toEqual(["DeepSeek Production"]);
    });
    it("is case-insensitive and trims whitespace", () => {
      expect(filterModelPickerGroups(groups, "  GPT  ").map((g) => g.instance.displayName)).toEqual(
        ["Local Codex"],
      );
    });
    it("returns all groups for an empty query", () => {
      expect(filterModelPickerGroups(groups, "  ").map((g) => g.instance.displayName)).toHaveLength(
        2,
      );
    });
    it("drops groups whose models all fall outside the query", () => {
      expect(filterModelPickerGroups(groups, "nonexistent")).toEqual([]);
    });
  });
});

describe("draft selection selectability", () => {
  it("accepts a selectable draft pair and rejects stale or unavailable ones", () => {
    const gateway = openAiInstance({
      id: "00000000-0000-4000-8000-000000000201",
      displayName: "Gateway",
    });
    const toolModel = model({
      id: "tool-model",
      displayName: "Tool model",
      capabilityEvidence: toolEvidence("supported"),
    });
    const chatOnly = model({ id: "chat-only", displayName: "Chat only" });
    const codeGroups = buildModelPickerGroups(
      input({
        mode: "code",
        instances: [gateway],
        observedByInstance: new Map([[gateway.id, observed(gateway.id, [toolModel, chatOnly])]]),
      }),
    );
    const chatGroups = buildModelPickerGroups(
      input({
        mode: "chat",
        instances: [gateway],
        observedByInstance: new Map([[gateway.id, observed(gateway.id, [toolModel, chatOnly])]]),
      }),
    );
    const selection = (modelId: string) => ({
      providerInstanceId: gateway.id,
      modelId: decodeProviderModelId(modelId),
    });
    expect(isDraftSelectionSelectable(chatGroups, selection("chat-only"))).toBe(true);
    expect(isDraftSelectionSelectable(codeGroups, selection("chat-only"))).toBe(false);
    expect(isDraftSelectionSelectable(codeGroups, selection("gone"))).toBe(false);
    expect(isDraftSelectionSelectable(codeGroups, undefined)).toBe(true);
    expect(resolveDraftProviderSelection(codeGroups, selection("gone"))).toBeUndefined();
    expect(resolveDraftProviderSelection(codeGroups, selection("tool-model"))).toEqual(
      selection("tool-model"),
    );
  });
});

describe("upstream catalogs behind one provider", () => {
  it("names the catalog a namespaced model came from and leaves plain ids uncategorized", () => {
    expect(modelCatalog(decodeProviderModelId("anthropic/claude-sonnet-4"))).toBe("Anthropic");
    expect(modelCatalog(decodeProviderModelId("openai/gpt-5"))).toBe("OpenAI");
    expect(modelCatalog(decodeProviderModelId("github-copilot/gpt-5"))).toBe("GitHub Copilot");
    expect(modelCatalog(decodeProviderModelId("alibaba/qwen3-14b"))).toBe("Alibaba");
    expect(modelCatalog(decodeProviderModelId("claude-sonnet-4"))).toBeUndefined();
    expect(modelCatalog(decodeProviderModelId("/leading-slash"))).toBeUndefined();
  });

  it("lists a provider's catalogs in reading order so the picker can split its models", () => {
    const gateway = openAiInstance({
      id: "00000000-0000-4000-8000-000000000301",
      displayName: "Router",
    });
    const groups = buildModelPickerGroups(
      input({
        mode: "chat",
        instances: [gateway],
        observedByInstance: new Map([
          [
            gateway.id,
            observed(gateway.id, [
              model({ id: "openai/gpt-5", displayName: "GPT-5" }),
              model({ id: "alibaba/qwen3-14b", displayName: "Qwen3 14B" }),
              model({ id: "openai/gpt-5-mini", displayName: "GPT-5 mini" }),
              model({ id: "house-model", displayName: "House model" }),
            ]),
          ],
        ]),
      }),
    );
    const group = groups[0]!;
    expect(pickerCatalogs(group)).toEqual(["Alibaba", "OpenAI"]);
    expect(
      group.sections[0]!.models.map((picker) => [picker.model.displayName, picker.catalog]),
    ).toEqual([
      ["GPT-5", "OpenAI"],
      ["Qwen3 14B", "Alibaba"],
      ["GPT-5 mini", "OpenAI"],
      ["House model", undefined],
    ]);
  });

  it("reports no catalogs when a provider serves a single un-namespaced catalog", () => {
    const direct = openAiInstance({
      id: "00000000-0000-4000-8000-000000000302",
      displayName: "Direct",
    });
    const groups = buildModelPickerGroups(
      input({
        mode: "chat",
        instances: [direct],
        observedByInstance: new Map([
          [direct.id, observed(direct.id, [model({ id: "gpt-5", displayName: "GPT-5" })])],
        ]),
      }),
    );
    expect(pickerCatalogs(groups[0]!)).toEqual([]);
  });
});
