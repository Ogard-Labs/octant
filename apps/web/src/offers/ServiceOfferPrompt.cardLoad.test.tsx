import type { ServiceOfferClient } from "@octant/client-runtime/service-offer-client";
import {
  decodeImageGenerationOffer,
  decodeNarrationOffer,
  type ImageGenerationScopeId,
} from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ServiceOfferPrompt } from "./ServiceOfferPrompt";

/**
 * How many of the next narration card loads fail, as a chunk missing after a
 * host update would. Its own file, so the card's module and the cards loaded
 * beside it stay cached for the window instead of being rebuilt per test.
 */
const narrationLoads = vi.hoisted(() => ({ failing: 0, attempts: 0 }));
vi.mock("./NarrationOfferCard", async (actual) => {
  narrationLoads.attempts += 1;
  if (narrationLoads.failing > 0) {
    narrationLoads.failing -= 1;
    throw new Error("chunk is gone");
  }
  return actual();
});

// The cards that do load are in memory, so a test waits on the offer alone.
beforeAll(async () => {
  await import("../image/imageOfferCards");
}, 60_000);

const scopeId = "cc000000-0000-4000-8000-000000000001" as ImageGenerationScopeId;
const otherScope = "cc000000-0000-4000-8000-000000000002" as ImageGenerationScopeId;
const offerId = "cc000000-0000-4000-8000-000000000020";
const profileId = "cc000000-0000-4000-8000-000000000010";

function narration(scope: ImageGenerationScopeId) {
  return decodeNarrationOffer({
    kind: "narrate",
    threadKind: "code-thread",
    scopeId: scope,
    offerId,
    requestedAt: "2026-11-07T10:00:00.000Z",
    excerpt: "Welcome",
    characters: 7,
    relativePath: "narration/intro.mp3",
    voice: "nova",
    endpointName: "Studio",
    modelId: "tts-1",
    format: "mp3",
  });
}

const image = decodeImageGenerationOffer({
  offerId: "cc000000-0000-4000-8000-000000000022",
  kind: "generate",
  threadKind: "code-thread",
  scopeId,
  prompt: "A lighthouse at dusk",
  variantCount: 1,
  revision: false,
  suggested: { profileInstanceId: profileId, modelId: "gpt-image-2" },
  requestedAt: "2026-11-07T10:00:00.000Z",
});

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
    narrationLoads.failing = 1;
    const before = narrationLoads.attempts;
    const client: ServiceOfferClient = {
      offers: vi.fn(async () => ({ offers: [narration(scopeId), image] })),
      decide: vi.fn(async () => ({ kind: "offer-answered" as const })),
    };
    render(prompt(client, scopeId));
    expect(await screen.findByRole("article", { name: "Image generation request" })).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(narrationLoads.attempts - before).toBe(1);
  });

  it("tries a card that failed to load again in the next thread the person opens", async () => {
    narrationLoads.failing = 1;
    const before = narrationLoads.attempts;
    const client: ServiceOfferClient = {
      offers: vi.fn(async ({ scopeId: scope }) => ({ offers: [narration(scope)] })),
      decide: vi.fn(async () => ({ kind: "offer-answered" as const })),
    };
    const view = render(prompt(client, scopeId));
    await waitFor(() => expect(narrationLoads.attempts - before).toBe(1));
    await waitFor(() => expect(client.offers).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("article")).toBeNull();

    view.rerender(prompt(client, otherScope));
    expect(await screen.findByRole("article", { name: "Narration request" })).toBeVisible();
    expect(narrationLoads.attempts - before).toBe(2);
  });
});
