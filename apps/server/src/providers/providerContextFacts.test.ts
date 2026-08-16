import {
  decodeProviderFailure,
  decodeProviderInstanceId,
  decodeProviderObservedState,
  decodeProviderRuntimeEvent,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  modelEvidenceFromObservedState,
  serviceLimitsFromFailure,
  usageFromRuntimeEvent,
} from "./providerContextFacts";

const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000001");
const sessionId = "00000000-0000-4000-8000-000000000003";
const observedAt = "2026-07-18T18:30:00.000Z";
const capabilities = {
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
} as const;

describe("provider context fact adapter", () => {
  it("extracts partial model evidence without fabricating output or tokenizer facts", () => {
    const state = decodeProviderObservedState({
      instanceId,
      readiness: "ready",
      processState: "running",
      models: [
        {
          id: "model-a",
          displayName: "Model A",
          contextLimit: 200_000,
          reasoning: "supported",
          inputModalities: ["text"],
          options: [],
          source: "discovered",
          verification: "verified",
        },
      ],
      capabilities,
      observedAt,
    });

    expect(modelEvidenceFromObservedState(state)).toEqual([
      {
        providerInstanceId: instanceId,
        modelId: "model-a",
        contextWindow: 200_000,
        reasoning: "included",
        source: "provider-discovery",
        confidence: "high",
        observedAt,
      },
    ]);

    expect(modelEvidenceFromObservedState({ ...state, models: [] })).toEqual([]);
  });

  it("extracts provider-reported usage only from strict usage events", () => {
    const usage = decodeProviderRuntimeEvent({
      instanceId,
      sessionId,
      sequence: 1,
      correlationId: "00000000-0000-4000-8000-000000000002",
      occurredAt: observedAt,
      kind: "usage",
      inputTokens: 120,
      outputTokens: 20,
    });
    expect(usageFromRuntimeEvent(usage)).toEqual({
      providerInstanceId: instanceId,
      sessionId,
      inputTokens: 120,
      outputTokens: 20,
      accuracy: "provider-reported",
      observedAt,
    });

    const text = decodeProviderRuntimeEvent({
      instanceId,
      sessionId,
      sequence: 2,
      correlationId: "00000000-0000-4000-8000-000000000002",
      occurredAt: observedAt,
      kind: "text-delta",
      text: "hello",
    });
    expect(usageFromRuntimeEvent(text)).toBeUndefined();
    expect(
      usageFromRuntimeEvent({ ...usage, inputTokens: 0, outputTokens: 0 } as ProviderRuntimeEvent),
    ).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(() =>
      usageFromRuntimeEvent({
        ...usage,
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
      } as ProviderRuntimeEvent),
    ).toThrow(/safe integer/i);
  });

  it("maps bounded retry timing while keeping unknown buckets unavailable", () => {
    const failure = decodeProviderFailure({
      category: "rate-limited",
      message: "Provider is rate limited.",
      retryAfterMs: 30_000,
    });
    expect(serviceLimitsFromFailure(instanceId, failure, () => Date.parse(observedAt))).toEqual({
      providerInstanceId: instanceId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "active", until: "2026-07-18T18:30:30.000Z" },
      quota: "unknown",
      source: "observed-evidence",
      confidence: "high",
      updatedAt: observedAt,
    });
    expect(() => serviceLimitsFromFailure(instanceId, failure, () => -1)).toThrow(/timestamp/i);

    expect(
      serviceLimitsFromFailure(
        instanceId,
        decodeProviderFailure({ category: "unavailable", message: "Unavailable." }),
        () => Date.parse(observedAt),
      ),
    ).toMatchObject({
      retry: { status: "inactive" },
      quota: "unavailable",
      confidence: "unknown",
    });
  });
});
