import {
  decodeProject,
  decodeProjectId,
  decodeWindowId,
  type BrowserContextId,
  type BrowserContextPolicy,
  type BrowserThreadId,
  type Project,
  type ProjectBrowserResult,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { BrowserAutomationService } from "./browserAutomationService";
import type { BrowserRuntimeAction, BrowserRuntimePort } from "./browserRuntimePort";
import { ProjectBrowserService, projectBrowserSubjectId } from "./projectBrowserService";

const now = "2026-09-25T10:00:00.000Z";
const ids = {
  actor: "a0000000-0000-4000-8000-000000000001",
  project: "a0000000-0000-4000-8000-000000000002",
  chat: "a0000000-0000-4000-8000-000000000003",
  revision: "a0000000-0000-4000-8000-000000000004",
  relinked: "a0000000-0000-4000-8000-000000000005",
  window: "a0000000-0000-4000-8000-000000000006",
  otherWindow: "a0000000-0000-4000-8000-000000000007",
} as const;
const projectId = decodeProjectId(ids.project);
const windowId = decodeWindowId(ids.window);
const otherWindowId = decodeWindowId(ids.otherWindow);

function project(
  overrides: {
    readonly id?: string;
    readonly type?: "code" | "work" | "chat";
    readonly lifecycle?: "active" | "archived";
    readonly revisionId?: string;
  } = {},
): Project {
  const type = overrides.type ?? "work";
  const actor = { kind: "local-user", actorId: ids.actor } as const;
  return decodeProject({
    id: overrides.id ?? ids.project,
    name: "Research",
    lifecycle: overrides.lifecycle ?? "active",
    pinned: false,
    rank: "1/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    type,
    ...(type === "chat"
      ? {}
      : {
          binding: { canonicalRoot: "/Users/person/research" },
          bindingHistory: [
            {
              revisionId: overrides.revisionId ?? ids.revision,
              revision: 1,
              currentBinding: { canonicalRoot: "/Users/person/research" },
              actor,
              changedAt: now,
            },
          ],
        }),
    ...(type === "code" ? { codeAccessPersistence: "current-session" } : {}),
  });
}

/** A browser runtime stand-in that records every page it was asked to open. */
class FakeRuntime {
  readonly created: Array<{
    readonly contextId: BrowserContextId;
    readonly policy: BrowserContextPolicy;
    readonly owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId };
  }> = [];
  readonly actions: Array<{
    readonly contextId: BrowserContextId;
    readonly action: BrowserRuntimeAction;
  }> = [];
  readonly closed: BrowserContextId[] = [];
  peeks = 0;
  presentation: "native-live" | "headless" = "headless";

  readonly available = async () => true;
  readonly createContext: BrowserRuntimePort["createContext"] = async (
    contextId,
    policy,
    _signal,
    owner,
  ) => {
    this.created.push({ contextId, policy, owner });
    return this.presentation;
  };
  readonly act: BrowserRuntimePort["act"] = async (contextId, action) => {
    this.actions.push({ contextId, action });
    return { url: action.target ?? "", title: "Page" };
  };
  readonly peek: NonNullable<BrowserRuntimePort["peek"]> = async () => {
    this.peeks += 1;
    return {
      url: "https://example.com/later",
      title: "Later",
      screenshotDataUrl: "data:image/png;base64,AAAA",
    };
  };
  readonly closeContext: BrowserRuntimePort["closeContext"] = async (contextId) => {
    this.closed.push(contextId);
  };
}

