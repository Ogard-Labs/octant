import type {
  ProviderInstance,
  ProviderModel,
  ProviderObservedState,
  ProviderReadiness,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  buildModelPickerGroups,
  type ModelPickerSelection,
  type PickerGroup,
} from "@octant/domain";
import { ModelPicker } from "./ModelPicker";

const now = "2026-07-21T10:00:00.000Z" as UtcTimestamp;

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

function model(input: {
  id: string;
  displayName: string;
  toolCalling?: "supported" | "unsupported" | "unavailable";
  evidence?: "supported" | "unsupported" | "unavailable";
  inputModalities?: ReadonlyArray<"text" | "image" | "audio" | "document">;
  reasoning?: "supported" | "unsupported" | "unavailable";
  contextLimit?: number;
}): ProviderModel {
  return {
    id: input.id as ProviderModelId,
    displayName: input.displayName,
    orderHint: undefined,
    contextLimit: input.contextLimit,
    maxOutputTokens: undefined,
    reasoning: input.reasoning ?? "unavailable",
    toolCalling: input.toolCalling,
    parallelTools: undefined,
    structuredOutput: undefined,
    streaming: undefined,
    inputModalities: input.inputModalities ?? ["text"],
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

describe("ModelPicker", () => {
  it("renders provider groups with display name, driver label, and endpoint host", () => {
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "DeepSeek Production");
    const observedByInstance = new Map([
      [a.id, observed(a.id, [model({ id: "deepseek-chat", displayName: "DeepSeek Chat" })])],
    ]);
    render(<ModelPicker groups={groups([a], observedByInstance)} onSelect={vi.fn()} />);
    expect(screen.getByText("DeepSeek Production")).toBeVisible();
    expect(screen.getByText("OpenAI-compatible HTTP")).toBeVisible();
    expect(screen.getByText("gateway.example")).toBeVisible();
  });

  it("shows evidence-backed badges for a tool-capable, vision, reasoning model", () => {
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const m = model({
      id: "m",
      displayName: "M",
      toolCalling: "supported",
      evidence: "supported",
      inputModalities: ["text", "image"],
      reasoning: "supported",
      contextLimit: 128_000,
    });
    const observedByInstance = new Map([[a.id, observed(a.id, [m])]]);
    render(<ModelPicker groups={groups([a], observedByInstance)} onSelect={vi.fn()} />);
    const option = screen.getByRole("option", { name: /M/ });
    expect(option).toHaveAccessibleName(/Tools/);
    expect(option).toHaveAccessibleName(/Vision/);
    expect(option).toHaveAccessibleName(/Reasoning/);
    expect(option).toHaveAccessibleName(/128K context/);
  });

  it("sections Work/Code into tool-capable and chat-and-analysis-only with a reason", () => {
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const tool = model({
      id: "tool",
      displayName: "Tool",
      toolCalling: "supported",
      evidence: "supported",
    });
    const chat = model({ id: "chat", displayName: "Chat", toolCalling: "unavailable" });
    const observedByInstance = new Map([[a.id, observed(a.id, [chat, tool])]]);
    render(<ModelPicker groups={groups([a], observedByInstance, "code")} onSelect={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Tool-capable" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Chat and analysis only" })).toBeVisible();
    expect(screen.getByText(/does not support tool calling|has not been verified/)).toBeVisible();
  });

  it("disables chat-only models in tool modes", async () => {
    const user = userEvent.setup();
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const chat = model({ id: "chat", displayName: "Chat", toolCalling: "unavailable" });
    const observedByInstance = new Map([[a.id, observed(a.id, [chat])]]);
    const onSelect = vi.fn<(selection: ModelPickerSelection) => void>();

    render(<ModelPicker groups={groups([a], observedByInstance, "code")} onSelect={onSelect} />);

    const option = screen.getByRole("option", { name: /Chat/ });
    expect(option).toBeDisabled();
    await user.click(option);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("skips chat-only models during keyboard navigation in tool modes", async () => {
    const user = userEvent.setup();
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const chat = model({ id: "chat", displayName: "Chat", toolCalling: "unavailable" });
    const tool = model({
      id: "tool",
      displayName: "Tool",
      toolCalling: "supported",
      evidence: "supported",
    });
    const observedByInstance = new Map([[a.id, observed(a.id, [chat, tool])]]);
    const onSelect = vi.fn<(selection: ModelPickerSelection) => void>();

    render(<ModelPicker groups={groups([a], observedByInstance, "code")} onSelect={onSelect} />);

    const listbox = screen.getByRole("listbox");
    listbox.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith({
      providerInstanceId: a.id,
      modelId: "tool" as ProviderModelId,
    });
  });

  it("filters groups by search query across provider, driver, host, and model", async () => {
    const user = userEvent.setup();
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "DeepSeek Production");
    const b = openAiInstance(
      "10000000-0000-4000-8000-000000000002",
      "Other Gateway",
      "https://other.example/v1/",
    );
    const observedByInstance = new Map([
      [a.id, observed(a.id, [model({ id: "deepseek-chat", displayName: "DeepSeek Chat" })])],
      [b.id, observed(b.id, [model({ id: "other-model", displayName: "Other Model" })])],
    ]);
    render(<ModelPicker groups={groups([a, b], observedByInstance)} onSelect={vi.fn()} />);
    await user.type(screen.getByRole("searchbox"), "deepseek");
    expect(screen.getByText("DeepSeek Production")).toBeVisible();
    expect(screen.queryByText("Other Gateway")).not.toBeInTheDocument();
  });

  it("calls onSelect with provider instance and model when an option is chosen", async () => {
    const user = userEvent.setup();
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const observedByInstance = new Map([
      [a.id, observed(a.id, [model({ id: "m", displayName: "M" })])],
    ]);
    const onSelect = vi.fn<(selection: ModelPickerSelection) => void>();
    render(<ModelPicker groups={groups([a], observedByInstance)} onSelect={onSelect} />);
    await user.click(screen.getByRole("option", { name: /M/ }));
    expect(onSelect).toHaveBeenCalledWith({
      providerInstanceId: a.id,
      modelId: "m" as ProviderModelId,
    });
  });

  it("supports keyboard arrow navigation and Enter selection", async () => {
    const user = userEvent.setup();
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const observedByInstance = new Map([
      [
        a.id,
        observed(a.id, [
          model({ id: "m1", displayName: "M1" }),
          model({ id: "m2", displayName: "M2" }),
        ]),
      ],
    ]);
    const onSelect = vi.fn<(selection: ModelPickerSelection) => void>();
    render(<ModelPicker groups={groups([a], observedByInstance)} onSelect={onSelect} />);
    const listbox = screen.getByRole("listbox");
    listbox.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith({
      providerInstanceId: a.id,
      modelId: "m2" as ProviderModelId,
    });
  });

  it("retains an unavailable current selection with an actionable status", () => {
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const observedByInstance = new Map([
      [a.id, observed(a.id, [model({ id: "m", displayName: "M" })])],
    ]);
    render(
      <ModelPicker
        groups={groups([a], observedByInstance, "chat", {
          providerInstanceId: a.id,
          modelId: "gone" as ProviderModelId,
        })}
        selectedProviderInstanceId={a.id}
        selectedModelId={"gone" as ProviderModelId}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/no longer listed|not available/)).toBeVisible();
  });

  it("marks the selected option with aria-selected", () => {
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const observedByInstance = new Map([
      [a.id, observed(a.id, [model({ id: "m", displayName: "M" })])],
    ]);
    render(
      <ModelPicker
        groups={groups([a], observedByInstance)}
        selectedProviderInstanceId={a.id}
        selectedModelId={"m" as ProviderModelId}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: /M/ })).toHaveAttribute("aria-selected", "true");
  });

  it("renders a narrow density variant when narrow is set", () => {
    const a = openAiInstance("10000000-0000-4000-8000-000000000001", "G");
    const observedByInstance = new Map([
      [a.id, observed(a.id, [model({ id: "m", displayName: "M" })])],
    ]);
    render(<ModelPicker groups={groups([a], observedByInstance)} onSelect={vi.fn()} narrow />);
    expect(screen.getByRole("listbox").className).toContain("model-picker--narrow");
  });

  it("renders an empty state when no groups are available", () => {
    render(<ModelPicker groups={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/No providers available|Configure a provider/i)).toBeVisible();
  });
});
