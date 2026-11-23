import type { ServiceOfferClient } from "@octant/client-runtime/service-offer-client";
import {
  decodeNarrationOffer,
  decodeTranscriptionOffer,
  decodeVideoGenerateOffer,
  type ServiceOffer,
} from "@octant/contracts";
import type {
  ImageGenerationOffer,
  ServiceOfferDecisionResult,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
} from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ServiceOfferPrompt } from "./ServiceOfferPrompt";

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
    kind: "generate",
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
  offers: ReadonlyArray<ServiceOffer>,
  answer: ServiceOfferDecisionResult = { kind: "offer-answered" },
) {
  const fake = {
    offers: vi.fn(async () => ({ offers })),
    decide: vi.fn(async () => answer),
  };
  return fake satisfies ServiceOfferClient;
}

function renderPrompt(fake: ServiceOfferClient, keptIn: "project" | "thread" = "project") {
  return render(
    <ServiceOfferPrompt
      client={fake}
      keptIn={keptIn}
      profiles={profiles}
      scopeId={scopeId}
      threadKind="code-thread"
      turnActive={false}
    />,
  );
}

describe("ServiceOfferPrompt", () => {
  it.each([true, false])(
    "discloses the recording and destination before answering: approve %s",
    async (approve) => {
      const fake = client([
        decodeTranscriptionOffer({
          kind: "transcribe",
          threadKind: "code-thread",
          scopeId,
          offerId,
          requestedAt: "2026-11-07T10:00:00.000Z",
          relativePath: "meetings/notes.m4a",
          sizeBytes: 2048,
          endpointName: "Studio",
          modelId: "speech-model",
        }),
      ]);
      renderPrompt(fake);
      const card = await screen.findByRole("article", { name: "Transcription request" });
      expect(card).toHaveTextContent("meetings/notes.m4a (2,048 bytes)");
      expect(card).toHaveTextContent("Studio (speech-model)");
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Don't ask again in this thread" }),
      );
      expect(fake.decide).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: approve ? "Transcribe" : "Don't transcribe" }),
      );
      expect(fake.decide).toHaveBeenCalledExactlyOnceWith(
        approve
          ? { offerId, decision: "transcribe", rememberForThread: true }
          : { offerId, decision: "cancel" },
      );
    },
  );
  it.each([true, false])(
    "discloses the narration excerpt, path, voice and destination before answering: approve %s",
    async (approve) => {
      const fake = client([
        decodeNarrationOffer({
          kind: "narrate",
          threadKind: "code-thread",
          scopeId,
          offerId,
          requestedAt: "2026-11-07T10:00:00.000Z",
          excerpt: "Welcome to the product tour",
          characters: 420,
          relativePath: "narration/intro.mp3",
          voice: "nova",
          endpointName: "Studio",
          modelId: "tts-1",
          format: "mp3",
        }),
      ]);
      renderPrompt(fake);
      const card = await screen.findByRole("article", { name: "Narration request" });
      expect(card).toHaveTextContent("Welcome to the product tour…");
      expect(card).toHaveTextContent("narration/intro.mp3");
      expect(card).toHaveTextContent("420 characters");
      expect(card).toHaveTextContent("Voice nova on Studio (tts-1)");
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Don't ask again in this thread" }),
      );
      expect(fake.decide).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: approve ? "Narrate" : "Don't narrate" }),
      );
      expect(fake.decide).toHaveBeenCalledExactlyOnceWith(
        approve
          ? { offerId, decision: "narrate", rememberForThread: true }
          : { offerId, decision: "cancel" },
      );
    },
  );
  it("hides Don't ask again on a narration card when the access level always asks", async () => {
    const fake = client([
      decodeNarrationOffer({
        kind: "narrate",
        threadKind: "code-thread",
        scopeId,
        offerId,
        requestedAt: "2026-11-07T10:00:00.000Z",
        excerpt: "Ask first narration",
        characters: 19,
        relativePath: "narration/ask.mp3",
        voice: "alloy",
        endpointName: "Studio",
        modelId: "tts-1",
        format: "mp3",
        canRemember: false,
      }),
    ]);
    renderPrompt(fake);
    await screen.findByRole("article", { name: "Narration request" });
    expect(
      screen.queryByRole("checkbox", { name: "Don't ask again in this thread" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Narrate" }));
    expect(fake.decide).toHaveBeenCalledExactlyOnceWith({
      offerId,
      decision: "narrate",
      rememberForThread: false,
    });
  });
  it("asks whether to make the clip once a video offer's card has loaded", async () => {
    const fake = client([
      decodeVideoGenerateOffer({
        kind: "video-generate",
        threadKind: "code-thread",
        scopeId,
        offerId,
        requestedAt: "2026-11-07T10:00:00.000Z",
        prompt: "A paper boat on a pond",
        images: [],
        profileInstanceId: "cc000000-0000-4000-8000-000000000012",
        profileName: "Video",
        providerName: "Example",
        model: {
          modelId: "clip-1",
          displayName: "Clip One",
          durations: { kind: "values", values: [5, 10] },
          resolutions: ["720p"],
          aspectRatios: [{ ratio: "16:9" }],
          audio: "optional",
          inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 0 },
          price: {
            kind: "per-second",
            rates: [{ resolution: "720p", audio: false, usdMicrosPerSecond: 70_000 }],
          },
          job: {
            cancel: "running",
            removal: { kind: "delete" },
            resumeWindowHours: 24,
          },
        },
        options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: false },
        canRemember: true,
      }),
    ]);
    renderPrompt(fake);
    const card = await screen.findByRole("article", { name: "Video generation request" });
    expect(card).toHaveTextContent("Make this video clip?");
    expect(card).toHaveTextContent("A paper boat on a pond");
    expect(card).toHaveTextContent("About $0.70 for 10 s at 720p, billed by Example.");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(fake.decide).toHaveBeenCalledExactlyOnceWith({
      offerId,
      decision: "video-generate",
      options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: false },
      rememberForThread: false,
    });
  });

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

  it("says the choice is kept for the thread alone on a thread outside a Project", async () => {
    renderPrompt(client([offer()]), "thread");
    expect(
      await screen.findByRole("checkbox", { name: "Don't ask again in this thread" }),
    ).not.toBeChecked();
    expect(
      screen.queryByRole("checkbox", { name: "Don't ask again in this Project" }),
    ).not.toBeInTheDocument();
  });

  it("offers the host's models when the window has no local profile list", async () => {
    const user = userEvent.setup();
    const fake: ServiceOfferClient = {
      offers: async () => ({ offers: [offer()], imageProfiles: profiles }),
      decide: vi.fn(async () => ({ kind: "offer-answered" as const })),
    };
    render(
      <ServiceOfferPrompt
        client={fake}
        keptIn="project"
        profiles={[]}
        scopeId={scopeId}
        threadKind="code-thread"
        turnActive={false}
      />,
    );
    await user.click(await screen.findByRole("combobox", { name: "Image model" }));
    await user.click(await screen.findByRole("option", { name: "Gemini · gemini-3-pro-image" }));
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(fake.decide).toHaveBeenCalledWith(
      expect.objectContaining({ profileInstanceId: gemini, modelId: "gemini-3-pro-image" }),
    );
  });

  it("discloses signed-in screenshots and offers only models that can use references", async () => {
    const user = userEvent.setup();
    const bfl = "cc000000-0000-4000-8000-000000000030";
    const fake = client([
      offer({
        references: [
          { kind: "browser-capture", label: "Browser screenshot of example.com", signedIn: true },
        ],
      }),
    ]);
    render(
      <ServiceOfferPrompt
        client={fake}
        keptIn="project"
        profiles={[...profiles, { ...profile(bfl, "BFL", ["flux-pro"]), driverKind: "bfl-image" }]}
        scopeId={scopeId}
        threadKind="code-thread"
        turnActive={false}
      />,
    );
    const card = await screen.findByRole("article", { name: "Image generation request" });
    expect(card).toHaveTextContent("These images will be sent to the selected image provider");
    expect(card).toHaveTextContent("Browser screenshot of example.com (signed-in page)");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Image model" }));
    const geminiOption = await screen.findByRole("option", { name: "Gemini · gemini-3-pro-image" });
    expect(screen.queryByRole("option", { name: "BFL · flux-pro" })).not.toBeInTheDocument();
    await user.click(geminiOption);
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(fake.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImagesConfirmed: true,
        rememberForThread: false,
      }),
    );
  });

  it("generates with the model the person picks and keeps it for the Project when they ask", async () => {
    const user = userEvent.setup();
    const fake = client([offer()]);
    renderPrompt(fake);
    await user.click(await screen.findByRole("combobox", { name: "Image model" }));
    await user.click(await screen.findByRole("option", { name: "Gemini · gemini-3-pro-image" }));
    await user.click(screen.getByRole("checkbox", { name: "Don't ask again in this Project" }));
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(fake.decide).toHaveBeenCalledExactlyOnceWith({
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
      expect(fake.decide).toHaveBeenCalledExactlyOnceWith({
        offerId,
        decision: "agent-draws",
      }),
    );
  });

  it("keeps the card and says why when the host refuses the chosen model", async () => {
    const user = userEvent.setup();
    renderPrompt(
      client([offer()], {
        kind: "offer-refused",
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

  it("asks to save an image under the path the agent named, and saves on one click", async () => {
    const user = userEvent.setup();
    const fake = client([
      {
        offerId,
        kind: "save",
        threadKind: "code-thread",
        scopeId,
        jobId: "cc000000-0000-4000-8000-000000000030",
        attachmentId: "cc000000-0000-4000-8000-000000000031",
        relativePath: "public/hero.png",
        requestedAt: "2026-11-07T10:00:00.000Z",
      } as ImageGenerationOffer,
    ]);
    renderPrompt(fake);
    const card = await screen.findByRole("article", { name: "Image save request" });
    expect(card).toHaveTextContent("public/hero.png");
    expect(card).toHaveTextContent("never replaced");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fake.decide).toHaveBeenCalledExactlyOnceWith({ offerId, decision: "save" }),
    );
  });

  it("names the directory and how many files an icon set writes", async () => {
    const fake = client([
      {
        offerId,
        kind: "save",
        threadKind: "code-thread",
        scopeId,
        jobId: "cc000000-0000-4000-8000-000000000030",
        attachmentId: "cc000000-0000-4000-8000-000000000031",
        relativePath: "App/Assets.xcassets",
        fileCount: 11,
        requestedAt: "2026-11-07T10:00:00.000Z",
      } as ImageGenerationOffer,
    ]);
    renderPrompt(fake);
    const card = await screen.findByRole("article", { name: "Icon set save request" });
    expect(card).toHaveTextContent("11 new files");
    expect(card).toHaveTextContent("App/Assets.xcassets");
    expect(card).toHaveTextContent("nothing is written");
  });
});
