import { describe, expect, it, vi } from "vitest";
import type { ChatThread, CodeThread, ToolActionAuthority, WorkThread } from "@octant/contracts";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { createNativeHarnessAuthority } from "./nativeHarnessAuthority";
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

  describe("a brand-new thread's first web fetch", () => {
    const providerInstanceId = "00000000-0000-4000-8000-0000000000e1";
    const workProjectId = "00000000-0000-4000-8000-0000000000b1";
    const chatProjectId = "00000000-0000-4000-8000-0000000000b2";
    const revisionId = "00000000-0000-4000-8000-0000000000c1";
    const chatThread = (projectId?: string) =>
      ({
        id:
          projectId === undefined
            ? "00000000-0000-4000-8000-000000000011"
            : "00000000-0000-4000-8000-000000000013",
        lifecycle: "active",
        providerInstanceId,
        modelId: "harness-model",
        researchEnabled: true,
        ...(projectId === undefined ? {} : { projectId }),
      }) as unknown as ChatThread;
    const workThread = {
      id: "00000000-0000-4000-8000-000000000012",
      lifecycle: "active",
      projectId: workProjectId,
      providerInstanceId,
      modelId: "harness-model",
      bindingRevisionId: revisionId,
    } as unknown as WorkThread;

    const harness = (options: { readonly threadLifecycle?: "active" | "archived" } = {}) => {
      const lifecycle = options.threadLifecycle ?? "active";
      const webFetch = vi.fn(async (input: { readonly url: string }) => ({
        status: 200,
        contentType: "text/plain",
        text: "Sunny in Stavanger.",
        truncated: false,
        finalUrl: input.url,
      }));
      const composition = createNativeHarnessComposition({
        isChildAuthorityCurrent: () => true,
        authority: createNativeHarnessAuthority({
          hostId: "00000000-0000-4000-8000-0000000000aa" as never,
          persistence: {
            readChatThread: (id) =>
              [chatThread(), chatThread(chatProjectId)]
                .map((thread) => ({ ...thread, lifecycle }))
                .find((thread) => String(thread.id) === String(id)) as never,
            readProject: (id) =>
              String(id) === workProjectId
                ? ({
                    type: "work",
                    lifecycle: "active",
                    bindingHistory: [{ revisionId }],
                  } as never)
                : undefined,
            readCodeThread: () => undefined,
            readProviderInstance: () => ({ enabled: true }) as never,
          },
          workThreads: {
            read: (id) =>
              String(id) === String(workThread.id)
                ? ({ ...workThread, lifecycle } as never)
                : undefined,
          },
          readThreadTaint: () => ({ externalContentIngested: false }) as never,
        }),
        isHarnessProvider: () => true,
        webFetch,
        hostId: "00000000-0000-4000-8000-0000000000aa" as never,
        readThreadTaint: () => false,
        recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
        uuid: () => "00000000-0000-4000-8000-000000000099",
        clock: () => "2026-10-06T00:00:00.000Z",
      });
      return { composition, webFetch };
    };
    const fetchYr = (tools: ReturnType<ReturnType<typeof harness>["composition"]["forChat"]>) =>
      tools?.execute({
        name: "web-fetch",
        inputJson: JSON.stringify({ url: "https://www.yr.no/" }),
      });

    it.each([
      ["a Chat thread with no Project", undefined],
      ["a Chat thread in a Project", chatProjectId],
    ])("fetches a page from %s", async (_label, projectId) => {
      const { composition, webFetch } = harness();
      const tools = composition.forChat({ thread: chatThread(projectId), windowId: "window-1" });
      expect(await fetchYr(tools)).toMatchObject({
        isError: false,
        result: { status: 200, text: expect.stringContaining("Sunny in Stavanger.") },
      });
      expect(webFetch).toHaveBeenCalledOnce();
    });

    it("offers and runs web-fetch in a Chat thread only while its research is on", async () => {
      const { composition, webFetch } = harness();
      const researchOff = composition.forChat({
        thread: { ...chatThread(), researchEnabled: false },
        windowId: "window-1",
      });
      expect(researchOff?.definitions.map((definition) => definition.name)).not.toContain(
        "web-fetch",
      );
      expect(await fetchYr(researchOff)).toMatchObject({
        isError: true,
        result: { error: "tool-unavailable" },
      });
      expect(webFetch).not.toHaveBeenCalled();

      const researchOn = composition.forChat({ thread: chatThread(), windowId: "window-1" });
      expect(researchOn?.definitions.map((definition) => definition.name)).toContain("web-fetch");
      expect(await fetchYr(researchOn)).toMatchObject({ isError: false });
      expect(webFetch).toHaveBeenCalledOnce();
    });

    it("fetches a page from a Work thread in a folder", async () => {
      const { composition, webFetch } = harness();
      const tools = composition.forWork({
        thread: workThread,
        projectRoot: "/nonexistent",
        windowId: "window-1",
      });
      expect(await fetchYr(tools)).toMatchObject({
        isError: false,
        result: { status: 200, text: expect.stringContaining("Sunny in Stavanger.") },
      });
      expect(webFetch).toHaveBeenCalledOnce();
    });

    it("refuses with a reason a person can read once the thread is archived", async () => {
      const { composition, webFetch } = harness({ threadLifecycle: "archived" });
      const chat = await fetchYr(
        composition.forChat({ thread: chatThread(), windowId: "window-1" }),
      );
      const work = await fetchYr(
        composition.forWork({ thread: workThread, projectRoot: "/nonexistent", windowId: "w" }),
      );
      for (const outcome of [chat, work]) {
        expect(outcome).toMatchObject({
          isError: true,
          result: { error: "tool-authority-stale", message: expect.stringMatching(/thread/i) },
        });
      }
      expect(webFetch).not.toHaveBeenCalled();
    });
  });

  it.each([
    { source: "runtime-reported", answers: true },
    { source: "conservative-fallback", answers: false },
  ] as const)(
    "tells the lead its remaining room only when the model's window is known (%s)",
    async ({ source, answers }) => {
      const composition = createNativeHarnessComposition({
        isChildAuthorityCurrent: () => true,
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
        isHarnessProvider: () => true,
        contextHarness: {
          inspect: () =>
            ({
              snapshotAt: "2026-10-06T00:00:00.000Z",
              modelLimits: { source, confidence: source === "runtime-reported" ? "high" : "low" },
              next: { plan: { plannedInputTokens: 4_800, safeInputBudget: 100_000 } },
            }) as never,
        },
        hostId: authority.hostId,
        readThreadTaint: () => false,
        recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
        uuid: () => "00000000-0000-4000-8000-000000000099",
        clock: () => "2026-10-06T00:00:00.000Z",
      });
      const tools = composition.forChat({
        thread: { ...thread, researchEnabled: false } as never,
        windowId: "window-1",
      });
      const result = await tools?.execute({
        name: "context-remaining",
        inputJson: "{}",
        signal: new AbortController().signal,
      });
      // An estimate would tell the lead to wrap up long before the model needs it to.
      expect(result?.result).toEqual(
        answers
          ? expect.objectContaining({ remainingTokens: 95_200, source: "capacity-planner" })
          : { error: "context-unavailable" },
      );
    },
  );
});
