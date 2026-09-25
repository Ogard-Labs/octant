import { describe, expect, it, vi } from "vitest";
import type { CodeThread, ToolActionAuthority } from "@octant/contracts";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { createNativeHarnessComposition } from "./nativeHarnessComposition";
import { searxngHarnessWebSearch } from "./nativeHarnessWebSearch";

const authority = {
  hostId: "00000000-0000-4000-8000-0000000000aa",
  mode: "code",
  projectId: "00000000-0000-4000-8000-0000000000bb",
  rootId: "00000000-0000-4000-8000-0000000000cc",
  worktreeId: "00000000-0000-4000-8000-0000000000dd",
  providerInstanceId: "00000000-0000-4000-8000-0000000000ee",
  extension: { kind: "core" },
} as unknown as ToolActionAuthority;

const thread = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: authority.projectId,
  providerInstanceId: authority.providerInstanceId,
  modelId: "harness-model",
} as unknown as CodeThread;

describe("native harness composition", () => {
  it("offers web search on the next turn after SearXNG is set and follows a changed endpoint", async () => {
    let searxngBaseUrl: string | undefined;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            results: [{ title: "Octant", url: "https://example.com/octant", content: "Found." }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const composition = createNativeHarnessComposition({
      authority: {
        resolve: () => authority,
        service: new ToolCallAuthorityService({
          resolveGrantedAuthority: () => authority,
          resolveLiveFacts: () => ({
            providerAppManagedTools: "supported",
            host: { computerUseEnabled: false },
            executionPolicy: "full-access",
            approvalSatisfied: true,
            externalContentIngested: false,
          }),
        }),
      },
      isHarnessProvider: () => true,
      resolveWebSearch: () => searxngHarnessWebSearch({ readBaseUrl: () => searxngBaseUrl, fetch }),
      hostId: authority.hostId,
      readThreadTaint: () => false,
      recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
      uuid: () => "00000000-0000-4000-8000-000000000099",
      clock: () => "2026-09-25T00:00:00.000Z",
    });
    const nextTurn = () =>
      composition.forCode({ thread, checkoutRoot: "/nonexistent", windowId: "window-1" });
    const search = () =>
      nextTurn()?.execute({
        name: "web-search",
        inputJson: JSON.stringify({ query: "octant" }),
      });

    const unset = nextTurn()?.definitions.map((definition) => definition.name);
    expect(unset).not.toContain("web-search");

    searxngBaseUrl = "https://search.example.test";
    expect(nextTurn()?.definitions.map((definition) => definition.name)).toContain("web-search");
    expect(await search()).toMatchObject({
      result: { query: "octant", results: [{ url: "https://example.com/octant" }] },
    });
    expect(String(fetch.mock.calls.at(-1)?.[0])).toMatch(/^https:\/\/search\.example\.test\//);

    searxngBaseUrl = "https://other.example.test";
    await search();
    expect(String(fetch.mock.calls.at(-1)?.[0])).toMatch(/^https:\/\/other\.example\.test\//);

    searxngBaseUrl = undefined;
    expect(nextTurn()?.definitions.map((definition) => definition.name)).not.toContain(
      "web-search",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
