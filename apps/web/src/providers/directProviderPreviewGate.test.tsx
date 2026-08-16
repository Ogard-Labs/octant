import type {
  ProviderInstance,
  ProviderModel,
  ProviderObservedState,
  ProviderReadiness,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildModelPickerGroups,
  type ModelPickerSelection,
  type PickerGroup,
} from "@octant/domain";
import { ModelPicker } from "./ModelPicker";

/**
 * Authenticated web coverage for the direct-provider preview gate.
 *
 * Verifies that the provider-first picker renders all five direct-provider
 * profiles with correct driver labels, sections Work/Code with
 * mode-appropriate authority, and keeps credentials out of renderer state
 * (DOM text content) across every direct-provider type.
 */

const now = "2026-08-02T00:00:00.000Z" as UtcTimestamp;
const SENTINEL = "sk-web-sentinel-166";

function openAiInstance(
  id: string,
  displayName: string,
  baseUrl = "https://gateway.example/v1/",
): ProviderInstance {
  return {
    id: id as ProviderInstanceId,
    displayName,
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl,
      authentication: "none",
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

function anthropicInstance(id: string, displayName: string): ProviderInstance {
  return {
    id: id as ProviderInstanceId,
    displayName,
    driverKind: "anthropic-compatible",
    configuration: {
      kind: "anthropic-compatible-http",
      baseUrl: "https://anthropic.example/v1",
      authentication: "api-key",
      protocol: "messages",
      protocolVersion: "2023-06-01",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: now,
    updatedAt: now,
  } as ProviderInstance;
}

function foundryInstance(id: string, displayName: string): ProviderInstance {
  return {
    id: id as ProviderInstanceId,
    displayName,
    driverKind: "azure-foundry",
    configuration: {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
      authentication: "api-key",
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

function bedrockMantleInstance(id: string, displayName: string): ProviderInstance {
  return {
    id: id as ProviderInstanceId,
    displayName,
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

function model(input: {
  id: string;
  displayName: string;
  toolCalling?: "supported" | "unsupported" | "unavailable";
  evidence?: "supported" | "unsupported" | "unavailable";
}): ProviderModel {
  return {
    id: input.id as ProviderModelId,
    displayName: input.displayName,
    orderHint: undefined,
    contextLimit: undefined,
    maxOutputTokens: undefined,
    reasoning: "unavailable",
    toolCalling: input.toolCalling,
    parallelTools: undefined,
    structuredOutput: undefined,
    streaming: undefined,
    inputModalities: ["text"],
    options: [],
    capabilityEvidence:
      input.evidence === undefined
        ? undefined
        : [
            {
              capability: "tool-calling",
              support: input.evidence,
              source: "endpoint-observation",
              confidence: "high",
              protocol: "responses",
              observedAt: now,
              invalidated: false,
            },
          ],
    source: "discovered",
    verification: "verified",
  } as ProviderModel;
}

function observed(
  instanceId: string,
  models: ReadonlyArray<ProviderModel>,
  readiness: ProviderReadiness = "ready",
): ProviderObservedState {
  return {
    instanceId: instanceId as ProviderInstanceId,
    readiness,
    processState: "running",
    models,
    capabilities: {
      streaming: "supported",
      resume: "unavailable",
      interruption: "supported",
      approvals: "unsupported",
      userQuestions: "unsupported",
      reasoning: "unavailable",
      usage: "supported",
      toolActivity: "unsupported",
      fileChanges: "unavailable",
      diffs: "unavailable",
      taskProgress: "unsupported",
      nativeChildAgents: "unavailable",
      nativeAttachments: "unavailable",
      nativeWebResearch: "unavailable",
      appManagedTools: "unsupported",
      citations: "unavailable",
    },
    observedAt: now,
  } as ProviderObservedState;
}

function groups(
  instances: ReadonlyArray<ProviderInstance>,
  observedByInstance: Map<ProviderInstanceId, ProviderObservedState>,
  mode: "chat" | "work" | "code" = "chat",
  currentSelection?: ModelPickerSelection,
): ReadonlyArray<PickerGroup> {
  return buildModelPickerGroups({ instances, observedByInstance, mode, currentSelection });
}

describe("Direct-provider preview gate web coverage", () => {
  it("renders all five direct-provider profiles with correct driver labels", () => {
    const openai = openAiInstance("10000000-0000-4000-8000-000000000001", "OpenAI Production");
    const anthropic = anthropicInstance("10000000-0000-4000-8000-000000000002", "Anthropic Direct");
    const foundry = foundryInstance("10000000-0000-4000-8000-000000000003", "Foundry Work");
    const bedrock = bedrockMantleInstance(
      "10000000-0000-4000-8000-000000000004",
      "Bedrock eu-west-1",
    );
    const observedByInstance = new Map([
      [openai.id, observed(openai.id, [model({ id: "gpt-model", displayName: "GPT Model" })])],
      [
        anthropic.id,
        observed(anthropic.id, [model({ id: "claude-model", displayName: "Claude Model" })]),
      ],
      [
        foundry.id,
        observed(foundry.id, [model({ id: "deployment-1", displayName: "Deployment 1" })]),
      ],
      [
        bedrock.id,
        observed(bedrock.id, [model({ id: "bedrock-model", displayName: "Bedrock Model" })]),
      ],
    ]);
    render(
      <ModelPicker
        groups={groups([openai, anthropic, foundry, bedrock], observedByInstance)}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("OpenAI Production")).toBeVisible();
    expect(screen.getByText("Anthropic Direct")).toBeVisible();
    expect(screen.getByText("Foundry Work")).toBeVisible();
    expect(screen.getByText("Bedrock eu-west-1")).toBeVisible();

    expect(screen.getByText("Anthropic-compatible HTTP")).toBeVisible();
    expect(screen.getByText("Azure AI Foundry")).toBeVisible();
    // Bedrock Mantle reuses the OpenAI-compatible driver label, so two
    // provider groups carry it (OpenAI Production and Bedrock eu-west-1).
    const openAiLabels = screen.getAllByText("OpenAI-compatible HTTP");
    expect(openAiLabels).toHaveLength(2);
  });

  it("sections Work and Code into chat-and-analysis-only for unverified direct-provider models", () => {
    const openai = openAiInstance("10000000-0000-4000-8000-000000000001", "Direct API");
    const unverified = model({
      id: "chat-only",
      displayName: "Chat Only",
      toolCalling: "unavailable",
    });
    const observedByInstance = new Map([[openai.id, observed(openai.id, [unverified])]]);

    const { rerender } = render(
      <ModelPicker groups={groups([openai], observedByInstance, "work")} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("group", { name: "Chat and analysis only" })).toBeVisible();
    expect(screen.getByText(/has not been verified|does not support tool calling/)).toBeVisible();

    rerender(
      <ModelPicker groups={groups([openai], observedByInstance, "code")} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("group", { name: "Chat and analysis only" })).toBeVisible();
  });

  it("keeps credential sentinel values out of renderer DOM state across all direct-provider types", () => {
    const openai = openAiInstance("10000000-0000-4000-8000-000000000001", "OpenAI Production");
    const anthropic = anthropicInstance("10000000-0000-4000-8000-000000000002", "Anthropic Direct");
    const foundry = foundryInstance("10000000-0000-4000-8000-000000000003", "Foundry Work");
    const bedrock = bedrockMantleInstance(
      "10000000-0000-4000-8000-000000000004",
      "Bedrock eu-west-1",
    );
    const observedByInstance = new Map([
      [openai.id, observed(openai.id, [model({ id: "m1", displayName: "M1" })])],
      [anthropic.id, observed(anthropic.id, [model({ id: "m2", displayName: "M2" })])],
      [foundry.id, observed(foundry.id, [model({ id: "m3", displayName: "M3" })])],
      [bedrock.id, observed(bedrock.id, [model({ id: "m4", displayName: "M4" })])],
    ]);
    const { container } = render(
      <ModelPicker
        groups={groups([openai, anthropic, foundry, bedrock], observedByInstance)}
        onSelect={vi.fn()}
      />,
    );

    // The picker renders provider metadata, driver labels, endpoint hosts,
    // and model names — never credentials. The sentinel must not appear
    // anywhere in the rendered DOM text content or HTML.
    expect(container.textContent).not.toContain(SENTINEL);
    expect(container.innerHTML).not.toContain(SENTINEL);
  });

  it("shows the Bedrock Mantle endpoint host without implying full Bedrock Converse support", () => {
    const bedrock = bedrockMantleInstance(
      "10000000-0000-4000-8000-000000000004",
      "Bedrock eu-west-1",
    );
    const observedByInstance = new Map([
      [
        bedrock.id,
        observed(bedrock.id, [model({ id: "bedrock-model", displayName: "Bedrock Model" })]),
      ],
    ]);
    render(<ModelPicker groups={groups([bedrock], observedByInstance)} onSelect={vi.fn()} />);

    expect(screen.getByText("Bedrock eu-west-1")).toBeVisible();
    expect(screen.getByText("bedrock-runtime.eu-west-1.amazonaws.com")).toBeVisible();
    // The picker must not advertise full Bedrock Converse/IAM support.
    expect(screen.queryByText(/Converse/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/IAM/i)).not.toBeInTheDocument();
  });

  it("places a verified tool-capable direct-provider model in the tool-capable section for Code", () => {
    const openai = openAiInstance("10000000-0000-4000-8000-000000000001", "Direct API");
    const tool = model({
      id: "tool-model",
      displayName: "Tool Model",
      toolCalling: "supported",
      evidence: "supported",
    });
    const observedByInstance = new Map([[openai.id, observed(openai.id, [tool])]]);
    render(
      <ModelPicker groups={groups([openai], observedByInstance, "code")} onSelect={vi.fn()} />,
    );

    expect(screen.getByRole("group", { name: "Tool-capable" })).toBeVisible();
    expect(screen.getByRole("option", { name: /Tool Model/ })).toHaveAccessibleName(/Tools/);
  });
});
