import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatThread,
  CodeThread,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  WorkThread,
} from "@octant/contracts";
import { childAgentTools } from "../chat/sideChatDelegation";
import { combineAppManagedToolSets, type AppManagedToolSet } from "../providers/appManagedToolSet";
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
  describe("the advice tools", () => {
    const providerInstanceId = "00000000-0000-4000-8000-0000000000e2";
    const projectId = "00000000-0000-4000-8000-0000000000b3";
    const chatThread = {
      id: "00000000-0000-4000-8000-000000000021",
      providerInstanceId,
      modelId: "harness-model",
      researchEnabled: false,
    } as unknown as ChatThread;
    const workThread = {
      id: "00000000-0000-4000-8000-000000000022",
      projectId,
      providerInstanceId,
      modelId: "harness-model",
    } as unknown as WorkThread;
    const codeThread = {
      id: "00000000-0000-4000-8000-000000000023",
      projectId,
      providerInstanceId,
      modelId: "harness-model",
    } as unknown as CodeThread;

    const harness = (tainted = false, extraPorts: Record<string, unknown> = {}) => {
      const asked: Array<{ readonly threadId: string; readonly mode: string }> = [];
      const inspected: Array<unknown> = [];
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
        tasks: { replaceTasks: (async () => undefined) as never },
        ...(extraPorts as object),
        shell: { run: async () => ({ status: "unavailable", output: "", truncated: false }) },
        contextHarness: {
          inspect: (subject) => {
            inspected.push(subject);
            return {
              snapshotAt: "2026-10-16T00:00:00.000Z",
              modelLimits: { source: "runtime-reported", confidence: "high" },
              next: { plan: { plannedInputTokens: 4_800, safeInputBudget: 100_000 } },
            } as never;
          },
        },
        secondOpinion: (scope) => async (input) => {
          asked.push({ threadId: scope.threadId, mode: scope.mode });
          return `advice on ${input.question}`;
        },
        hostId: authority.hostId,
        readThreadTaint: () => tainted,
        recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
        uuid: () => "00000000-0000-4000-8000-000000000099",
        clock: () => "2026-10-16T00:00:00.000Z",
      });
      return { composition, asked, inspected };
    };
    const names = (tools: { readonly definitions: ReadonlyArray<{ readonly name: string }> }) =>
      tools.definitions.map((definition) => definition.name);

    // The offered tool set per mode is the first item of the Harness parity checklist in
    // docs/architecture.md; changing it means changing that checklist with it.
    it("offers the task list, context-remaining and second-opinion in Chat without any file or shell reach", () => {
      const tools = harness().composition.forChat({ thread: chatThread, windowId: "window-1" });
      expect(names(tools!)).toEqual(["todo-write", "context-remaining", "second-opinion"]);
    });

    it("offers the task list, context-remaining and second-opinion in Work beside its folder tools", () => {
      const tools = harness().composition.forWork({
        thread: workThread,
        projectRoot: "/nonexistent",
        windowId: "window-1",
      });
      expect(names(tools!)).toEqual([
        "read",
        "grep",
        "glob",
        "edit",
        "write",
        "todo-write",
        "context-remaining",
        "second-opinion",
      ]);
    });

    it("offers the task list, context-remaining and second-opinion in Code beside its checkout tools", () => {
      const tools = harness().composition.forCode({
        thread: codeThread,
        checkoutRoot: "/nonexistent",
        windowId: "window-1",
      });
      expect(names(tools!)).toEqual([
        "read",
        "grep",
        "glob",
        "bash",
        "edit",
        "write",
        "todo-write",
        "context-remaining",
        "second-opinion",
      ]);
    });

    // Ports server.ts also supplies; each one gates a tool the user guide promises.
    const productionPorts = {
      goals: { read: async () => undefined, execute: async () => undefined } as never,
      questions: { ask: async () => undefined } as never,
      delegate: () => ({}) as never,
      webFetch: (async () => undefined) as never,
      resolveWebSearch: () => (async () => undefined) as never,
    };

    it("offers the full conditional matrix per mode when every production port is supplied", () => {
      const { composition } = harness(false, productionPorts);
      const chat = names(composition.forChat({ thread: chatThread, windowId: "window-1" })!);
      const work = names(
        composition.forWork({
          thread: workThread,
          projectRoot: "/nonexistent",
          windowId: "window-1",
        })!,
      );
      const code = names(
        composition.forCode({
          thread: codeThread,
          checkoutRoot: "/nonexistent",
          windowId: "window-1",
        })!,
      );
      // Chat's web tools wait on its research grant, so they are absent here by design.
      const lead = [
        "todo-write",
        "context-remaining",
        "second-opinion",
        "delegate",
        "ask-user",
        "goal",
      ];
      const web = ["web-fetch", "web-search"];
      expect({ chat, work, code }).toEqual({
        chat: lead,
        work: ["read", "grep", "glob", "edit", "write", ...web, ...lead],
        code: ["read", "grep", "glob", "bash", "edit", "write", ...web, ...lead, "goal-check"],
      });
    });

    // Plan is read-only, so its lead is offered only what Plan lets through. Every other
    // posture keeps the full Code set; the matrix is the second half of the parity checklist's
    // first item in docs/architecture.md.
    it.each([
      ["approval-gated", true],
      ["auto-accept-edits", true],
      ["full-access", true],
      ["plan", false],
    ] as const)(
      "offers a Code thread under %s the writing and shell tools only when it can use them",
      (executionPolicy, writes) => {
        const { composition } = harness(false, productionPorts);
        const code = names(
          composition.forCode({
            thread: { ...codeThread, executionPolicy } as CodeThread,
            checkoutRoot: "/nonexistent",
            windowId: "window-1",
          })!,
        );
        const readOnly = ["read", "grep", "glob"];
        const web = ["web-fetch", "web-search"];
        const lead = [
          "todo-write",
          "context-remaining",
          "second-opinion",
          "delegate",
          "ask-user",
          "goal",
        ];
        expect(code).toEqual(
          writes
            ? [...readOnly, "bash", "edit", "write", ...web, ...lead, "goal-check"]
            : [...readOnly, ...web, ...lead],
        );
      },
    );

    it("offers only the Plan tools to a turn narrowed to Plan on a thread that is not", () => {
      const { composition } = harness(false, {
        ...productionPorts,
        readCodeExecutionPolicy: () => "plan",
      });
      const code = names(
        composition.forCode({
          thread: { ...codeThread, executionPolicy: "approval-gated" } as CodeThread,
          checkoutRoot: "/nonexistent",
          windowId: "window-1",
        })!,
      );
      for (const refused of ["bash", "edit", "write", "goal-check"]) {
        expect(code).not.toContain(refused);
      }
      expect(code).toContain("read");
    });

    it("keeps web-fetch available to a Plan thread because Plan's rule does not refuse it", async () => {
      const { composition } = harness(false, {
        ...productionPorts,
        webFetch: async () => ({
          status: 200,
          text: "page",
          truncated: false,
          finalUrl: "https://example.com/",
        }),
      });
      const tools = composition.forCode({
        thread: { ...codeThread, executionPolicy: "plan" } as CodeThread,
        checkoutRoot: "/nonexistent",
        windowId: "window-1",
      })!;
      expect(names(tools)).toContain("web-fetch");
      expect(
        await tools.execute({
          name: "web-fetch",
          inputJson: JSON.stringify({ url: "https://example.com/" }),
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ isError: false });
    });

    it("still refuses a write with the policy's own reason when the posture narrowed to Plan after the tools were composed", async () => {
      // The authority service here reads Plan, as it does once a thread is moved to Plan
      // mid-turn; the tool set was composed while the thread could still write.
      const { composition } = harness(false, productionPorts);
      const tools = composition.forCode({
        thread: { ...codeThread, executionPolicy: "approval-gated" } as CodeThread,
        checkoutRoot: "/nonexistent",
        windowId: "window-1",
      })!;
      expect(names(tools)).toContain("write");
      expect(
        await tools.execute({
          name: "write",
          inputJson: JSON.stringify({ path: "a.ts", content: "x" }),
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ isError: true, result: { error: "plan-mode-denied" } });
    });

    it("offers a Side Chat only the advice tools and the web, never a task list, goal, question or delegation", () => {
      const { composition } = harness(false, productionPorts);
      const sideChat = composition.forChat({
        thread: { ...chatThread, researchEnabled: true } as ChatThread,
        windowId: "window-1",
        sideChat: true,
      });
      expect(names(sideChat!)).toEqual([
        "web-fetch",
        "web-search",
        "context-remaining",
        "second-opinion",
      ]);
    });

    it("gives a Side Chat no delegation in the tool set it finally receives", () => {
      const { composition } = harness(false, productionPorts);
      const agents = (): AppManagedToolSet => ({
        definitions: [{ name: "octant_agents" } as never],
        execute: async () => ({ result: {} }),
      });
      const finalSet = (sideChat: boolean) =>
        combineAppManagedToolSets(
          composition.forChat({ thread: chatThread, windowId: "window-1", sideChat }),
          childAgentTools({ sideChat, tools: agents }),
        );
      expect(names(finalSet(true))).not.toContain("delegate");
      expect(names(finalSet(true))).not.toContain("octant_agents");
      // An ordinary Chat thread keeps both.
      expect(names(finalSet(false))).toEqual(expect.arrayContaining(["delegate", "octant_agents"]));
    });

    it("keeps the composition call site supplying every port the offered set depends on", () => {
      // The call site moves between files as wiring is extracted, so find it.
      const root = fileURLToPath(new URL("..", import.meta.url));
      const callers = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
        .filter((file) =>
          readFileSync(`${root}/${file}`, "utf8").includes("createNativeHarnessComposition({"),
        );
      expect(callers, "exactly one file must call createNativeHarnessComposition({").toHaveLength(
        1,
      );
      const source = readFileSync(`${root}/${callers[0]}`, "utf8");
      const start = source.indexOf("createNativeHarnessComposition({");
      const block = source.slice(start, start + 9000);
      for (const port of [
        "tasks:",
        "goals:",
        "questions:",
        "secondOpinion:",
        "delegate:",
        "shell:",
        "resolveWebSearch:",
        "webFetch:",
        "contextHarness",
      ]) {
        expect(block, port).toContain(port);
      }
    });

    it.each([
      ["chat", "chat-thread"],
      ["work", "work-thread"],
      ["code", "code-thread"],
    ] as const)(
      "answers both tools from the %s thread's own state",
      async (mode, aggregateType) => {
        const { composition, asked, inspected } = harness();
        const tools =
          mode === "chat"
            ? composition.forChat({ thread: chatThread, windowId: "window-1" })
            : mode === "work"
              ? composition.forWork({
                  thread: workThread,
                  projectRoot: "/nonexistent",
                  windowId: "window-1",
                })
              : composition.forCode({
                  thread: codeThread,
                  checkoutRoot: "/nonexistent",
                  windowId: "window-1",
                });
        const signal = new AbortController().signal;
        expect(
          await tools?.execute({ name: "context-remaining", inputJson: "{}", signal }),
        ).toMatchObject({ isError: false, result: { remainingTokens: 95_200 } });
        expect(inspected).toEqual([expect.objectContaining({ aggregateType })]);
        expect(
          await tools?.execute({
            name: "second-opinion",
            inputJson: JSON.stringify({ question: "Is this plan sound?" }),
            signal,
          }),
        ).toMatchObject({
          isError: false,
          result: { answer: "advice on Is this plan sound?" },
        });
        expect(asked).toEqual([expect.objectContaining({ mode })]);
      },
    );

    it("refuses a second opinion once the thread has taken in outside content", async () => {
      const { composition, asked } = harness(true);
      const tools = composition.forChat({ thread: chatThread, windowId: "window-1" });
      expect(
        await tools?.execute({
          name: "second-opinion",
          inputJson: JSON.stringify({ question: "Is this plan sound?" }),
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ isError: true, result: { error: "second-opinion-tainted" } });
      expect(asked).toEqual([]);
    });
  });

  describe("a Code turn narrowed to Plan on a thread stored with wider access", () => {
    const providerInstanceId = "00000000-0000-4000-8000-0000000000e3";
    const projectId = "00000000-0000-4000-8000-0000000000b4";
    const revisionId = "00000000-0000-4000-8000-0000000000c4";
    const storedThread = (executionPolicy: ProviderExecutionPolicy) =>
      ({
        id: "00000000-0000-4000-8000-000000000041",
        lifecycle: "active",
        projectId,
        providerInstanceId,
        modelId: "harness-model",
        bindingRevisionId: revisionId,
        checkoutId: "00000000-0000-4000-8000-0000000000d4",
        executionPolicy,
      }) as unknown as CodeThread;
    // The real authority reads the stored thread, as the host does; `turn` is the posture the
    // running turn holds, which the host reads separately and may have moved since the tools
    // were composed.
    const harness = (
      stored: ProviderExecutionPolicy,
      turn: { current?: ProviderExecutionPolicy },
      composedAs: ProviderExecutionPolicy = stored,
    ) => {
      const composition = createNativeHarnessComposition({
        isChildAuthorityCurrent: () => true,
        authority: createNativeHarnessAuthority({
          hostId: "00000000-0000-4000-8000-0000000000aa" as never,
          persistence: {
            readChatThread: () => undefined,
            readProject: () =>
              ({
                type: "code",
                lifecycle: "active",
                bindingHistory: [{ revisionId }],
              }) as never,
            readCodeThread: () => storedThread(stored) as never,
            readProviderInstance: () => ({ enabled: true }) as never,
          },
          workThreads: { read: () => undefined },
          readThreadTaint: () => ({ externalContentIngested: false }) as never,
        }),
        isHarnessProvider: () => true,
        shell: { run: async () => ({ status: "ran", exitCode: 0, output: "", truncated: false }) },
        readCodeExecutionPolicy: () => turn.current,
        hostId: "00000000-0000-4000-8000-0000000000aa" as never,
        readThreadTaint: () => false,
        recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
        uuid: () => "00000000-0000-4000-8000-000000000099",
        clock: () => "2026-10-17T00:00:00.000Z",
      });
      return composition.forCode({
        thread: storedThread(composedAs),
        checkoutRoot: "/nonexistent",
        windowId: "window-1",
      })!;
    };
    const writes = [
      ["write", { path: "a.ts", content: "x" }],
      ["edit", { path: "a.ts", oldText: "a", newText: "b" }],
      ["bash", { command: "echo hi" }],
    ] as const;
    const run = (tools: ReturnType<typeof harness>, name: string, input: unknown) =>
      tools.execute({
        name,
        inputJson: JSON.stringify(input),
        signal: new AbortController().signal,
      });

    it.each(["approval-gated", "auto-accept-edits", "full-access"] as const)(
      "offers no write, edit or command to a turn that starts in Plan on a %s thread, and refuses a call anyway",
      async (stored) => {
        const tools = harness(stored, { current: "plan" });
        expect(tools.definitions.map((definition) => definition.name)).toEqual([
          "read",
          "grep",
          "glob",
        ]);
        for (const [name, input] of writes) {
          expect(await run(tools, name, input)).toMatchObject({ isError: true });
        }
      },
    );

    it.each(["approval-gated", "auto-accept-edits", "full-access"] as const)(
      "refuses a write, an edit and a command by policy when the turn narrows to Plan after the tools were composed on a %s thread",
      async (stored) => {
        const turn: { current?: ProviderExecutionPolicy } = {};
        const tools = harness(stored, turn);
        for (const [name] of writes) {
          expect(tools.definitions.map((definition) => definition.name)).toContain(name);
        }
        turn.current = "plan";
        for (const [name, input] of writes) {
          expect(await run(tools, name, input)).toMatchObject({
            isError: true,
            result: { error: "plan-mode-denied" },
          });
        }
      },
    );

    it("refuses by policy when the stored posture moved to Plan after the tools were composed, whatever the turn reads", async () => {
      const tools = harness("plan", { current: "full-access" }, "approval-gated");
      expect(await run(tools, "write", { path: "a.ts", content: "x" })).toMatchObject({
        isError: true,
        result: { error: "plan-mode-denied" },
      });
    });

    it("leaves a turn that is not narrowed to the thread's own posture", async () => {
      const tools = harness("approval-gated", {});
      expect(await run(tools, "write", { path: "a.ts", content: "x" })).toMatchObject({
        isError: true,
        result: { error: "approval-required" },
      });
    });
  });
});
