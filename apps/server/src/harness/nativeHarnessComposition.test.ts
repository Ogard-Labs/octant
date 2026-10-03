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
  it.each([true, false])(
    "offers child questions through either harness and refuses tools after authority is revoked (%s)",
    async (isHarness) => {
      let authorized = true;
      const ask = vi.fn(async () => ({
        status: "answered" as const,
        answer: "Use the existing design",
      }));
      const composition = createNativeHarnessComposition({
        isChildAuthorityCurrent: () => authorized,
        authority: {
          resolve: () => authority,
          service: new ToolCallAuthorityService({
            resolveGrantedAuthority: () => authority,
            resolveLiveFacts: () => ({
              providerAppManagedTools: "supported",
              host: { computerUseEnabled: false },
              executionPolicy: "plan",
              approvalSatisfied: false,
              externalContentIngested: false,
            }),
          }),
        },
        isHarnessProvider: () => isHarness,
        childInteractions: () => ({ askUser: ask }),
        hostId: authority.hostId,
        readThreadTaint: () => false,
        recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
        uuid: () => "00000000-0000-4000-8000-000000000099",
        clock: () => "2026-10-03T00:00:00.000Z",
      });
      const tools = composition.forAgentRun({
        run: {
          id: thread.id,
          parentThreadId: "parent",
          routingReceipt: { mode: "chat", selectedProviderInstanceId: thread.providerInstanceId },
          workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
        } as never,
        authority: {
          filesystem: false,
          shell: false,
          git: false,
          network: false,
          tools: true,
          subagents: false,
          executionPolicy: "plan",
          permissionPersistence: "current-session",
        },
        projectRoot: "/unused",
      });
      expect(tools?.definitions.map((tool) => tool.name)).toEqual(["ask-user"]);
      expect(
        await tools?.execute({
          name: "ask-user",
          inputJson: JSON.stringify({ prompt: "Which design?", options: [] }),
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ result: { answer: "Use the existing design" } });
      expect(ask).toHaveBeenCalledOnce();
      authorized = false;
      expect(
        await tools?.execute({
          name: "ask-user",
          inputJson: JSON.stringify({ prompt: "Too late?", options: [] }),
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ isError: true });
      expect(ask).toHaveBeenCalledOnce();
    },
  );

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
      isChildAuthorityCurrent: () => true,
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
