import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_REVIEWED_MODEL_MANIFEST,
  refreshReviewedModelManifest,
  ReviewedModelManifest,
} from "./reviewedModelManifest";

const commit = "a".repeat(40);

function remote(responses: (url: string) => Response): {
  readonly fetch: typeof globalThis.fetch;
  readonly urls: ReadonlyArray<string>;
} {
  const urls: string[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return Promise.resolve(responses(url));
  });
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, urls };
}

function manifestBody(models: unknown): Response {
  return new Response(JSON.stringify({ models }), { status: 200 });
}

describe("reviewed model manifest refresh", () => {
  it("reads the manifest at the commit the canonical branch points to", async () => {
    const source = remote((url) =>
      url.startsWith("https://api.github.com")
        ? new Response(commit, { status: 200 })
        : manifestBody([
            { modelId: "octant-large", contextWindow: 200_000, maxOutput: 8_192 },
            {
              modelId: "octant-small",
              contextWindow: 32_000,
              maxOutput: 4_096,
              reasoning: "separate",
            },
          ]),
    );
    const refresh = await refreshReviewedModelManifest({
      reference: CANONICAL_REVIEWED_MODEL_MANIFEST,
      fetch: source.fetch,
    });
    expect(refresh).toEqual({
      status: "refreshed",
      commit,
      models: [
        { modelId: "octant-large", contextWindow: 200_000, maxOutput: 8_192, reasoning: "unknown" },
        { modelId: "octant-small", contextWindow: 32_000, maxOutput: 4_096, reasoning: "separate" },
      ],
    });
    expect(source.urls[1]).toContain(`/${commit}/docs/reviewed-model-manifest.json`);
  });

  it("does not re-read the manifest while the branch stays on the known commit", async () => {
    const source = remote(() => new Response(commit, { status: 200 }));
    const refresh = await refreshReviewedModelManifest({
      reference: CANONICAL_REVIEWED_MODEL_MANIFEST,
      knownCommit: commit,
      fetch: source.fetch,
    });
    expect(refresh).toEqual({ status: "unchanged", commit });
    expect(source.urls).toHaveLength(1);
  });

  it("refuses a manifest the canonical remote cannot serve", async () => {
    const source = remote(() => new Response("not found", { status: 404 }));
    expect(
      await refreshReviewedModelManifest({
        reference: CANONICAL_REVIEWED_MODEL_MANIFEST,
        fetch: source.fetch,
      }),
    ).toEqual({ status: "refuses", reason: "unavailable" });
  });

  it("refuses a refresh when the host cannot reach the canonical remote", async () => {
    const refresh = await refreshReviewedModelManifest({
      reference: CANONICAL_REVIEWED_MODEL_MANIFEST,
      fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof globalThis.fetch,
    });
    expect(refresh).toEqual({ status: "refuses", reason: "unavailable" });
  });

  it("refuses a mutable ref that does not resolve to a commit", async () => {
    const source = remote(() => new Response("main", { status: 200 }));
    expect(
      await refreshReviewedModelManifest({
        reference: CANONICAL_REVIEWED_MODEL_MANIFEST,
        fetch: source.fetch,
      }),
    ).toEqual({ status: "refuses", reason: "unreadable" });
  });

  it.each([
    ["malformed JSON", new Response("{", { status: 200 })],
    ["a missing model list", new Response(JSON.stringify({}), { status: 200 })],
    ["a model without limits", manifestBody([{ modelId: "octant-large" }])],
    [
      "a max output larger than the context window",
      manifestBody([{ modelId: "octant-large", contextWindow: 1_000, maxOutput: 2_000 }]),
    ],
    [
      "the same model twice",
      manifestBody([
        { modelId: "octant-large", contextWindow: 1_000, maxOutput: 100 },
        { modelId: "octant-large", contextWindow: 2_000, maxOutput: 100 },
      ]),
    ],
  ])("refuses a manifest with %s", async (_case, body) => {
    const source = remote((url) =>
      url.startsWith("https://api.github.com") ? new Response(commit, { status: 200 }) : body,
    );
    expect(
      await refreshReviewedModelManifest({
        reference: CANONICAL_REVIEWED_MODEL_MANIFEST,
        fetch: source.fetch,
      }),
    ).toEqual({ status: "refuses", reason: "unreadable" });
  });
});

describe("reviewed model manifest", () => {
  it("knows nothing until a refresh is accepted and keeps its entries when one is refused", () => {
    const manifest = new ReviewedModelManifest();
    expect(manifest.commit()).toBeUndefined();
    expect(manifest.entry("octant-large")).toBeUndefined();

    manifest.accept({
      status: "refreshed",
      commit,
      models: [
        {
          modelId: "octant-large",
          contextWindow: 200_000,
          maxOutput: 8_192,
          reasoning: "included",
        },
      ],
    });
    expect(manifest.commit()).toBe(commit);
    expect(manifest.entry("octant-large")?.contextWindow).toBe(200_000);

    manifest.accept({ status: "refuses", reason: "unavailable" });
    expect(manifest.commit()).toBe(commit);
    expect(manifest.entry("octant-large")?.contextWindow).toBe(200_000);
  });
});
