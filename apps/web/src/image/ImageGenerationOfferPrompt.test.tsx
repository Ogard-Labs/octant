import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type {
  ImageGenerationOffer,
  ImageGenerationOfferDecisionResult,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
} from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImageGenerationOfferPrompt } from "./ImageGenerationOfferPrompt";

const scopeId = "cc000000-0000-4000-8000-000000000001" as ImageGenerationScopeId;
const openAi = "cc000000-0000-4000-8000-000000000010";
const gemini = "cc000000-0000-4000-8000-000000000011";
const offerId = "cc000000-0000-4000-8000-000000000020";

function profile(
  instanceId: string,
  displayName: string,
  models: ReadonlyArray<string>,
): ImageGenerationProfileView {
  return {
    instanceId,
    displayName,
    driverKind: "openai-image",
    modelAllowlist: models,
    defaultModel: models[0],
  } as ImageGenerationProfileView;
}

const profiles = [
  profile(openAi, "OpenAI Image", ["gpt-image-2"]),
  profile(gemini, "Gemini", ["gemini-3-pro-image", "gemini-3.1-flash-image"]),
];

function offer(overrides: Partial<ImageGenerationOffer> = {}): ImageGenerationOffer {
  return {
    offerId,
    threadKind: "code-thread",
    scopeId,
    prompt: "A lighthouse at dusk, oil painting",
    variantCount: 1,
    revision: false,
    suggested: { profileInstanceId: openAi, modelId: "gpt-image-2" },
    requestedAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  } as ImageGenerationOffer;
}

function client(
  offers: ReadonlyArray<ImageGenerationOffer>,
  answer: ImageGenerationOfferDecisionResult = { kind: "image-offer-answered" },
) {
  const fake = {
    offers: vi.fn(async () => ({ offers })),
    decideOffer: vi.fn(async () => answer),
  };
  return fake as unknown as ImageGenerationClient & typeof fake;
}

function renderPrompt(fake: ImageGenerationClient) {
  return render(
    <ImageGenerationOfferPrompt
      client={fake}
      profiles={profiles}
      scopeId={scopeId}
      threadKind="code-thread"
      turnActive={false}
    />,
  );
}

describe("ImageGenerationOfferPrompt", () => {
  it("asks whether to generate the agent's picture with an image model, the suggested model chosen", async () => {
    renderPrompt(client([offer()]));
    const card = await screen.findByRole("article", { name: "Image generation request" });
    expect(card).toHaveTextContent("Generate this image?");
    expect(card).toHaveTextContent("A lighthouse at dusk, oil painting");
    expect(card).toHaveTextContent("better picture than one the agent draws as SVG");
    expect(screen.getByRole("combobox", { name: "Image model" })).toHaveTextContent(
      "OpenAI Image · gpt-image-2",
    );
  });

  it("generates with the model the person picks and keeps it for the thread when they ask", async () => {
    const user = userEvent.setup();
    const fake = client([offer()]);
    renderPrompt(fake);
    await user.click(await screen.findByRole("combobox", { name: "Image model" }));
    await user.click(await screen.findByRole("option", { name: "Gemini · gemini-3-pro-image" }));
    await user.click(screen.getByRole("checkbox", { name: "Don't ask again in this thread" }));
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(fake.decideOffer).toHaveBeenCalledExactlyOnceWith({
        offerId,
        decision: "generate",
        profileInstanceId: gemini,
        modelId: "gemini-3-pro-image",
        rememberForThread: true,
      }),
    );
  });

  it("lets the agent draw it instead, spending nothing", async () => {
    const user = userEvent.setup();
    const fake = client([offer()]);
    renderPrompt(fake);
    await user.click(await screen.findByRole("button", { name: "Let the agent draw it" }));
    await waitFor(() =>
      expect(fake.decideOffer).toHaveBeenCalledExactlyOnceWith({
        offerId,
        decision: "agent-draws",
      }),
    );
  });

  it("keeps the card and says why when the host refuses the chosen model", async () => {
    const user = userEvent.setup();
    renderPrompt(
      client([offer()], {
        kind: "image-offer-refused",
        reason: "That image model is not available. Choose another one.",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Generate" }));
    expect(
      await screen.findByText("That image model is not available. Choose another one."),
    ).toBeVisible();
    expect(screen.getByRole("article", { name: "Image generation request" })).toBeVisible();
  });

  it("says nothing when the agent is not waiting on an image", async () => {
    const fake = client([]);
    renderPrompt(fake);
    await waitFor(() => expect(fake.offers).toHaveBeenCalled());
    expect(screen.queryByRole("article", { name: "Image generation request" })).toBeNull();
  });
});
