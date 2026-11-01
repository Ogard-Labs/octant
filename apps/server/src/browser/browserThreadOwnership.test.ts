import type {
  BrowserContextId,
  BrowserThreadId,
  ToolActionAuthority,
  WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBrowserAppManagedTools } from "./browserAppManagedTools";
import { BrowserAutomationService } from "./browserAutomationService";
import type { BrowserRuntimePort } from "./browserRuntimePort";

/**
 * Two threads of one Project hold the same authority, so a page can only be
 * kept apart by the thread that owns it. These tests drive the real service
 * and the real agent tool against a runtime that records which browsing context
 * every effect reached.
 */

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const threadA = "20000000-0000-4000-8000-00000000000a" as BrowserThreadId;
const threadB = "20000000-0000-4000-8000-00000000000b" as BrowserThreadId;
const subagent = "20000000-0000-4000-8000-00000000000c" as BrowserThreadId;
const terminalThread = "20000000-0000-4000-8000-00000000000d" as BrowserThreadId;
const authority: ToolActionAuthority = {
  hostId: "40000000-0000-4000-8000-000000000001" as never,
  mode: "work",
  projectId: "50000000-0000-4000-8000-000000000001" as never,
  rootId: "60000000-0000-4000-8000-000000000001" as never,
  providerInstanceId: "70000000-0000-4000-8000-000000000001" as never,
  extension: { kind: "core" },
};

function harness() {
  const reached: Array<{
    readonly contextId: string;
    readonly kind: string;
    readonly tab?: string;
  }> = [];
  const owners = new Map<string, string>();
  const tabsOf = new Map<string, string[]>();
  const runtime: BrowserRuntimePort = {
    available: vi.fn(async () => true),
    nativeAvailable: vi.fn(async () => true),
    createContext: vi.fn(async (contextId, _policy, _signal, owner) => {
      owners.set(String(contextId), String(owner?.threadId));
      tabsOf.set(String(contextId), [`${String(contextId)}:1`, `${String(contextId)}:2`]);
    }),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    act: vi.fn(async (contextId, input) => {
      reached.push({
        contextId: String(contextId),
        kind: input.kind,
        ...(input.tabId === undefined ? {} : { tab: input.tabId }),
      });
      const owner = owners.get(String(contextId));
      return {
        url: `https://${owner}.example/`,
        title: `Page of ${owner}`,
        contentHash: "h",
        tabs: (tabsOf.get(String(contextId)) ?? []).map((tabId, index) => ({
          tabId,
          url: `https://${owner}.example/${String(index)}`,
          title: `Tab of ${owner}`,
          active: index === 0,
        })),
      };
    }),
    closeContext: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  };
  let counter = 0;
  let now = Date.parse("2026-11-01T10:00:00.000Z");
  const service = new BrowserAutomationService({
    runtime,
    authority: { canAccessWindow: () => true, resolve: () => authority },
    uuid: () => {
      counter += 1;
      return `30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
    clock: () => new Date().toISOString(),
    now: () => now,
  });
  const toolsFor = (
    threadId: BrowserThreadId,
    options: {
      readonly terminal?: boolean;
      readonly unattended?: boolean;
    } = {},
  ) =>
    createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "work",
      modelId: "model",
      resolveModelId: () => "model",
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      ...(options.terminal === true ? { profileCaller: "terminal-grant" as const } : {}),
      browser: {
        inspectThread: (window, thread) => service.inspectThread(window, thread),
        create: (input) => service.create(input),
        act: (input) => service.act(input),
        releaseThread: (window, thread) => service.releaseThread(window, thread),
      },
      approvals: {
        request: async () => "approved",
        isUnattendedScope: () => options.unattended === true,
      },
      uuid: () => {
        counter += 1;
        return `80000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      },
    });
  const run = async (
    tools: ReturnType<typeof toolsFor>,
    input: Record<string, unknown>,
  ): Promise<{ readonly result: unknown; readonly isError?: boolean }> =>
    (await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify(input),
    })) as { readonly result: unknown; readonly isError?: boolean };
  const contextOf = (threadId: BrowserThreadId): BrowserContextId => {
    const context = service.inspectThread(windowId, threadId).context;
    if (context === undefined) throw new Error("No page.");
    return context.contextId;
  };
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    contextOf,
    reached,
    run,
    runtime,
    service,
    toolsFor,
  };
}

async function openPages(h: ReturnType<typeof harness>) {
  const a = h.toolsFor(threadA);
  await h.run(a, { operation: "navigate", url: "https://a.example/" });
  return { a };
}

