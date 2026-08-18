import {
  decodeProviderInstance,
  decodeProviderModelId,
  decodeProviderModel,
  type CapabilityEvidence,
  type UtcTimestamp,
  type ProviderInstance,
  type ProviderModel,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  describeProviderConfigurationChange,
  invalidateModelCapabilityEvidence,
  orderProviderInstances,
  orderProviderModels,
  hasVerifiedToolAuthority,
  hasWorkToolAuthority,
  resolveCapabilitySupport,
} from "./modelCatalogPolicy";

const now = "2026-07-21T10:00:00.000Z" as UtcTimestamp;
const instances = [
  decodeProviderInstance({
    id: "00000000-0000-4000-8000-000000000101",
    displayName: "Zulu gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://zulu.example/v1/",
      authentication: "none",
      protocol: "responses",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  }),
  decodeProviderInstance({
    id: "00000000-0000-4000-8000-000000000102",
    displayName: "Alpha gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://alpha.example/v1/",
      authentication: "none",
      protocol: "responses",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  }),
] as const satisfies readonly ProviderInstance[];

function model(
  input: Omit<Partial<ProviderModel>, "id"> & { id: string; displayName: string },
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

describe("model catalog policy", () => {
  it("orders manual IDs first, then provider hints, then preserves provider order", () => {
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
      model({
        id: "manual-c",
        displayName: "Manual C",
        source: "manual",
        verification: "unverified",
      }),
    ];

    expect(
      orderProviderModels(models, [
        decodeProviderModelId("manual-c"),
        decodeProviderModelId("manual-a"),
      ]),
    ).toEqual([models[4], models[3], models[1], models[0], models[2]]);
  });

  it("orders providers by explicit preference and uses display name as deterministic fallback", () => {
    expect(
      orderProviderInstances(instances, [instances[0].id]).map(({ displayName }) => displayName),
    ).toEqual(["Zulu gateway", "Alpha gateway"]);
    expect(orderProviderInstances(instances, []).map(({ displayName }) => displayName)).toEqual([
      "Alpha gateway",
      "Zulu gateway",
    ]);
  });

  it("uses evidence precedence and ignores invalidated evidence", () => {
    const evidence = [
      {
        capability: "tool-calling",
        support: "unsupported",
        source: "endpoint-observation",
        confidence: "high",
        protocol: "responses",
        observedAt: now,
        invalidated: true,
      },
      {
        capability: "tool-calling",
        support: "supported",
        source: "user-metadata",
        confidence: "low",
        protocol: "responses",
        observedAt: now,
        invalidated: false,
      },
      {
        capability: "tool-calling",
        support: "unavailable",
        source: "unknown",
        confidence: "unknown",
        protocol: "responses",
        observedAt: now,
        invalidated: false,
      },
    ] as const;
    expect(resolveCapabilitySupport(evidence)).toBe("supported");
    expect(
      hasVerifiedToolAuthority(
        model({
          id: "user-asserted-tools",
          displayName: "User asserted tools",
          capabilityEvidence: evidence,
          toolCalling: "supported",
        }),
      ),
    ).toBe(false);
  });
});

const invalidatedAt = "2026-07-21T11:00:00.000Z" as UtcTimestamp;
const reason = "provider configuration changed";

function evidence(
  overrides: Partial<CapabilityEvidence> & {
    capability: CapabilityEvidence["capability"];
    support: CapabilityEvidence["support"];
    source: CapabilityEvidence["source"];
  },
): CapabilityEvidence {
  return {
    confidence: "high",
    protocol: "responses",
    observedAt: now,
    invalidated: false,
    ...overrides,
  } as CapabilityEvidence;
}

