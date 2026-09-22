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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerModelPicker } from "./ComposerModelPicker";

const providerA = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000a1");
const providerB = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000a2");
const modelOne = decodeProviderModelId("model-one");
const modelTwo = decodeProviderModelId("model-two");
const modelThree = decodeProviderModelId("model-three");

describe("ComposerModelPicker", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the current model label while hovering providers that do not contain it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ComposerModelPicker
        groups={groups()}
        onSelect={onSelect}
        selectedProviderInstanceId={decodeProviderInstanceId(
          "80000000-0000-4000-8000-0000000000a3",
        )}
        selectedModelId={decodeProviderModelId("current-model")}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Provider and model" });
    expect(trigger).toHaveTextContent("current-model");
    await user.click(trigger);
    await user.hover(screen.getByRole("option", { name: "Remote Claude" }));
    expect(screen.getByRole("option", { name: "Model Three" })).toBeVisible();
    expect(trigger).toHaveTextContent("current-model");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not borrow reasoning options from another provider with the same model id", async () => {
    const source = groups().map((group) => ({
      ...group,
      sections: group.sections.map((section) => ({
        ...section,
        models: section.models.map((entry) => ({
          ...entry,
          model: {
            ...entry.model,
            options: [
              {
                id: "effort",
                displayName: "Effort",
                kind: "selection" as const,
                values: ["low", "high"] as const,
              },
            ],
          },
        })),
      })),
    }));
    render(
      <ComposerModelPicker
        groups={source}
        onSelect={vi.fn()}
        onModelOptionChange={vi.fn()}
        selectedProviderInstanceId={decodeProviderInstanceId(
          "80000000-0000-4000-8000-0000000000a3",
        )}
        selectedModelId={modelOne}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.queryByRole("slider", { name: "Effort level" })).not.toBeInTheDocument();
  });

  it("names a hidden bound model without offering it as a new selection", async () => {
    const source = groups();
    const first = source[0];
    const current = first?.sections[0]?.models[0];
    if (first === undefined || current === undefined) throw new Error("Expected model fixture");
    const hidden = [{ ...first, sections: [], hiddenCurrent: current }, ...source.slice(1)];
    render(
      <ComposerModelPicker
        groups={hidden}
        onSelect={vi.fn()}
        selectedModelId={modelOne}
        selectedProviderInstanceId={providerA}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Provider and model" });
    expect(trigger).toHaveTextContent("Model One");
    await userEvent.click(trigger);
    expect(screen.queryByRole("option", { name: "Model One" })).not.toBeInTheDocument();
  });

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
    const menu = await screen.findByRole("dialog", { name: "Choose provider and model" });
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

  it("keeps the active provider when discovery refreshes the groups", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(<ComposerModelPicker groups={groups()} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const menu = await screen.findByRole("dialog", { name: "Choose provider and model" });
    await user.click(within(menu).getByRole("option", { name: "Remote Claude" }));
    expect(within(menu).getByRole("option", { name: "Model Three" })).toBeVisible();

    // Discovery emits a fresh array as provider state changes. The user's
    // active rail choice must survive that refresh instead of snapping back
    // to the selected model's provider.
    rerender(<ComposerModelPicker groups={groups({ degraded: true })} onSelect={onSelect} />);
    expect(within(menu).getByRole("option", { name: "Model Three" })).toBeVisible();
    expect(within(menu).queryByRole("option", { name: "Model One" })).not.toBeInTheDocument();
  });

  it("labels providers visibly and removes repeated provider text from their model rows", async () => {
    const user = userEvent.setup();
    render(<ComposerModelPicker groups={groups()} onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const rail = await screen.findByRole("listbox", { name: "Providers" });
    const items = within(rail).getAllByRole("option");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Favorites",
      "Local OpenCode",
      "Remote Claude",
    ]);
    for (const item of items) expect(item).toHaveTextContent(item.getAttribute("aria-label") ?? "");
    expect(screen.getByRole("option", { name: "Model One" })).not.toHaveTextContent(
      "Local OpenCode",
    );
    expect(items[0]?.querySelector("svg")).not.toBeNull();
    expect(within(rail).getByRole("option", { name: "Local OpenCode" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(rail)
        .getByRole("option", { name: "Local OpenCode" })
        .querySelector("[data-driver-kind]"),
    ).toHaveAttribute("data-driver-kind", "opencode");
    expect(
      within(rail)
        .getByRole("option", { name: "Remote Claude" })
        .querySelector("[data-driver-kind]"),
    ).toHaveAttribute("data-driver-kind", "claude");
  });

  it("stars models into a persisted cross-provider Favorites list without selecting them", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { unmount } = render(<ComposerModelPicker groups={groups()} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const menu = await screen.findByRole("dialog", { name: "Choose provider and model" });
    const modelTwoRow = within(menu).getByRole("option", { name: "Model Two" }).parentElement!;
    const star = within(modelTwoRow).getByRole("button", { name: "Add Model Two to favorites" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    await user.click(star);
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu).toBeInTheDocument();
    expect(
      within(modelTwoRow).getByRole("button", { name: "Remove Model Two from favorites" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(within(menu).getByRole("option", { name: "Remote Claude" }));
    const modelThreeRow = within(menu).getByRole("option", { name: "Model Three" }).parentElement!;
    await user.click(
      within(modelThreeRow).getByRole("button", { name: "Add Model Three to favorites" }),
    );

    await user.click(within(menu).getByRole("option", { name: "Favorites" }));
    const favoriteNames = within(within(menu).getByRole("listbox", { name: "Models" }))
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label"));
    expect(favoriteNames).toEqual(["Model Two", "Model Three"]);
    expect(within(menu).queryByRole("option", { name: "Model One" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("octant.models.favorites.v1") ?? "[]")).toEqual([
      `${String(providerA)}:${String(modelTwo)}`,
      `${String(providerB)}:${String(modelThree)}`,
    ]);

    unmount();
    render(<ComposerModelPicker groups={groups()} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.click(await screen.findByRole("option", { name: "Favorites" }));
    expect(screen.getByRole("option", { name: "Model Three" })).toBeVisible();
    const modelTwoAgain = screen.getByRole("option", { name: "Model Two" }).parentElement!;
    await user.click(
      within(modelTwoAgain).getByRole("button", { name: "Remove Model Two from favorites" }),
    );
    expect(screen.queryByRole("option", { name: "Model Two" })).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows readiness labels on providers that are not fully ready", async () => {
    const user = userEvent.setup();
    render(<ComposerModelPicker groups={groups({ degraded: true })} onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(await screen.findByText("Degraded")).toBeVisible();
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
    expect(await screen.findByText("Chat only")).toBeVisible();
    expect(screen.queryByText(longReason)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Model One" })).toHaveAttribute("title", longReason);
  });

  it("splits one provider's models by the catalog each came from, and filters to one", async () => {
    const user = userEvent.setup();
    render(<ComposerModelPicker groups={routerGroups()} onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const menu = await screen.findByRole("dialog", { name: "Choose provider and model" });
    expect(
      within(menu)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Catalogs", "Alibaba", "Anthropic"]);
    expect(
      within(within(menu).getByRole("group", { name: "Alibaba" }))
        .getAllByRole("option")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual(["Qwen3 14B"]);

    await user.click(within(menu).getByRole("button", { name: "Anthropic", pressed: false }));
    expect(within(menu).queryByRole("option", { name: "Qwen3 14B" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: "Claude Sonnet" })).toBeVisible();
    expect(within(menu).queryByRole("group", { name: "Anthropic" })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("button", { name: "All", pressed: false }));
    expect(within(menu).getByRole("option", { name: "Qwen3 14B" })).toBeVisible();
  });

  it("finds models by the catalog that serves them even when the model name never says it", async () => {
    const user = userEvent.setup();
    render(<ComposerModelPicker groups={routerGroups()} onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const menu = await screen.findByRole("dialog", { name: "Choose provider and model" });
    await user.type(within(menu).getByRole("searchbox", { name: "Search models" }), "alibaba");

    expect(
      within(within(menu).getByRole("listbox", { name: "Models" }))
        .getAllByRole("option")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual(["Qwen3 14B"]);
    expect(within(menu).getByRole("option", { name: "Qwen3 14B" })).toHaveTextContent(
      "Local OpenCode · Alibaba",
    );
    expect(within(menu).queryByRole("button", { name: "All" })).not.toBeInTheDocument();
  });

  it("draws the selected model's reasoning level and reports the chosen level", async () => {
    const user = userEvent.setup();
    const onModelOptionChange = vi.fn();
    const view = (effortValue?: string) =>
      render(
        <ComposerModelPicker
          groups={groups()}
          modelOptions={[
            {
              id: "effort",
              displayName: "Effort",
              values: ["low", "medium", "high"],
              ...(effortValue === undefined ? {} : { value: effortValue }),
            },
          ]}
          onModelOptionChange={onModelOptionChange}
          onSelect={vi.fn()}
          selectedModelId={modelOne}
          selectedProviderInstanceId={providerA}
        />,
      );
    view("medium");

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const level = await screen.findByRole("slider", { name: "Effort level" });
    // Default is the first stop; the model's three declared levels fill the
    // rest, so the knob starts at stop 2 of 4 and reads the level it sits on.
    expect(level).toHaveAttribute("aria-valuenow", "2");
    expect(level).toHaveAttribute("aria-valuemax", "3");
    expect(level).toHaveAttribute("aria-valuetext", "Medium");

    await user.click(level);
    await user.keyboard("{ArrowRight}");
    expect(onModelOptionChange).toHaveBeenLastCalledWith("effort", "high");
    await user.keyboard("{Home}");
    expect(onModelOptionChange).toHaveBeenLastCalledWith("effort", undefined);
  });

  it("names both ends of the level range under the slider, wherever the knob sits", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelPicker
        groups={groups()}
        modelOptions={[
          {
            id: "effort",
            displayName: "Effort",
            values: ["low", "medium", "high"],
            value: "medium",
          },
        ]}
        onModelOptionChange={vi.fn()}
        onSelect={vi.fn()}
        selectedModelId={modelOne}
        selectedProviderInstanceId={providerA}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const slider = await screen.findByRole("slider", { name: "Effort level" });
    // Stops alone gave no sense of the range: at Default the knob sat on the
    // left with nothing saying what lay to its right.
    const ends = slider.nextElementSibling;
    expect(ends).toHaveTextContent(/^DefaultHigh$/);
  });

  it("spells out a provider's extra-high level instead of capitalising its id", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelPicker
        groups={groups()}
        modelOptions={[
          { id: "effort", displayName: "Effort", values: ["high", "xhigh"], value: "xhigh" },
        ]}
        onModelOptionChange={vi.fn()}
        onSelect={vi.fn()}
        selectedModelId={modelOne}
        selectedProviderInstanceId={providerA}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(await screen.findByRole("slider", { name: "Effort level" })).toHaveAttribute(
      "aria-valuetext",
      "Extra high",
    );
  });

  it("reads the knob's level from the thread's stored effort", async () => {
    const user = userEvent.setup();
    const renderView = (effortValue: string) =>
      render(
        <ComposerModelPicker
          groups={groups()}
          modelOptions={[
            {
              id: "effort",
              displayName: "Effort",
              values: ["low", "medium", "high"],
              value: effortValue,
            },
          ]}
          onModelOptionChange={vi.fn()}
          onSelect={vi.fn()}
          selectedModelId={modelOne}
          selectedProviderInstanceId={providerA}
        />,
      );

    const { unmount } = renderView("high");
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.getByRole("slider", { name: "Effort level" })).toHaveAttribute(
      "aria-valuetext",
      "High",
    );
    unmount();
    renderView("medium");
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.getByRole("slider", { name: "Effort level" })).toHaveAttribute(
      "aria-valuetext",
      "Medium",
    );
  });

  it("keeps the level control out when no reasoning option is declared", async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelPicker
        groups={groups()}
        modelOptions={[{ id: "service-tier", displayName: "Service tier", values: ["fast"] }]}
        onModelOptionChange={vi.fn()}
        onSelect={vi.fn()}
        selectedModelId={modelOne}
        selectedProviderInstanceId={providerA}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await screen.findByRole("dialog", { name: "Choose provider and model" });
    expect(screen.queryByRole("slider", { name: /level$/i })).not.toBeInTheDocument();
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
      harnessAutoReview: "unsupported",
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

function routerGroups() {
  return buildModelPickerGroups({
    instances: [instance("opencode", providerA, "Local OpenCode")],
    observedByInstance: new Map([
      [
        providerA,
        observation(providerA, [
          model(decodeProviderModelId("anthropic/claude-sonnet-4"), "Claude Sonnet"),
          model(decodeProviderModelId("alibaba/qwen3-14b"), "Qwen3 14B"),
          model(decodeProviderModelId("anthropic/claude-haiku-4"), "Claude Haiku"),
        ]),
      ],
    ]),
    mode: "chat",
  });
}

describe("ComposerModelPicker with the native harness", () => {
  it("shows every harness endpoint under one Octant entry and still selects the real endpoint", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const endpointA = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000b1");
    const endpointB = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000b2");
    const railGroups = buildModelPickerGroups({
      instances: [
        instance("opencode", providerA, "Local OpenCode"),
        endpointInstance("openai-compatible", endpointA, "My OpenAI key"),
        endpointInstance("anthropic-compatible", endpointB, "My Anthropic key"),
      ],
      observedByInstance: new Map<
        ReturnType<typeof decodeProviderInstanceId>,
        ProviderObservedState
      >([
        [providerA, observation(providerA, [model(modelOne, "Model One")])],
        [endpointA, observation(endpointA, [model(decodeProviderModelId("gpt-x"), "GPT X")])],
        [endpointB, observation(endpointB, [model(decodeProviderModelId("claude-y"), "Claude Y")])],
      ]),
      mode: "chat",
    });
    render(<ComposerModelPicker groups={railGroups} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const rail = await screen.findByRole("listbox", { name: "Providers" });
    expect(
      within(rail)
        .getAllByRole("option")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Favorites", "Local OpenCode", "Octant"]);
    await user.click(within(rail).getByRole("option", { name: "Octant" }));
    const menu = screen.getByRole("dialog", { name: "Choose provider and model" });
    expect(within(menu).getByRole("option", { name: "GPT X" })).toBeVisible();
    expect(within(menu).getByRole("group", { name: "My OpenAI key" })).toBeVisible();
    expect(within(menu).getByRole("group", { name: "My Anthropic key" })).toBeVisible();
    await user.click(within(menu).getByRole("option", { name: "Claude Y" }));
    expect(onSelect).toHaveBeenCalledWith({
      providerInstanceId: endpointB,
      modelId: decodeProviderModelId("claude-y"),
    });
  });
});

function endpointInstance(
  driverKind: "openai-compatible" | "anthropic-compatible",
  id: ReturnType<typeof decodeProviderInstanceId>,
  displayName: string,
): ProviderInstance {
  return {
    id,
    displayName,
    driverKind,
    configuration:
      driverKind === "openai-compatible"
        ? {
            kind: "openai-compatible-http",
            baseUrl: "https://gateway.example/v1/",
            authentication: "none",
            protocol: "responses",
            manualModelIds: [],
          }
        : {
            kind: "anthropic-compatible-http",
            baseUrl: "https://anthropic.example/v1/",
            authentication: "none",
            protocol: "messages",
            manualModelIds: [],
          },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-14T10:00:00.000Z" as never,
    updatedAt: "2026-07-14T10:00:00.000Z" as never,
  } as ProviderInstance;
}
