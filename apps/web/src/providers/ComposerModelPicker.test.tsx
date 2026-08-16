import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderInstance,
  type ProviderModel,
  type ProviderObservedState,
} from "@octant/contracts";
import { buildModelPickerGroups } from "@octant/domain";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerModelPicker } from "./ComposerModelPicker";

const providerA = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000a1");
const providerB = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000a2");
const modelOne = decodeProviderModelId("model-one");
const modelTwo = decodeProviderModelId("model-two");
const modelThree = decodeProviderModelId("model-three");

describe("ComposerModelPicker", () => {
  it("opens a nested provider → model menu from the compact trigger", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ComposerModelPicker
        groups={groups()}
        onSelect={onSelect}
        selectedModelId={modelOne}
        selectedProviderInstanceId={providerA}
      />,
    );

    expect(screen.getByRole("button", { name: "Provider and model" })).toHaveTextContent(
      "Model One",
    );
    expect(
      screen.queryByRole("dialog", { name: "Choose provider and model" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const menu = screen.getByRole("dialog", { name: "Choose provider and model" });
    expect(within(menu).getByRole("option", { name: "Local OpenCode" })).toBeVisible();
    expect(within(menu).getByRole("option", { name: "Remote Claude" })).toBeVisible();
    expect(within(menu).getByRole("option", { name: "Model One" })).toBeVisible();
    expect(within(menu).getByRole("option", { name: "Model Two" })).toBeVisible();
    expect(within(menu).queryByRole("option", { name: "Model Three" })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("option", { name: "Remote Claude" }));
    expect(within(menu).getByRole("option", { name: "Model Three" })).toBeVisible();
    expect(within(menu).queryByRole("option", { name: "Model One" })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("option", { name: "Model Three" }));
    expect(onSelect).toHaveBeenCalledWith({
      providerInstanceId: providerB,
      modelId: modelThree,
    });
    expect(
      screen.queryByRole("dialog", { name: "Choose provider and model" }),
    ).not.toBeInTheDocument();
  });

  it("shows readiness labels on providers that are not fully ready", async () => {
    const user = userEvent.setup();
    render(<ComposerModelPicker groups={groups({ degraded: true })} onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.getByText("Degraded")).toBeVisible();
  });

  it("offers Settings when no providers are ready", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<ComposerModelPicker groups={[]} onOpenSettings={onOpenSettings} onSelect={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Provider and model" });
    expect(trigger).toHaveTextContent("No provider ready");
    await user.click(trigger);
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("keeps the provider control visible but disabled when configuration cannot be opened", () => {
    render(<ComposerModelPicker groups={[]} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Provider and model" })).toBeDisabled();
  });

  it("shows a compact Chat only badge instead of repeating tool-call warnings", async () => {
    const user = userEvent.setup();
    const longReason =
      "Tool calling has not been verified for this model. Run a capability check before using it for tool work.";
    const codeGroups = buildModelPickerGroups({
      instances: [instance("opencode", providerA, "Local OpenCode")],
      observedByInstance: new Map([
        [
          providerA,
          observation(providerA, [
            {
              id: modelOne,
              displayName: "Model One",
              source: "discovered",
              verification: "unverified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            } as unknown as ProviderModel,
          ]),
        ],
      ]),
      mode: "code",
    });
    expect(codeGroups[0]?.sections.some((section) => section.id === "chat-and-analysis-only")).toBe(
      true,
    );

    render(<ComposerModelPicker groups={codeGroups} onSelect={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.getByText("Chat only")).toBeVisible();
    expect(screen.queryByText(longReason)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Model One" })).toHaveAttribute("title", longReason);
  });
});

function groups(options?: { readonly degraded?: boolean }) {
  const instances = [
    instance("opencode", providerA, "Local OpenCode"),
    instance("claude", providerB, "Remote Claude"),
  ];
  const observedByInstance = new Map<
    ReturnType<typeof decodeProviderInstanceId>,
    ProviderObservedState
  >([
    [
      providerA,
      observation(providerA, [model(modelOne, "Model One"), model(modelTwo, "Model Two")], {
        readiness: options?.degraded === true ? "degraded" : "ready",
      }),
    ],
    [providerB, observation(providerB, [model(modelThree, "Model Three")])],
  ]);
  return buildModelPickerGroups({
    instances,
    observedByInstance,
    mode: "chat",
  });
}

function instance(
  driverKind: "opencode" | "claude",
  id: ReturnType<typeof decodeProviderInstanceId>,
  displayName: string,
): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName,
    driverKind,
    configuration:
      driverKind === "opencode"
        ? { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" }
        : {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "subscription",
          },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-14T10:00:00.000Z" as never,
    updatedAt: "2026-07-14T10:00:00.000Z" as never,
  });
}

function model(id: ReturnType<typeof decodeProviderModelId>, displayName: string): ProviderModel {
  return {
    id,
    displayName,
    source: "discovered",
    verification: "verified",
    reasoning: "unavailable",
    inputModalities: ["text"],
    options: [],
  };
}

function observation(
  instanceId: ReturnType<typeof decodeProviderInstanceId>,
  models: ReadonlyArray<ProviderModel>,
  patch: Partial<ProviderObservedState> = {},
): ProviderObservedState {
  return {
    instanceId,
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
    observedAt: "2026-07-14T10:00:00.000Z" as never,
    lastSuccessfulProbeAt: "2026-07-14T10:00:00.000Z" as never,
    ...patch,
  } as ProviderObservedState;
}