describe("a thread's Browser page belongs to that thread alone", () => {
  it("keeps a second thread's agent on its own page and tabs, whatever tab id it guesses", async () => {
    const h = harness();
    const { a } = await openPages(h);
    const pageA = String(h.contextOf(threadA));
    const b = h.toolsFor(threadB);

    // Before B has a page, nothing it asks reaches A's page.
    for (const input of [
      { operation: "tab-list" },
      { operation: "tab-switch", tabId: "t2" },
      { operation: "tab-close", tabId: "t2" },
      { operation: "snapshot" },
      { operation: "read-page" },
    ]) {
      const refused = await h.run(b, input);
      expect(refused.isError, JSON.stringify(input)).toBe(true);
    }
    expect(h.reached.filter((effect) => effect.contextId === pageA)).toHaveLength(1);

    await h.run(b, { operation: "navigate", url: "https://b.example/" });
    const pageB = String(h.contextOf(threadB));
    expect(pageB).not.toBe(pageA);
    h.reached.length = 0;

    const listed = await h.run(b, { operation: "tab-list" });
    expect(JSON.stringify(listed.result)).toContain(threadB.slice(-1));
    expect(JSON.stringify(listed.result)).not.toContain(`${threadA}.example`);
    await h.run(b, { operation: "tab-switch", tabId: "t2" });
    // A tab id of the first thread's context is no tab of this one.
    await h.run(b, { operation: "tab-switch", tabId: `${pageA}:2` });
    await h.run(b, { operation: "tab-close", tabId: `${pageA}:2` });
    await h.run(b, { operation: "snapshot" });

    expect(h.reached.length).toBeGreaterThan(0);
    expect(h.reached.every((effect) => effect.contextId === pageB)).toBe(true);

    // The first thread's page still answers as its own.
    h.reached.length = 0;
    await h.run(a, { operation: "tab-list" });
    expect(h.reached.map((effect) => effect.contextId)).toEqual([pageA]);
  });

  it("keeps a subagent and another thread's terminal grant off the first thread's page", async () => {
    const h = harness();
    const { a } = await openPages(h);
    void a;
    const pageA = String(h.contextOf(threadA));
    h.reached.length = 0;

    const sub = h.toolsFor(subagent, { unattended: true });
    const terminal = h.toolsFor(terminalThread, { terminal: true });
    for (const tools of [sub, terminal]) {
      for (const input of [
        { operation: "tab-list" },
        { operation: "tab-switch", tabId: "t2" },
        { operation: "tab-switch", tabId: `${pageA}:2` },
        { operation: "snapshot" },
        { operation: "click", selector: "#go" },
      ]) {
        const refused = await h.run(tools, input);
        expect(refused.isError, JSON.stringify(input)).toBe(true);
      }
      // Stopping ends the caller's own Browser, which it has none of.
      await h.run(tools, { operation: "stop" });
    }
    expect(h.reached).toEqual([]);
    // Stopping from another thread closed nothing of the first thread's.
    expect(h.runtime.closeContext).not.toHaveBeenCalled();
    expect(h.service.inspectThread(windowId, threadA).context?.state).toBe("active");
  });

  it("refuses an action that names another thread's context, even with its ids and authority", async () => {
    const h = harness();
    await openPages(h);
    const snapshotA = h.service.inspectThread(windowId, threadA);
    const context = snapshotA.context;
    if (context === undefined) throw new Error("No page.");
    h.reached.length = 0;

    const stolen = {
      actionId: context.actionId,
      correlationId: context.correlationId,
      authority: context.authority,
      contextId: context.contextId,
    };
    for (const kind of ["tab-list", "tab-select", "tab-close", "snapshot"] as const) {
      const denied = await h.service.act({
        windowId,
        threadId: threadB,
        request: {
          ...stolen,
          kind,
          ...(kind.startsWith("tab-") ? { tabId: "t2" as never } : {}),
        },
        capturedBy: "agent",
      });
      expect(denied.failure?.category, kind).toBe("unauthorized");
      expect(denied.context).toBeUndefined();
      expect(denied.observation).toBeUndefined();
    }
    expect(h.reached).toEqual([]);

    // The owning thread, naming itself, is admitted.
    const allowed = await h.service.act({
      windowId,
      threadId: threadA,
      request: { ...stolen, kind: "tab-list" },
      capturedBy: "agent",
    });
    expect(allowed.failure).toBeUndefined();
    expect(h.reached.map((effect) => effect.contextId)).toEqual([String(context.contextId)]);
  });

  it("does not let another thread inspect, stop, or release the first thread's page", async () => {
    const h = harness();
    await openPages(h);
    const pageA = h.contextOf(threadA);

    expect(h.service.inspect(windowId, threadB, pageA).failure?.category).toBe("unauthorized");
    expect((await h.service.stop(windowId, threadB, pageA)).failure?.category).toBe("unauthorized");
    expect(h.service.inspectThread(windowId, threadB).context).toBeUndefined();
    await h.service.releaseThread(windowId, threadB);
    expect(h.service.inspectThread(windowId, threadA).context?.state).toBe("active");
  });
});

