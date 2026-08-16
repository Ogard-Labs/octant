import type { MultiModelPool } from "@octant/contracts/multi-model-pool";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { HostId } from "@octant/contracts/shell";
import type { ComposerPoolModel } from "@octant/domain/composer-pool-policy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerPoolControl } from "./ComposerPoolControl";

const hostId = "local" as HostId;
const openAiInstanceId = "80000000-0000-4000-8000-000000000010" as ProviderInstanceId;
const anthropicInstanceId = "80000000-0000-4000-8000-000000000020" as ProviderInstanceId;

function candidate(modelId: string, providerInstanceId = openAiInstanceId) {
  return {
    hostId,
    providerInstanceId,
    modelId: modelId as ProviderModelId,
  };
}

function readyModel(overrides: Partial<Extract<ComposerPoolModel, { kind: "ready" }>> = {}) {
  return {
    kind: "ready",
    candidates: [
      {
        candidate: candidate("gpt-5.2"),
        providerName: "OpenAI gateway",
        modelName: "GPT 5.2",
        selectable: true,
        requiresMixedVendor: false,
        isCurrent: true,
      },
      {
        candidate: candidate("gpt-5.2-mini"),
        providerName: "OpenAI gateway",
        modelName: "GPT 5.2 Mini",
        selectable: true,
        requiresMixedVendor: false,
        isCurrent: false,
      },
    ],
    mixedVendorRequired: false,
    ...overrides,
  } satisfies ComposerPoolModel;
}

