import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImageGenerationProfileView, ImageJob } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ImageGenerationSheet } from "./ImageGenerationSheet";

const now = "2026-08-28T12:00:00.000Z";

function openAiProfile(): ImageGenerationProfileView {
  return {
    instanceId: "a3000000-0000-4000-8000-000000000001" as ImageGenerationProfileView["instanceId"],
    displayName: "OpenAI Image",
    driverKind: "openai-image",
    modelAllowlist: ["gpt-image-2" as never],
    defaultModel: "gpt-image-2" as never,
  };
}

function geminiProfile(): ImageGenerationProfileView {
  return {
    instanceId: "a3000000-0000-4000-8000-000000000005" as ImageGenerationProfileView["instanceId"],
    displayName: "Gemini Image",
    driverKind: "gemini-native-image",
    modelAllowlist: ["gemini-3.1-flash-image" as never],
    defaultModel: "gemini-3.1-flash-image" as never,
  };
}

function bflProfile(): ImageGenerationProfileView {
  return {
    instanceId: "a3000000-0000-4000-8000-000000000006" as ImageGenerationProfileView["instanceId"],
    displayName: "FLUX",
    driverKind: "bfl-image",
    modelAllowlist: ["flux-pro-1.1" as never],
    defaultModel: "flux-pro-1.1" as never,
  };
}

function ideogramProfile(): ImageGenerationProfileView {
  return {
    instanceId: "a3000000-0000-4000-8000-000000000007" as ImageGenerationProfileView["instanceId"],
    displayName: "Ideogram",
    driverKind: "ideogram-image",
    modelAllowlist: ["ideogram-v3" as never],
    defaultModel: "ideogram-v3" as never,
  };
}

function runningJob(): ImageJob {
  return {
    id: "a3000000-0000-4000-8000-000000000003" as ImageJob["id"],
    status: "running",
    threadKind: "chat-thread",
    scopeId: "a3000000-0000-4000-8000-000000000002" as ImageJob["scopeId"],
    profileInstanceId: openAiProfile().instanceId,
    modelId: "gpt-image-2" as ImageJob["modelId"],
    promptHash: "a".repeat(64),
    artifacts: [],
    version: 2 as ImageJob["version"],
    createdAt: now as ImageJob["createdAt"],
    updatedAt: now as ImageJob["updatedAt"],
  };
}

describe("ImageGenerationSheet", () => {
  it("shows OpenAI quality and size, not Gemini aspect ratio", () => {
    render(
      <ImageGenerationSheet
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        open
        profiles={[openAiProfile()]}
      />,
    );
    expect(screen.getByLabelText("Quality")).toBeVisible();
    expect(screen.getByLabelText("Size")).toBeVisible();
    expect(screen.queryByLabelText("Aspect ratio")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resolution")).not.toBeInTheDocument();
  });

  it("shows Gemini aspect ratio and resolution, not OpenAI quality", () => {
    render(
      <ImageGenerationSheet
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        open
        profiles={[geminiProfile()]}
      />,
    );
    expect(screen.getByLabelText("Aspect ratio")).toBeVisible();
    expect(screen.getByLabelText("Resolution")).toBeVisible();
    expect(screen.queryByLabelText("Quality")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Size")).not.toBeInTheDocument();
  });

  it("shows no extra options for a BFL profile, which has neither quality nor aspect ratio", () => {
    render(
      <ImageGenerationSheet onClose={vi.fn()} onSubmit={vi.fn()} open profiles={[bflProfile()]} />,
    );
    expect(screen.queryByLabelText("Quality")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Size")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Aspect ratio")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resolution")).not.toBeInTheDocument();
  });

  it("offers only one variant for a BFL profile, which generates one image per request", async () => {
    const user = userEvent.setup();
    render(
      <ImageGenerationSheet onClose={vi.fn()} onSubmit={vi.fn()} open profiles={[bflProfile()]} />,
    );
    await user.click(screen.getByLabelText("Variant count"));
    expect(screen.getByRole("option", { name: "1" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "2" })).not.toBeInTheDocument();
  });

  it("submits a BFL draft without a quality, size, aspect ratio, or resolution field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ImageGenerationSheet onClose={vi.fn()} onSubmit={onSubmit} open profiles={[bflProfile()]} />,
    );
    await user.type(screen.getByLabelText("Image prompt"), "a red cube");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    const draft = onSubmit.mock.calls[0]![0];
    expect(draft).toMatchObject({ modelId: "flux-pro-1.1", prompt: "a red cube", variantCount: 1 });
    expect("quality" in draft).toBe(false);
    expect("size" in draft).toBe(false);
    expect("aspectRatio" in draft).toBe(false);
    expect("resolution" in draft).toBe(false);
  });

  it("shows no extra options for an Ideogram profile, which has neither quality nor aspect ratio", () => {
    render(
      <ImageGenerationSheet
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        open
        profiles={[ideogramProfile()]}
      />,
    );
    expect(screen.queryByLabelText("Quality")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Size")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Aspect ratio")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resolution")).not.toBeInTheDocument();
  });

  it("offers variant counts up to four for an Ideogram profile, unlike BFL's single-image constraint", async () => {
    const user = userEvent.setup();
    render(
      <ImageGenerationSheet
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        open
        profiles={[ideogramProfile()]}
      />,
    );
    await user.click(screen.getByLabelText("Variant count"));
    expect(screen.getByRole("option", { name: "1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "4" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "5" })).not.toBeInTheDocument();
  });

  it("submits an Ideogram draft without a quality, size, aspect ratio, or resolution field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ImageGenerationSheet
        onClose={vi.fn()}
        onSubmit={onSubmit}
        open
        profiles={[ideogramProfile()]}
      />,
    );
    await user.type(screen.getByLabelText("Image prompt"), "a red cube");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    const draft = onSubmit.mock.calls[0]![0];
    expect(draft).toMatchObject({
      modelId: "ideogram-v3",
      prompt: "a red cube",
      variantCount: 1,
    });
    expect("quality" in draft).toBe(false);
    expect("size" in draft).toBe(false);
    expect("aspectRatio" in draft).toBe(false);
    expect("resolution" in draft).toBe(false);
  });

  it("offers variant counts up to four", async () => {
    const user = userEvent.setup();
    render(
      <ImageGenerationSheet
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        open
        profiles={[openAiProfile()]}
      />,
    );
    await user.click(screen.getByLabelText("Variant count"));
    expect(screen.getByRole("option", { name: "1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "4" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "5" })).not.toBeInTheDocument();
  });

  it("cancels an in-flight job without blocking the rest of the thread", async () => {
    const user = userEvent.setup();
    const onCancelJob = vi.fn();
    render(
      <ImageGenerationSheet
        job={runningJob()}
        onCancelJob={onCancelJob}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        open
        profiles={[openAiProfile()]}
      />,
    );
    expect(screen.getByText("Generating…")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelJob).toHaveBeenCalledOnce();
  });

  it("offers a Settings link when no image profile is ready", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <ImageGenerationSheet
        onClose={vi.fn()}
        onOpenSettings={onOpenSettings}
        onSubmit={vi.fn()}
        open
        profiles={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Image prompt")).not.toBeInTheDocument();
  });
});
