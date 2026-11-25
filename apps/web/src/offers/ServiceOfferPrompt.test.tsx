import {
  createServiceOfferClient,
  type ServiceOfferClient,
} from "@octant/client-runtime/service-offer-client";
import {
  decodeNarrationOffer,
  decodeTranscriptionOffer,
  type ServiceOffer,
} from "@octant/contracts";
import type {
  ImageGenerationOffer,
  ServiceOfferDecisionResult,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
} from "@octant/contracts";
import { decodeVideoGenerateOffer } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

const narration = {
  kind: "narrate",
  threadKind: "code-thread",
  scopeId,
  offerId,
  requestedAt: "2026-11-07T10:00:00.000Z",
  excerpt: "Welcome to the product tour",
  characters: 27,
  relativePath: "narration/intro.mp3",
  voice: "nova",
  endpointName: "Studio",
  modelId: "tts-1",
  format: "mp3",
};
const recording = {
  kind: "transcribe",
  threadKind: "code-thread",
  scopeId,
  offerId,
  requestedAt: "2026-11-07T10:00:00.000Z",
  relativePath: "meetings/notes.m4a",
  sizeBytes: 2048,
  endpointName: "Studio",
  modelId: "speech-model",
};
const videoSave = {
  kind: "video-save",
  threadKind: "code-thread",
  scopeId,
  offerId,
  requestedAt: "2026-11-07T10:00:00.000Z",
  jobId: "cc000000-0000-4000-8000-000000000030",
  clipId: "cc000000-0000-4000-8000-000000000031",
  relativePath: "clips/tour.mp4",
  sizeBytes: 2_000_000,
};
const imageSave = {
  kind: "save",
  threadKind: "code-thread",
  scopeId,
  offerId,
  requestedAt: "2026-11-07T10:00:00.000Z",
  jobId: "cc000000-0000-4000-8000-000000000030",
  attachmentId: "cc000000-0000-4000-8000-000000000031",
  relativePath: "public/hero.png",
};
const videoGenerate = {
  offerId,
  kind: "video-generate",
  threadKind: "code-thread",
  scopeId,
  prompt: "A paper boat drifting across a pond",
  images: [],
  profileInstanceId: openAi,
  profileName: "Gemini Video",
  providerName: "Google",
  model: {
    modelId: "gemini-omni-1.2-flash",
    displayName: "Gemini Omni Flash",
    durations: { kind: "range", min: 3, max: 15 },
    resolutions: ["720p"],
    aspectRatios: [{ ratio: "16:9" }],
    audio: "always",
    inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 2 },
    price: { kind: "unpublished" },
    job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
  },
  options: { durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", audio: true },
  canRemember: true,
  requestedAt: "2026-11-07T10:00:00.000Z",
};

/** The host's own answer, read through the real client as a window reads it. */
function wireClient(offers: ReadonlyArray<unknown>) {
  const decided = vi.fn();
  const client = createServiceOfferClient({
    baseUrl: "http://127.0.0.1:4100",
    windowCapability: "capability",
    fetch: Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        if (init?.method !== "POST") return Response.json({ offers });
        decided(init.body);
        return Response.json({ kind: "offer-answered" });
      },
      { preconnect: () => undefined },
    ),
  });
  const listed = vi.spyOn(client, "offers");
  return { client, decided, listed };
}

// Cards load on demand; their modules are in memory so a test waits on the offer alone.
beforeAll(async () => {
  await Promise.all([
    import("../image/imageOfferCards"),
    import("../video/videoOfferCards"),
    import("./NarrationOfferCard"),
    import("./TranscriptionOfferCard"),
  ]);
});

describe("ServiceOfferPrompt", () => {
  it.each([
    ["generate", "Image generation request", { ...offer() }],
    ["save", "Image save request", imageSave],
    ["transcribe", "Transcription request", recording],
    ["narrate", "Narration request", narration],
    ["video-generate", "Video generation request", videoGenerate],
    ["video-save", "Video save request", videoSave],
  ])(
    "shows nothing to answer for a %s offer with a field it does not know, and shows the next one",
    async (_kind, name, payload) => {
      const unknown = wireClient([
        { ...payload, sendsTo: "somewhere-new" },
        { ...payload, offerId: "cc000000-0000-4000-8000-000000000021" },
      ]);
      renderPrompt(unknown.client);
      const card = await screen.findByRole("article", { name });
      expect(screen.getAllByRole("article")).toEqual([card]);
      const decline = screen.getByRole("button", {
        name: /^(Let the agent draw it|Don't (save|transcribe|narrate|make it))$/,
      });
      await userEvent.click(decline);
      expect(unknown.decided).toHaveBeenCalledOnce();
      expect(JSON.parse(String(unknown.decided.mock.calls[0]?.[0]))).toMatchObject({
        offerId: "cc000000-0000-4000-8000-000000000021",
      });
    },
  );

  it.each([
    [
      "an unknown field nested in its payload",
      { ...videoGenerate, model: { ...videoGenerate.model, sendsTo: "x" } },
    ],
    ["a kind this build does not know", { ...narration, kind: "hologram" }],
    ["a payload out of range", { ...recording, sizeBytes: -1 }],
  ])("shows no card and takes no answer for an offer with %s", async (_, payload) => {
    const { client, decided, listed } = wireClient([payload]);
    renderPrompt(client);
    await waitFor(() => expect(listed).toHaveBeenCalled());
    await expect(listed.mock.results[0]?.value).resolves.toMatchObject({
      offers: [{ scopeId, threadKind: "code-thread" }],
    });
    // The card's lazy chunk settles after the list does.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("region", { name: "Asked by the agent" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(decided).not.toHaveBeenCalled();
  });

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
  it("shows a video offer's price and submits the chosen options on Generate", async () => {
    const user = userEvent.setup();
    const videoOffer = decodeVideoGenerateOffer({
      offerId,
      kind: "video-generate",
      threadKind: "code-thread",
      scopeId,
      prompt: "A paper boat drifting across a pond",
      images: [],
      profileInstanceId: openAi,
      profileName: "Gemini Video",
      providerName: "Google",
      model: {
        modelId: "gemini-omni-1.2-flash",
        displayName: "Gemini Omni Flash",
        durations: { kind: "range", min: 3, max: 15 },
        resolutions: ["720p", "1080p"],
        aspectRatios: [{ ratio: "16:9" }],
        audio: "always",
        inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 2 },
        price: {
          kind: "per-token",
          outputTokensPerSecond: [
            { resolution: "720p", tokens: 5792 },
            { resolution: "1080p", tokens: 11_584 },
          ],
          outputUsdMicrosPerMillionTokens: 12_000_000,
        },
        job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
      },
      options: { durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", audio: true },
      canRemember: true,
      requestedAt: "2026-11-07T10:00:00.000Z",
    });
    const fake = client([videoOffer]);
    renderPrompt(fake);
    const card = await screen.findByRole("article", { name: "Video generation request" });
    expect(card).toHaveTextContent("Make this video clip?");
    expect(card).toHaveTextContent("About $0.56 for 8 s at 720p, billed by Google.");
    await user.click(screen.getByRole("combobox", { name: "Resolution" }));
    await user.click(await screen.findByRole("option", { name: "1080p" }));
    expect(card).toHaveTextContent("About $1.11 for 8 s at 1080p, billed by Google.");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(fake.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        offerId,
        decision: "video-generate",
        options: { durationSeconds: 8, resolution: "1080p", aspectRatio: "16:9", audio: true },
      }),
    );
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