describe("ComposerPoolControl", () => {
  it("keeps the pool control stacked in narrow composer layouts", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const chatStyles = readFileSync(resolve(process.cwd(), "src/styles/chat.css"), "utf8");
    expect(styles).toMatch(
      /\.composer-pool-control\s*\{[^}]*container:\s*composer-pool-control\s*\/\s*inline-size;/,
    );
    expect(styles).toMatch(
      /@container composer-pool-control \(max-width: 480px\)\s*\{[^}]*\.composer-pool-control__option\s*\{[^}]*grid-template-columns:\s*1fr;/,
    );
    expect(chatStyles).toMatch(
      /\.chat-composer \.composer-pool-control\s*\{[^}]*min-width:\s*132px;/,
    );
  });

  it("shows an honest loading state before eligible models arrive", () => {
    render(<ComposerPoolControl model={{ kind: "loading" }} onApply={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Use multiple models" });
    expect(trigger).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/loading eligible models/i);
  });

  it("shows the unavailable reason when Settings define no pool", () => {
    render(
      <ComposerPoolControl
        model={{
          kind: "unavailable",
          reason: "No agent-eligible models are defined in Provider Settings.",
        }}
        onApply={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Use multiple models" });
    expect(trigger).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/no agent-eligible models/i);
    expect(screen.getByRole("status")).toHaveClass("composer-pool-control__visually-hidden");
  });

  it("enables a pool of two eligible models via keyboard and applies the narrowed pool", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => true);
    render(<ComposerPoolControl model={readyModel()} onApply={onApply} />);

    const trigger = screen.getByRole("button", { name: "Use multiple models" });
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    trigger.focus();
    await user.keyboard("{Enter}");

    // Current route is pre-selected; the sibling is toggled by keyboard.
    const sibling = screen.getByRole("checkbox", { name: "OpenAI gateway — GPT 5.2 Mini" });
    expect(screen.getByRole("checkbox", { name: "OpenAI gateway — GPT 5.2" })).toBeChecked();
    expect(sibling).not.toBeChecked();
    sibling.focus();
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Apply pool" }));

    expect(onApply).toHaveBeenCalledWith({
      candidates: [candidate("gpt-5.2"), candidate("gpt-5.2-mini")],
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: false,
    } satisfies MultiModelPool);
  });

  it("requires at least two selected models before a pool can be applied", async () => {
    const user = userEvent.setup();
    render(<ComposerPoolControl model={readyModel()} onApply={vi.fn(async () => true)} />);
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));
    const apply = screen.getByRole("button", { name: "Apply pool" });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(/at least two/i);
  });

  it("filters the pool editor through the search box", async () => {
    const user = userEvent.setup();
    render(<ComposerPoolControl model={readyModel()} onApply={vi.fn(async () => true)} />);
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));
    await user.type(screen.getByRole("searchbox", { name: "Search models" }), "mini");
    expect(screen.queryByRole("checkbox", { name: "OpenAI gateway — GPT 5.2" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "OpenAI gateway — GPT 5.2 Mini" })).toBeVisible();
  });

  it("keeps ineligible models visible but not selectable, with the policy reason", async () => {
    const user = userEvent.setup();
    const model = readyModel({
      candidates: [
        ...readyModel().candidates,
        {
          candidate: candidate("model-gone"),
          providerName: "OpenAI gateway",
          modelName: "model-gone",
          selectable: false,
          unavailableReason: "Model is no longer listed by the provider.",
          requiresMixedVendor: false,
          isCurrent: false,
        },
      ],
    });
    render(<ComposerPoolControl model={model} onApply={vi.fn(async () => true)} />);
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));
    const gone = screen.getByRole("checkbox", { name: "OpenAI gateway — model-gone" });
    expect(gone).toBeDisabled();
    expect(screen.getByText("Model is no longer listed by the provider.")).toBeVisible();
  });

  it("keeps cross-vendor models behind the separate explicit mixed-vendor opt-in", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => true);
    const model = readyModel({
      candidates: [
        ...readyModel().candidates,
        {
          candidate: candidate("claude-x", anthropicInstanceId),
          providerName: "Anthropic gateway",
          modelName: "Claude X",
          selectable: true,
          requiresMixedVendor: true,
          isCurrent: false,
        },
      ],
      mixedVendorRequired: true,
    });
    render(<ComposerPoolControl model={model} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));

    const crossVendor = screen.getByRole("checkbox", { name: "Anthropic gateway — Claude X" });
    expect(crossVendor).toBeDisabled();
    const optIn = screen.getByRole("checkbox", { name: "Allow mixed-vendor routing" });
    expect(optIn).not.toBeChecked();
    expect(
      screen.getByText(/models from other vendors can receive this thread's context/i),
    ).toBeVisible();

    await user.click(optIn);
    expect(crossVendor).toBeEnabled();
    await user.click(crossVendor);
    await user.click(screen.getByRole("checkbox", { name: "OpenAI gateway — GPT 5.2 Mini" }));
    await user.click(screen.getByRole("button", { name: "Apply pool" }));
    expect(onApply).toHaveBeenCalledWith({
      candidates: [
        candidate("gpt-5.2"),
        candidate("gpt-5.2-mini"),
        candidate("claude-x", anthropicInstanceId),
      ],
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: false,
    } satisfies MultiModelPool);
  });

  it("deselects cross-vendor models when the mixed-vendor opt-in is withdrawn", async () => {
    const user = userEvent.setup();
    const model = readyModel({
      candidates: [
        ...readyModel().candidates,
        {
          candidate: candidate("claude-x", anthropicInstanceId),
          providerName: "Anthropic gateway",
          modelName: "Claude X",
          selectable: true,
          requiresMixedVendor: true,
          isCurrent: false,
        },
      ],
      mixedVendorRequired: true,
    });
    render(<ComposerPoolControl model={model} onApply={vi.fn(async () => true)} />);
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));
    const optIn = screen.getByRole("checkbox", { name: "Allow mixed-vendor routing" });
    await user.click(optIn);
    const crossVendor = screen.getByRole("checkbox", { name: "Anthropic gateway — Claude X" });
    await user.click(crossVendor);
    expect(crossVendor).toBeChecked();
    await user.click(optIn);
    expect(
      screen.getByRole("checkbox", { name: "Anthropic gateway — Claude X" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Anthropic gateway — Claude X" })).toBeDisabled();
  });

  it("shows the active pool and restores the unchanged single-model flow", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => true);
    const activePool: MultiModelPool = {
      candidates: [candidate("gpt-5.2"), candidate("gpt-5.2-mini")],
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: false,
    } as MultiModelPool;
    render(<ComposerPoolControl model={readyModel()} onApply={onApply} pool={activePool} />);

    const trigger = screen.getByRole("button", { name: "Use multiple models" });
    expect(trigger).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/pool of 2 models/i);

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Use single model" }));
    expect(onApply).toHaveBeenCalledWith(undefined);
  });

  it("keeps the editor open with an actionable error when applying fails, then recovers", async () => {
    const user = userEvent.setup();
    const onApply = vi
      .fn<(pool: MultiModelPool | undefined) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(<ComposerPoolControl model={readyModel()} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));
    await user.click(screen.getByRole("checkbox", { name: "OpenAI gateway — GPT 5.2 Mini" }));
    await user.click(screen.getByRole("button", { name: "Apply pool" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/could not be applied/i);
    expect(screen.getByRole("button", { name: "Apply pool" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Apply pool" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("closes the editor with Escape without applying anything", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => true);
    render(<ComposerPoolControl model={readyModel()} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Use multiple models" }));
    expect(screen.getByRole("searchbox", { name: "Search models" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox", { name: "Search models" })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });
});