function harness(
  options: {
    readonly projects?: Map<string, Project>;
    readonly access?: (window: string, project: string, mode: string) => boolean;
  } = {},
) {
  const projects = options.projects ?? new Map([[ids.project, project()]]);
  const runtime = new FakeRuntime();
  let clock = Date.parse(now);
  let sequence = 0;
  const service = new ProjectBrowserService({
    runtime,
    readProject: (id) => projects.get(String(id)),
    canAccessProject: (window, id, mode) =>
      options.access?.(String(window), String(id), mode) ??
      (String(window) === ids.window && String(id) === ids.project),
    uuid: () => `b0000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => clock,
    schedule: () => () => undefined,
  });
  return {
    service,
    runtime,
    projects,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function refusal(result: ProjectBrowserResult) {
  return result.kind === "project-browser-refused" ? result.reason : undefined;
}

const open = (url = "https://example.com/start") => ({ kind: "open", projectId, url }) as const;

describe("Project browsers", () => {
  it("opens the person's page in an isolated context owned by the Project, never by a thread", async () => {
    const { service, runtime } = harness();

    const result = await service.execute(windowId, "local-window", open());

    const subjectId = projectBrowserSubjectId(projectId);
    expect(String(subjectId)).not.toBe(ids.project);
    expect(result).toMatchObject({
      kind: "project-browser",
      browser: { projectId: ids.project, mode: "work", subjectId, context: { state: "active" } },
    });
    expect(runtime.created).toEqual([
      expect.objectContaining({
        owner: { windowId, threadId: subjectId },
        policy: expect.objectContaining({
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
        }),
      }),
    ]);
    expect(runtime.actions).toEqual([
      expect.objectContaining({
        action: { kind: "navigate", target: "https://example.com/start" },
      }),
    ]);
  });

  it("refuses a paired device outright and opens nothing", async () => {
    const { service, runtime } = harness();

    expect(refusal(await service.execute(windowId, "remote-device", open()))).toBe("unauthorized");
    expect(runtime.created).toEqual([]);
  });

  it("gives a Chat Project no browser and refuses a window that does not hold the Project", async () => {
    const projects = new Map([
      [ids.project, project()],
      [ids.chat, project({ id: ids.chat, type: "chat" })],
    ]);
    const { service, runtime } = harness({ projects, access: () => true });
    const chat = await service.execute(windowId, "local-window", {
      kind: "open",
      projectId: decodeProjectId(ids.chat),
      url: "https://example.com",
    });
    expect(refusal(chat)).toBe("unavailable");

    const guarded = harness();
    expect(refusal(await guarded.service.execute(otherWindowId, "local-window", open()))).toBe(
      "unauthorized",
    );
    expect(runtime.created).toEqual([]);
    expect(guarded.runtime.created).toEqual([]);
  });

  it("opens only web addresses", async () => {
    const { service, runtime } = harness();

    const result = await service.execute(windowId, "local-window", open("file:///etc/passwd"));

    expect(refusal(result)).toBe("invalid");
    expect(runtime.created).toEqual([]);
  });

  it("keeps one page per site and starts a fresh isolated context for another site", async () => {
    const { service, runtime } = harness();
    await service.execute(windowId, "local-window", open("https://example.com/a"));
    await service.execute(windowId, "local-window", open("https://example.com/b"));
    expect(runtime.created).toHaveLength(1);

    await service.execute(windowId, "local-window", open("https://other.example/"));

    expect(runtime.created).toHaveLength(2);
    expect(runtime.closed).toEqual([runtime.created[0]?.contextId]);
    expect(runtime.created[1]?.policy.allowedOrigins).toEqual(["https://other.example"]);
  });

  it("pictures a headless page no more often than the interval, and a native page not at all", async () => {
    const { service, runtime, advance } = harness();
    await service.execute(windowId, "local-window", open());
    advance(2_000);

    const first = await service.execute(windowId, "local-window", { kind: "current", projectId });
    await service.execute(windowId, "local-window", { kind: "current", projectId });

    expect(runtime.peeks).toBe(1);
    expect(first).toMatchObject({ browser: { page: { title: "Later" } } });

    const native = harness();
    native.runtime.presentation = "native-live";
    await native.service.execute(windowId, "local-window", open());
    native.advance(2_000);
    await native.service.execute(windowId, "local-window", { kind: "current", projectId });
    expect(native.runtime.peeks).toBe(0);
  });

  it("closes the page when its Project is archived or relinked, and keeps it otherwise", async () => {
    const { service, runtime, projects } = harness();
    await service.execute(windowId, "local-window", open());

    await service.settleProject(projectId);
    expect(runtime.closed).toEqual([]);

    projects.set(ids.project, project({ revisionId: ids.relinked }));
    await service.settleProject(projectId);
    expect(runtime.closed).toHaveLength(1);

    await service.execute(windowId, "local-window", open());
    projects.set(ids.project, project({ revisionId: ids.relinked, lifecycle: "archived" }));
    const current = await service.execute(windowId, "local-window", { kind: "current", projectId });
    expect(refusal(current)).toBe("authority-revoked");
    expect(runtime.closed).toHaveLength(2);
  });

  it("closes a window's pages when the window's authority ends", async () => {
    const { service, runtime } = harness();
    await service.execute(windowId, "local-window", open());

    await service.revokeWindow(windowId);

    expect(runtime.closed).toHaveLength(1);
    const current = await service.execute(windowId, "local-window", { kind: "current", projectId });
    expect(current).toMatchObject({ kind: "project-browser", browser: { projectId: ids.project } });
    expect(
      current.kind === "project-browser" ? current.browser.context : "refused",
    ).toBeUndefined();
  });

  it("is unreachable from the agent's browser tools", async () => {
    const { service, runtime } = harness();
    const opened = await service.execute(windowId, "local-window", open());
    const contextId =
      opened.kind === "project-browser" ? opened.browser.context?.contextId : undefined;
    if (contextId === undefined) throw new Error("the Project page did not open");
    const agentBrowser = new BrowserAutomationService({
      runtime: runtime as unknown as BrowserRuntimePort,
      authority: { resolve: () => undefined, canAccessWindow: () => false },
      uuid: () => "c0000000-0000-4000-8000-000000000001",
      clock: () => now,
      now: () => Date.parse(now),
    });

    await expect(
      agentBrowser.act({
        windowId,
        request: {
          actionId: "c0000000-0000-4000-8000-000000000002" as never,
          correlationId: "c0000000-0000-4000-8000-000000000003" as never,
          contextId,
          authority: {} as never,
          kind: "extract-text",
        },
      }),
    ).rejects.toThrow(/stale or unknown/);
    expect(runtime.actions).toHaveLength(1);
  });
});
