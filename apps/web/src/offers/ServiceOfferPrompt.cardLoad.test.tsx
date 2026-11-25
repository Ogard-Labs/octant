import type { ServiceOfferClient } from "@octant/client-runtime/service-offer-client";
import {
  decodeImageGenerationOffer,
  decodeNarrationOffer,
  decodeTranscriptionOffer,
  type ImageGenerationScopeId,
} from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceOfferPrompt } from "./ServiceOfferPrompt";

/**
 * How many of a card's next loads fail, as a chunk missing after a host
 * update would, and how many were tried. Each test fails a different kind's
 * card, so each starts from a card the window has never loaded, whatever ran
 * before it, and no module is rebuilt between tests.
 */
const loads = vi.hoisted(() => ({
  transcription: { failing: 0, attempts: 0 },
  narration: { failing: 0, attempts: 0 },
}));
vi.mock("./TranscriptionOfferCard", async (actual) => {
  loads.transcription.attempts += 1;
  if (loads.transcription.failing > 0) {
    loads.transcription.failing -= 1;
    throw new Error("chunk is gone");
  }
  return actual();
});
vi.mock("./NarrationOfferCard", async (actual) => {
  loads.narration.attempts += 1;
  if (loads.narration.failing > 0) {
    loads.narration.failing -= 1;
    throw new Error("chunk is gone");
  }
  return actual();
});

// The card that does load is in memory, so a test waits on the offer alone.
beforeAll(async () => {
  await import("../image/imageOfferCards");
}, 60_000);

beforeEach(() => {
  for (const card of [loads.transcription, loads.narration]) {
    card.failing = 0;
    card.attempts = 0;
  }
});

const scopeId = "cc000000-0000-4000-8000-000000000001" as ImageGenerationScopeId;
const otherScope = "cc000000-0000-4000-8000-000000000002" as ImageGenerationScopeId;
const requestedAt = "2026-11-07T10:00:00.000Z";

const transcription = decodeTranscriptionOffer({
  kind: "transcribe",
  threadKind: "code-thread",
  scopeId,
  offerId: "cc000000-0000-4000-8000-000000000021",
  requestedAt,
  relativePath: "meetings/notes.m4a",
  sizeBytes: 2048,
  endpointName: "Studio",
  modelId: "speech-model",
});

function narration(scope: ImageGenerationScopeId) {
  return decodeNarrationOffer({
    kind: "narrate",
    threadKind: "code-thread",
    scopeId: scope,
    offerId: "cc000000-0000-4000-8000-000000000023",
    requestedAt,
    excerpt: "Welcome",
    characters: 7,
    relativePath: "narration/intro.mp3",
    voice: "nova",
    endpointName: "Studio",
    modelId: "tts-1",
    format: "mp3",
  });
}

function image(scope: ImageGenerationScopeId) {
  return decodeImageGenerationOffer({
    offerId: "cc000000-0000-4000-8000-000000000022",
    kind: "generate",
    threadKind: "code-thread",
    scopeId: scope,
    prompt: "A lighthouse at dusk",
    variantCount: 1,
    revision: false,
    suggested: {
      profileInstanceId: "cc000000-0000-4000-8000-000000000010",
      modelId: "gpt-image-2",
    },
    requestedAt,
  });
}

function prompt(client: ServiceOfferClient, scope: ImageGenerationScopeId) {
  return (
    <ServiceOfferPrompt
      client={client}
      keptIn="project"
      profiles={[]}
      scopeId={scope}
      threadKind="code-thread"
      turnActive={false}
    />
  );
}

describe("ServiceOfferPrompt when a card cannot load", () => {
  it("sets the offer aside on that one load and asks the thread's next one", async () => {
    loads.transcription.failing = 1;
    const client: ServiceOfferClient = {
      offers: vi.fn(async () => ({ offers: [transcription, image(scopeId)] })),
      decide: vi.fn(async () => ({ kind: "offer-answered" as const })),
    };
    render(prompt(client, scopeId));
    expect(await screen.findByRole("article", { name: "Image generation request" })).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(loads.transcription.attempts).toBe(1);
  });

  it("tries a card that failed to load again in the next thread the person opens", async () => {
    loads.narration.failing = 1;
    const client: ServiceOfferClient = {
      offers: vi.fn(async ({ scopeId: scope }) => ({
        offers: scope === scopeId ? [narration(scope), image(scope)] : [narration(scope)],
      })),
      decide: vi.fn(async () => ({ kind: "offer-answered" as const })),
    };
    const view = render(prompt(client, scopeId));
    // Settled: the narration offer was set aside and the thread's next one asked.
    expect(await screen.findByRole("article", { name: "Image generation request" })).toBeVisible();
    expect(loads.narration.attempts).toBe(1);

    view.rerender(prompt(client, otherScope));
    expect(await screen.findByRole("article", { name: "Narration request" })).toBeVisible();
    expect(loads.narration.attempts).toBe(2);
  });
});
