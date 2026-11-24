// @vitest-environment jsdom
import type { PickerGroup } from "@octant/domain";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptHandoff, resolveTranscriptHandoff } from "./TranscriptHandoff";

const codexId = "10000000-0000-4000-8000-000000000001";
const claudeId = "10000000-0000-4000-8000-000000000002";
const claudeWorkId = "10000000-0000-4000-8000-000000000003";

function group(
  id: string,
  driverKind: string,
  displayName: string,
  models: ReadonlyArray<{ readonly id: string; readonly displayName: string }>,
): PickerGroup {
  return {
    instance: { id, driverKind, displayName },
    sections: [{ models: models.map((model) => ({ model })) }],
  } as unknown as PickerGroup;
}

const groups: ReadonlyArray<PickerGroup> = [
  group(codexId, "codex", "Codex", [{ id: "gpt-5.3", displayName: "GPT-5.3" }]),
  group(claudeId, "claude", "Claude Personal", [
    { id: "claude-sonnet-4", displayName: "Sonnet 4" },
    { id: "claude-opus-4", displayName: "Opus 4" },
  ]),
  group(claudeWorkId, "claude", "Claude Work", [
    { id: "claude-sonnet-4", displayName: "Sonnet 4" },
  ]),
];

describe("TranscriptHandoff", () => {
  it("renders a context handoff divider with both provider marks and the disclosure note", () => {
    const entry = resolveTranscriptHandoff({
      previous: { providerInstanceId: codexId, modelId: "gpt-5.3" },
      current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "provider-switch",
        previousProviderInstanceId: codexId,
        previousModelId: "gpt-5.3",
      },
      disclosure: "Handed over 4 recent messages from Codex — GPT-5.3 as text.",
    });

    expect(entry).toBeDefined();
    const { container } = render(<TranscriptHandoff entry={entry!} providerGroups={groups} />);

    const separator = screen.getByRole("separator", {
      name: "Context handoff from Codex — GPT-5.3 to Claude Personal — Sonnet 4",
    });
    expect(separator).toHaveTextContent("Context handoff");
    expect(separator).toHaveTextContent("GPT-5.3");
    expect(separator).toHaveTextContent("Sonnet 4");
    expect(container.querySelectorAll(".provider-glyph")).toHaveLength(2);
    expect(screen.getByRole("note")).toHaveTextContent(
      "Handed over 4 recent messages from Codex — GPT-5.3 as text.",
    );
  });

  it("names both accounts when moving to another account running the same model", () => {
    const entry = resolveTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeWorkId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "account-move-native-session",
        previousProviderInstanceId: claudeId,
        previousModelId: "claude-sonnet-4",
      },
    });

    expect(entry).toBeDefined();
    const { container } = render(<TranscriptHandoff entry={entry!} providerGroups={groups} />);

    const separator = screen.getByRole("separator", {
      name: "Context handoff from Claude Personal — Sonnet 4 to Claude Work — Sonnet 4",
    });
    expect(separator).toHaveTextContent("Claude Personal · Sonnet 4");
    expect(separator).toHaveTextContent("Claude Work · Sonnet 4");
    expect(container.querySelectorAll(".provider-glyph")).toHaveLength(2);
  });

  it("distinguishes an in-session model switch from a context handoff and draws one provider mark", () => {
    const entry = resolveTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-opus-4" },
    });

    expect(entry?.kind).toBe("model-switch");
    const { container } = render(<TranscriptHandoff entry={entry!} providerGroups={groups} />);

    const separator = screen.getByRole("separator", {
      name: "Model switch from Sonnet 4 to Opus 4",
    });
    expect(separator).toHaveTextContent("Model switch");
    expect(separator).toHaveTextContent("Sonnet 4");
    expect(separator).toHaveTextContent("Opus 4");
    expect(container.querySelectorAll(".provider-glyph")).toHaveLength(1);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("marks a same-provider model change as a context handoff when a text handoff was recorded", () => {
    const entry = resolveTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-opus-4" },
      handoff: {
        reason: "provider-switch",
        previousProviderInstanceId: claudeId,
        previousModelId: "claude-sonnet-4",
      },
      disclosure: "Handed over 2 recent messages.",
    });

    expect(entry?.kind).toBe("context-handoff");
    render(<TranscriptHandoff entry={entry!} providerGroups={groups} />);
    expect(
      screen.getByRole("separator", {
        name: "Context handoff from Sonnet 4 to Opus 4",
      }),
    ).toBeVisible();
  });

  it("prefers the recorded handoff source when a stopped handoff repeats on the destination provider", () => {
    const entry = resolveTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "provider-switch",
        previousProviderInstanceId: codexId,
        previousModelId: "gpt-5.3",
      },
      disclosure: "Handed over 4 recent messages from Codex — GPT-5.3 as text.",
    });

    expect(entry?.kind).toBe("context-handoff");
    expect(entry?.from).toEqual({ providerInstanceId: codexId, modelId: "gpt-5.3" });
    expect(entry?.to).toEqual({ providerInstanceId: claudeId, modelId: "claude-sonnet-4" });
    render(<TranscriptHandoff entry={entry!} providerGroups={groups} />);
    expect(
      screen.getByRole("separator", {
        name: "Context handoff from Codex — GPT-5.3 to Claude Personal — Sonnet 4",
      }),
    ).toBeVisible();
  });

  it("keeps an explicit fork label when the fork opens on a different model of the same provider", () => {
    const entry = resolveTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-opus-4" },
      handoff: { reason: "fork" },
      disclosure: "Forked with 2 recent messages of the source conversation as text.",
    });

    expect(entry?.kind).toBe("fork");
    expect(entry?.from).toEqual({ providerInstanceId: claudeId, modelId: "claude-sonnet-4" });
    expect(entry?.to).toEqual({ providerInstanceId: claudeId, modelId: "claude-opus-4" });
    render(<TranscriptHandoff entry={entry!} providerGroups={groups} />);
    const separator = screen.getByRole("separator", {
      name: "Forked context from Sonnet 4 to Opus 4",
    });
    expect(separator).toHaveTextContent("Forked context");
    expect(separator).toHaveTextContent("Sonnet 4");
    expect(separator).toHaveTextContent("Opus 4");
  });

  it("recovers the source model from a recorded handoff when earlier turns are not loaded", () => {
    const entry = resolveTranscriptHandoff({
      current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "provider-switch",
        previousProviderInstanceId: codexId,
        previousModelId: "gpt-5.3",
      },
    });

    expect(entry?.kind).toBe("context-handoff");
    expect(entry?.from).toEqual({ providerInstanceId: codexId, modelId: "gpt-5.3" });
    expect(entry?.to).toEqual({ providerInstanceId: claudeId, modelId: "claude-sonnet-4" });
  });

  it("labels a fork, branch, or rewind on the same model without inventing a model transition", () => {
    const entry = resolveTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      handoff: { reason: "rewind" },
      disclosure: "After the rewind, a fresh session started.",
    });

    expect(entry?.kind).toBe("rewind");
    expect(entry?.from).toBeUndefined();
    render(<TranscriptHandoff entry={entry!} providerGroups={groups} />);
    expect(screen.getByRole("separator", { name: "Rewound context" })).toHaveTextContent(
      "Rewound context",
    );
    expect(screen.getByRole("note")).toHaveTextContent("After the rewind");
  });

  it("returns nothing when neither the provider nor the model changed and no handoff occurred", () => {
    expect(
      resolveTranscriptHandoff({
        previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
        current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      }),
    ).toBeUndefined();
  });
});
