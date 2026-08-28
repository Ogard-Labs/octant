import { describe, expect, it } from "vitest";
import type { ProviderCapabilities, ProviderModelId } from "@octant/contracts/providers";
import {
  chatProviderServesTurn,
  selectChatProviderFallback,
  type ChatProviderTurnFacts,
} from "./chatProviderFallbackPolicy";

const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "supported",
  nativeAttachments: "supported",
  nativeWebResearch: "supported",
  appManagedTools: "supported",
  citations: "supported",
  ...overrides,
});

const active = "80000000-0000-4000-8000-000000000001" as never;
const spare = "80000000-0000-4000-8000-000000000002" as never;
const modelId = "model-a" as ProviderModelId;

const facts = (overrides: Partial<ChatProviderTurnFacts> = {}): ChatProviderTurnFacts => ({
  readiness: "ready",
  models: [modelId],
  capabilities: capabilities(),
  ...overrides,
});

describe("chatProviderServesTurn", () => {
  it("serves a turn on a degraded provider that still offers the model", () => {
    expect(
      chatProviderServesTurn(facts({ readiness: "degraded" }), {
        modelId,
        requiredCapabilities: ["streaming"],
      }),
    ).toEqual({ kind: "serves" });
  });

  it("refuses a turn whose provider is unauthenticated", () => {
    expect(
      chatProviderServesTurn(facts({ readiness: "unauthenticated" }), {
        modelId,
        requiredCapabilities: [],
      }),
    ).toEqual({ kind: "refuses", reason: "provider-unavailable" });
  });

  it("refuses a turn whose model the provider no longer offers", () => {
    expect(
      chatProviderServesTurn(facts({ models: [] }), { modelId, requiredCapabilities: [] }),
    ).toEqual({ kind: "refuses", reason: "model-unavailable" });
  });

  it("refuses a turn needing a capability the provider does not report as supported", () => {
    expect(
      chatProviderServesTurn(
        facts({ capabilities: capabilities({ appManagedTools: "unsupported" }) }),
        {
          modelId,
          requiredCapabilities: ["streaming", "appManagedTools"],
        },
      ),
    ).toEqual({ kind: "refuses", reason: "capability-unavailable" });
  });
});

describe("selectChatProviderFallback", () => {
  it("keeps the conversation on its own provider when no fallback was chosen", () => {
    expect(
      selectChatProviderFallback({
        preference: undefined,
        activeProviderInstanceId: active,
        requiredCapabilities: ["streaming"],
        candidate: facts(),
      }),
    ).toEqual({ kind: "refuses", reason: "no-preference" });
  });

  it("routes a turn to the chosen fallback that can serve it", () => {
    expect(
      selectChatProviderFallback({
        preference: { providerInstanceId: spare, modelId },
        activeProviderInstanceId: active,
        requiredCapabilities: ["streaming"],
        candidate: facts(),
      }),
    ).toEqual({ kind: "selected", providerInstanceId: spare, modelId });
  });

  it("refuses a fallback that names the provider which already refused", () => {
    expect(
      selectChatProviderFallback({
        preference: { providerInstanceId: active, modelId },
        activeProviderInstanceId: active,
        requiredCapabilities: [],
        candidate: facts(),
      }),
    ).toEqual({ kind: "refuses", reason: "same-provider" });
  });

  it("refuses a fallback that cannot be observed", () => {
    expect(
      selectChatProviderFallback({
        preference: { providerInstanceId: spare, modelId },
        activeProviderInstanceId: active,
        requiredCapabilities: [],
        candidate: undefined,
      }),
    ).toEqual({ kind: "refuses", reason: "provider-unavailable" });
  });

  it("refuses a fallback that does not report a capability the turn needs", () => {
    expect(
      selectChatProviderFallback({
        preference: { providerInstanceId: spare, modelId },
        activeProviderInstanceId: active,
        requiredCapabilities: ["nativeWebResearch"],
        candidate: facts({ capabilities: capabilities({ nativeWebResearch: "unavailable" }) }),
      }),
    ).toEqual({ kind: "refuses", reason: "capability-unavailable" });
  });
});