describe("invalidateModelCapabilityEvidence", () => {
  it("invalidates endpoint-derived evidence when the endpoint changes but preserves curated and user metadata", () => {
    const records = [
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
      }),
      evidence({ capability: "tool-calling", support: "supported", source: "provider-metadata" }),
      evidence({ capability: "tool-calling", support: "supported", source: "catalog-metadata" }),
      evidence({ capability: "tool-calling", support: "supported", source: "user-metadata" }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "endpoint" },
      invalidatedAt,
      reason,
    );
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({
      source: "endpoint-observation",
      invalidated: true,
      invalidationReason: reason,
    });
    expect(result[1]).toMatchObject({
      source: "provider-metadata",
      invalidated: true,
      invalidationReason: reason,
    });
    expect(result[2]).toMatchObject({ source: "catalog-metadata", invalidated: false });
    expect(result[2]?.invalidatedAt).toBeUndefined();
    expect(result[3]).toMatchObject({ source: "user-metadata", invalidated: false });
  });

  it("invalidates endpoint-derived evidence on authentication changes", () => {
    const records = [
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
      }),
      evidence({ capability: "streaming", support: "supported", source: "provider-metadata" }),
      evidence({ capability: "reasoning", support: "supported", source: "catalog-metadata" }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "authentication" },
      invalidatedAt,
      reason,
    );
    expect(result[0]).toMatchObject({ invalidated: true });
    expect(result[1]).toMatchObject({ invalidated: true });
    expect(result[2]).toMatchObject({ invalidated: false });
  });

  it("invalidates only evidence bound to the previous protocol on a protocol change", () => {
    const records = [
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
        protocol: "responses",
      }),
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
        protocol: "chat-completions",
      }),
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "provider-metadata",
        protocol: "responses",
      }),
      evidence({
        capability: "streaming",
        support: "supported",
        source: "catalog-metadata",
        protocol: "responses",
      }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "protocol", previousProtocol: "responses" },
      invalidatedAt,
      reason,
    );
    expect(result[0]).toMatchObject({ protocol: "responses", invalidated: true });
    expect(result[1]).toMatchObject({ protocol: "chat-completions", invalidated: false });
    expect(result[2]).toMatchObject({ protocol: "responses", invalidated: true });
    expect(result[3]).toMatchObject({ protocol: "responses", invalidated: false });
  });

  it("invalidates unknown-protocol endpoint-derived evidence on a protocol change", () => {
    const records = [
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
        protocol: "unknown",
      }),
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "provider-metadata",
        protocol: "unknown",
      }),
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "catalog-metadata",
        protocol: "unknown",
      }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "protocol", previousProtocol: "responses" },
      invalidatedAt,
      reason,
    );
    expect(result[0]).toMatchObject({
      protocol: "unknown",
      source: "endpoint-observation",
      invalidated: true,
    });
    expect(result[1]).toMatchObject({
      protocol: "unknown",
      source: "provider-metadata",
      invalidated: true,
    });
    expect(result[2]).toMatchObject({
      protocol: "unknown",
      source: "catalog-metadata",
      invalidated: false,
    });
  });

  it("invalidates all evidence on a driver/runtime change", () => {
    const records = [
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
      }),
      evidence({ capability: "tool-calling", support: "supported", source: "catalog-metadata" }),
      evidence({ capability: "tool-calling", support: "supported", source: "user-metadata" }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "driver" },
      invalidatedAt,
      reason,
    );
    expect(result.every((record) => record.invalidated)).toBe(true);
  });

  it("invalidates all evidence for an explicit full invalidation", () => {
    const records = [
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
      }),
      evidence({ capability: "tool-calling", support: "supported", source: "user-metadata" }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "all" },
      invalidatedAt,
      reason,
    );
    expect(result.every((record) => record.invalidated)).toBe(true);
  });

  it("preserves existing invalidation state and reason without overwriting", () => {
    const records = [
      evidence({
        capability: "tool-calling",
        support: "supported",
        source: "endpoint-observation",
        invalidated: true,
        invalidatedAt: "2026-07-21T09:00:00.000Z" as UtcTimestamp,
        invalidationReason: "earlier probe failure",
      }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "endpoint" },
      invalidatedAt,
      reason,
    );
    expect(result[0]).toMatchObject({
      invalidated: true,
      invalidatedAt: "2026-07-21T09:00:00.000Z",
      invalidationReason: "earlier probe failure",
    });
  });

  it("returns evidence unchanged when no records match the change", () => {
    const records = [
      evidence({ capability: "tool-calling", support: "supported", source: "catalog-metadata" }),
    ];

    const result = invalidateModelCapabilityEvidence(
      records,
      { kind: "endpoint" },
      invalidatedAt,
      reason,
    );
    expect(result).toEqual(records);
  });
});