describe("the Project's list of live agent pages", () => {
  const titles = new Map<string, string>([
    [threadA, "Research pricing"],
    [threadB, "Fix the signup form"],
  ]);
  const list = (
    h: ReturnType<typeof harness>,
    options: { readonly remote?: boolean; readonly window?: WindowId } = {},
  ) =>
    h.service.listProjectAgentPages({
      windowId: options.window ?? windowId,
      projectId: String(authority.projectId),
      mode: "work",
      threadTitle: (threadId) => titles.get(String(threadId)),
      remote: options.remote === true,
    });

  it("names each thread's page by title and host, with the thread that owns it", async () => {
    const h = harness();
    await h.run(h.toolsFor(threadA), {
      operation: "navigate",
      url: "https://a.example/start?token=s3cret",
    });
    await h.run(h.toolsFor(threadB), {
      operation: "navigate",
      url: "https://b.example/",
    });

    const pages = list(h);
    expect(pages.map((page) => page.threadTitle).sort()).toEqual([
      "Fix the signup form",
      "Research pricing",
    ]);
    const first = pages.find((page) => String(page.threadId) === threadA);
    expect(first).toMatchObject({
      contextId: h.contextOf(threadA),
      title: `Page of ${threadA}`,
      host: `${threadA}.example`,
    });
    // Nothing but names: no text, no picture, no address past the host.
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ["agentActive", "contextId", "host", "threadId", "threadTitle", "title"].sort(),
    );
    expect(JSON.stringify(pages)).not.toContain("s3cret");
  });

  it("marks a page as driven while its agent acts and for a moment after", async () => {
    const h = harness();
    const a = h.toolsFor(threadA);
    await h.run(a, { operation: "navigate", url: "https://a.example/" });
    expect(list(h)[0]?.agentActive).toBe(true);
    h.advance(60_000);
    expect(list(h)[0]?.agentActive).toBe(false);
    await h.run(a, { operation: "tab-list" });
    expect(list(h)[0]?.agentActive).toBe(true);
  });

  it("lists nothing of another window, another Project, a hidden thread, or a dedicated page", async () => {
    const h = harness();
    await h.run(h.toolsFor(threadA), {
      operation: "navigate",
      url: "https://a.example/",
    });
    await h.run(h.toolsFor(threadB), {
      operation: "navigate",
      url: "https://b.example/",
    });
    await h.run(h.toolsFor(subagent), {
      operation: "navigate",
      url: "https://s.example/",
    });

    // A thread the caller cannot name is left out whole.
    expect(
      list(h)
        .map((page) => String(page.threadId))
        .sort(),
    ).toEqual([threadA, threadB]);
    expect(list(h, { window: "10000000-0000-4000-8000-0000000000ff" as WindowId })).toEqual([]);
    expect(
      h.service.listProjectAgentPages({
        windowId,
        projectId: "50000000-0000-4000-8000-0000000000ff",
        mode: "work",
        threadTitle: () => "Any",
        remote: false,
      }),
    ).toEqual([]);
    expect(
      h.service.listProjectAgentPages({
        windowId,
        projectId: String(authority.projectId),
        mode: "code",
        threadTitle: () => "Any",
        remote: false,
      }),
    ).toEqual([]);

    await h.service.create({
      windowId,
      threadId: threadA,
      dedicated: true,
      action: {
        actionId: "81000000-0000-4000-8000-000000000001" as never,
        correlationId: "82000000-0000-4000-8000-000000000001" as never,
        capability: { id: "browser-automation" as never, version: 1 },
        authority,
        intent: "Open a page of its own.",
        approval: { kind: "not-required" },
      },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://d.example"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    expect(list(h)).toHaveLength(2);
  });

  it("describes a signed-in page to a paired device by its existence alone", async () => {
    const h = harness();
    await h.service.create({
      windowId,
      threadId: threadA,
      action: {
        actionId: "83000000-0000-4000-8000-000000000001" as never,
        correlationId: "84000000-0000-4000-8000-000000000001" as never,
        capability: { id: "browser-automation" as never, version: 1 },
        authority,
        intent: "Open a signed-in page.",
        approval: { kind: "not-required" },
      },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://a.example"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
        profile: { kind: "personal" },
      },
    });
    await h.run(h.toolsFor(threadB), {
      operation: "navigate",
      url: "https://b.example/",
    });

    const remote = list(h, { remote: true });
    const signedIn = remote.find((page) => String(page.threadId) === threadA);
    expect(signedIn).toMatchObject({
      signedIn: true,
      threadTitle: "Research pricing",
    });
    expect(signedIn?.title).toBeUndefined();
    expect(signedIn?.host).toBeUndefined();
    expect(remote.find((page) => String(page.threadId) === threadB)?.title).toBeDefined();
    // The person at this Mac sees the same page described.
    expect(list(h).find((page) => String(page.threadId) === threadA)?.signedIn).toBeUndefined();
  });
});