describe("describeProviderConfigurationChange", () => {
  function openAi(config: {
    baseUrl: string;
    authentication: "bearer" | "none";
    protocol: "auto" | "responses" | "chat-completions";
    manualModelIds?: string[];
  }): ProviderInstance {
    return decodeProviderInstance({
      id: "00000000-0000-4000-8000-000000000401",
      displayName: "OpenAI gateway",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: config.baseUrl,
        authentication: config.authentication,
        protocol: config.protocol,
        manualModelIds: config.manualModelIds ?? ["model-a"],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  function claude(authentication: "subscription" | "api-key" = "subscription"): ProviderInstance {
    return decodeProviderInstance({
      id: "00000000-0000-4000-8000-000000000402",
      displayName: "Claude local",
      driverKind: "claude",
      configuration: { kind: "claude-agent-sdk", binaryPath: "/opt/claude", authentication },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  function foundry(config: {
    baseUrl: string;
    protocol: "auto" | "responses" | "chat-completions";
    manualModelIds?: string[];
  }): ProviderInstance {
    return decodeProviderInstance({
      id: "00000000-0000-4000-8000-000000000421",
      displayName: "Azure Foundry Work",
      driverKind: "azure-foundry",
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: config.baseUrl,
        authentication: "api-key",
        protocol: config.protocol,
        manualModelIds: config.manualModelIds ?? ["deployment-a"],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("reports an endpoint change when the base URL differs", () => {
    expect(
      describeProviderConfigurationChange(
        openAi({
          baseUrl: "https://gateway.example/v1/",
          authentication: "bearer",
          protocol: "responses",
        }),
        openAi({
          baseUrl: "https://other.example/v1/",
          authentication: "bearer",
          protocol: "responses",
        }),
      ),
    ).toEqual({ kind: "endpoint" });
  });

  it("reports an authentication change when auth differs with the same endpoint", () => {
    expect(
      describeProviderConfigurationChange(
        openAi({
          baseUrl: "http://127.0.0.1:11434/v1/",
          authentication: "bearer",
          protocol: "responses",
        }),
        openAi({
          baseUrl: "http://127.0.0.1:11434/v1/",
          authentication: "none",
          protocol: "responses",
        }),
      ),
    ).toEqual({ kind: "authentication" });
  });

  it("reports a driver change when the binary path differs for a CLI provider", () => {
    const left = claude("subscription");
    const right = decodeProviderInstance({
      ...left,
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/usr/local/bin/claude",
        authentication: "subscription",
      },
      version: 2,
      updatedAt: now,
    });
    expect(describeProviderConfigurationChange(left, right)).toEqual({ kind: "driver" });
  });

  it("falls back to a full invalidation when only non-authority fields differ", () => {
    expect(
      describeProviderConfigurationChange(
        openAi({
          baseUrl: "https://gateway.example/v1/",
          authentication: "bearer",
          protocol: "responses",
          manualModelIds: ["model-a"],
        }),
        openAi({
          baseUrl: "https://gateway.example/v1/",
          authentication: "bearer",
          protocol: "responses",
          manualModelIds: ["model-a", "model-b"],
        }),
      ),
    ).toEqual({ kind: "all" });
  });

  it("reports a protocol change when only the protocol differs for an HTTP provider", () => {
    expect(
      describeProviderConfigurationChange(
        openAi({
          baseUrl: "https://gateway.example/v1/",
          authentication: "bearer",
          protocol: "responses",
        }),
        openAi({
          baseUrl: "https://gateway.example/v1/",
          authentication: "bearer",
          protocol: "chat-completions",
        }),
      ),
    ).toEqual({ kind: "protocol", previousProtocol: "responses" });
  });

  it("falls back to an endpoint-level change when the previous protocol was auto", () => {
    expect(
      describeProviderConfigurationChange(
        openAi({
          baseUrl: "https://gateway.example/v1/",
          authentication: "bearer",
          protocol: "auto",
        }),
        openAi({
          baseUrl: "https://gateway.example/v1/",
          authentication: "bearer",
          protocol: "responses",
        }),
      ),
    ).toEqual({ kind: "endpoint" });
  });

  it("prioritizes a driver change over an authentication change for a CLI provider", () => {
    const left = claude("subscription");
    const right = decodeProviderInstance({
      ...left,
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/usr/local/bin/claude",
        authentication: "api-key",
      },
      version: 2,
      updatedAt: now,
    });
    expect(describeProviderConfigurationChange(left, right)).toEqual({ kind: "driver" });
  });

  it("reports an endpoint change for Azure AI Foundry when the base URL differs", () => {
    expect(
      describeProviderConfigurationChange(
        foundry({
          baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
          protocol: "responses",
        }),
        foundry({
          baseUrl: "https://other.foundry.openai.azure.com/openai/v1/",
          protocol: "responses",
        }),
      ),
    ).toEqual({ kind: "endpoint" });
  });

  it("reports a protocol change for Azure AI Foundry when only the protocol differs", () => {
    expect(
      describeProviderConfigurationChange(
        foundry({
          baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
          protocol: "responses",
        }),
        foundry({
          baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
          protocol: "chat-completions",
        }),
      ),
    ).toEqual({ kind: "protocol", previousProtocol: "responses" });
  });
});

describe("hasWorkToolAuthority", () => {
  it("admits verified native-agent models without model-level evidence", () => {
    const runtimeModel = model({ id: "runtime", displayName: "Runtime model" });
    expect(hasWorkToolAuthority("codex", runtimeModel)).toBe(true);
    expect(hasWorkToolAuthority("claude", runtimeModel)).toBe(true);
    expect(hasWorkToolAuthority("opencode", runtimeModel)).toBe(true);
    expect(hasWorkToolAuthority("kimi-code", runtimeModel)).toBe(true);
    expect(hasWorkToolAuthority("grok", runtimeModel)).toBe(true);
  });

  it("rejects probe-only Oh My Pi models without an executable turn runtime", () => {
    const runtimeModel = model({ id: "runtime", displayName: "Runtime model" });
    expect(hasWorkToolAuthority("oh-my-pi", runtimeModel)).toBe(false);
  });

  it("admits only explicitly verified Azure Foundry deployments", () => {
    const deployment = model({ id: "deployment-a", displayName: "Deployment A" });
    expect(hasWorkToolAuthority("azure-foundry", deployment)).toBe(false);
    expect(hasWorkToolAuthority("azure-foundry", deployment, [deployment.id])).toBe(true);
  });

  it("keeps the model-level evidence requirement for HTTP drivers", () => {
    const runtimeModel = model({ id: "runtime", displayName: "Runtime model" });
    expect(hasWorkToolAuthority("openai-compatible", runtimeModel)).toBe(false);
    expect(hasWorkToolAuthority("anthropic-compatible", runtimeModel)).toBe(false);
  });

  it("still rejects unverified models from native drivers", () => {
    const unverified = model({
      id: "unverified",
      displayName: "Unverified",
      source: "manual",
      verification: "unverified",
    });
    expect(hasWorkToolAuthority("codex", unverified)).toBe(false);
  });
});
